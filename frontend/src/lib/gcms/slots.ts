// Spectrum-slot resolution for the GC/MS bottom panel (Phase 4 task A).
//
// Three pure passes, kept separate so each is independently testable and so
// the ORDER between them (resolve -> subtract -> assemble) is explicit:
//   1. resolveSlots            — SpectrumSlot[]  -> ResolvedSlot[]   (one
//      resolved spectrum per slot that CAN resolve; a slot that can't
//      resolve — no run, no scans, an empty region — is omitted).
//   2. applyBackgroundSubtraction — ResolvedSlot[] -> ResolvedSlot[] (replaces
//      every non-background entry's spectrum with itself minus every
//      background-mode entry's spectrum).
//   3. assemblePanels          — ResolvedSlot[]  -> AssembledPanel[] (groups
//      "overlay" entries into the panel of the preceding "stack"/"background"
//      entry).
//
// None of these touch React state or the DOM; `pages/Gcms.tsx` drives them
// from memos and owns the `SpectrumSlot[]` state itself.

import { combineScans, nearestScanIndex, scanSpectrum, subtractBackground, sumSpectra } from "./chrom";
import type { MassSpectrum, MsRun, SpectrumSlot } from "./types";

export interface ResolvedSlot {
  slot: SpectrumSlot;
  spectrum: MassSpectrum;
}

/**
 * Resolve every slot's SOURCE into a MassSpectrum, independent of `mode`.
 * Reuses `scanSpectrum` / `nearestScanIndex` / `combineScans` exactly the way
 * the pre-Phase-4 single `spectra` memo did — this function only adds the
 * bookkeeping to do it per-slot instead of once.
 */
export function resolveSlots(
  slots: SpectrumSlot[],
  run: MsRun | null,
  cursorRt: number | null,
): ResolvedSlot[] {
  if (!run) return [];
  const out: ResolvedSlot[] = [];
  for (const slot of slots) {
    const { source } = slot;

    if (source.kind === "cursor") {
      if (run.scanCount === 0 || cursorRt == null) continue;
      const idx = nearestScanIndex(run, cursorRt);
      if (idx < 0) continue;
      out.push({ slot, spectrum: scanSpectrum(run, idx) });
      continue;
    }

    if (source.kind === "scan") {
      if (run.scanCount === 0) continue;
      const idx = nearestScanIndex(run, source.rt);
      if (idx < 0) continue;
      out.push({ slot, spectrum: scanSpectrum(run, idx) });
      continue;
    }

    // "range": combine each region independently (identical to the old
    // selection -> combineScans path), then sum the per-region spectra into
    // one — multi-region select (task D) is "one or more RT windows, summed".
    if (source.regions.length === 0) continue;
    const perRegion = source.regions.map(([a, b]) =>
      combineScans(run, Math.min(a, b), Math.max(a, b), "sum"),
    );
    if (perRegion.every((s) => s.scanCount === 0)) continue;
    const summed = sumSpectra(perRegion, 0.02);
    const label =
      source.regions.length === 1
        ? summed.label
        : `MS + spectrum ${source.regions
            .map(([a, b]) => `${Math.min(a, b).toFixed(2)}..${Math.max(a, b).toFixed(2)}`)
            .join(", ")}`;
    out.push({ slot, spectrum: { ...summed, label } });
  }
  return out;
}

/**
 * Background subtraction: resolve EVERY slot's raw spectrum first (the
 * `resolveSlots` pass above), THEN subtract every background-mode slot's
 * spectrum from every OTHER (non-background) slot's spectrum. This ordering
 * — resolve everything, only then subtract — matters: a background slot
 * always shows its own RAW spectrum (never has another background subtracted
 * from it), so the user can see exactly what they're subtracting, and
 * toggling that slot's mode back to "stack" turns the subtraction off without
 * losing it. Multiple simultaneous background slots subtract sequentially.
 */
export function applyBackgroundSubtraction(resolved: ResolvedSlot[]): ResolvedSlot[] {
  const backgrounds = resolved.filter((r) => r.slot.mode === "background").map((r) => r.spectrum);
  if (backgrounds.length === 0) return resolved;
  return resolved.map((r) => {
    if (r.slot.mode === "background") return r;
    let spec = r.spectrum;
    for (const bg of backgrounds) spec = subtractBackground(spec, bg, 0.02);
    return { slot: r.slot, spectrum: spec };
  });
}

export interface AssembledPanel {
  slot: SpectrumSlot;
  entries: ResolvedSlot[];
}

/**
 * Group resolved slots into rendered panels: "stack" and "background" slots
 * each start a new panel; "overlay" slots fold into the panel of the
 * PRECEDING stack/background slot (array order = the order slots were
 * created in). An "overlay" slot with nothing preceding it falls back to its
 * own panel instead of being silently dropped (shouldn't normally happen —
 * slot 0, "live", is always stack-mode).
 */
export function assemblePanels(resolved: ResolvedSlot[]): AssembledPanel[] {
  const panels: AssembledPanel[] = [];
  for (const r of resolved) {
    if (r.slot.mode === "overlay" && panels.length > 0) {
      panels[panels.length - 1].entries.push(r);
      continue;
    }
    panels.push({ slot: r.slot, entries: [r] });
  }
  return panels;
}
