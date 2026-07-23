import { useMemo } from "react";
import type { MutableRefObject } from "react";
import type { LabelInput } from "@/lib/gcms/annotate";
import type { MassSpectrum, SpecPeak } from "@/lib/gcms/types";
import { GcmsPlot, type PanelTrace, type PlotMarker } from "./GcmsPlot";

/** Resolve the app's --primary design token for fallback trace colours. */
function primaryToken(): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
  if (!raw) return "hsl(190 90% 38%)";
  return raw.startsWith("hsl") ? raw : `hsl(${raw})`;
}

export interface SpectrumPanelProps {
  /** index 0 is this panel's OWN spectrum (its slot); any further entries are
   *  spectra overlaid onto it (Phase 4 task A "overlay" slots, and the
   *  pre-existing "lock spectra to cursor" cross-document overlay). */
  spectra: MassSpectrum[];
  /** Parallel to `spectra` — a STABLE id per entry (the owning slot's id, or
   *  a document id for a locked-cursor overlay). Phase 4 task C fix #1: this
   *  is keyed off the SLOT, not the RT window, specifically so `GcmsPlot`'s
   *  `traceIdsKey` (and therefore its rebuild) does not change on every scan
   *  — only when the set of SLOTS changes. */
  ids: string[];
  /** Parallel to `spectra` — the per-entry swatch colour. */
  colors: string[];
  peaks: SpecPeak[];
  /** Per-colour m/z labels for overlaid spectra (lock-to-cursor cross-document
   *  overlays). Each entry's `peaks` get m/z labels drawn in its own `color`,
   *  feeding through the same `annotations`/`markersFromLabels` path as the
   *  primary `peaks` so round-1's leader-cap + reveal-on-zoom logic applies
   *  uniformly. The total label count is capped inside `SpectrumPanel`. */
  overlayPeaks?: { peaks: SpecPeak[]; color: string }[];
  title: string;
  normalize: boolean;
  stacked: boolean;
  logY: boolean;
  /** Phase 4 task C fix #2: a fixed x-domain (the run's `mzRange`) so the
   *  panel's zoom survives a scan change — see `GcmsPlot`'s `xDomain` prop. */
  xDomain?: [number, number];
  captureRef?: MutableRefObject<((scale?: number) => string | null) | null>;
  /** Overrides GcmsPlot's default 220px minHeight — used when this panel is
   *  one of several stacked panels (SpectrumStack) so a short flex slot
   *  doesn't force overflow. Omit to keep GcmsPlot's default. */
  minHeight?: number;
}

/**
 * Thin adapter that maps {@link MassSpectrum}s to {@link PanelTrace}s in stick
 * mode and {@link SpecPeak}s to two-line m/z + rel% labels, then renders a
 * single {@link GcmsPlot}. Click-to-XIC on the spectrum was removed (Phase 1)
 * — a zoom-drag's release fired it unintentionally; XIC building now happens
 * only via the checkbox + "XIC selected" button in {@link SpectrumPeakTable}.
 * `onClick` is passed a no-op.
 */
export function SpectrumPanel(props: SpectrumPanelProps): JSX.Element {
  const {
    spectra,
    ids,
    colors,
    peaks,
    overlayPeaks,
    title,
    normalize,
    stacked,
    logY,
    xDomain,
    captureRef,
    minHeight,
  } = props;

  // Map MassSpectrum[] -> PanelTrace[]. Index 0 (this panel's own spectrum)
  // draws thicker/emphasised; any further (overlay) entries draw thinner.
  // Order is the CALLER's order — nothing here re-sorts by run/active-ness —
  // so `ids[i]` stays paired with `spectra[i]` and both stay stable across a
  // scan change (the id no longer embeds the RT window; see the prop doc).
  const spectrumMetrics = useMemo(() => {
    let stackTop = 0;
    return spectra.map((s) => {
      let max = 0;
      for (const value of s.intensity) {
        if (Number.isFinite(value) && value > max) max = value;
      }
      const normScale = normalize && max > 0 ? 100 / max : 1;
      const baseline = stacked ? stackTop : 0;
      if (stacked) stackTop += max * normScale;
      return { normScale, baseline };
    });
  }, [spectra, normalize, stacked]);

  const panelTraces = useMemo<PanelTrace[]>(() => {
    return spectra.map((s, i) => ({
      id: ids[i] ?? `spec-${i}`,
      label: s.label,
      x: s.mz,
      y: s.intensity,
      color: colors[i] ?? primaryToken(),
      visible: true,
      offset: 0,
      baseline: spectrumMetrics[i]?.baseline ?? 0,
      width: i === 0 ? 1.4 : 0.9,
    }));
  }, [spectra, ids, colors, spectrumMetrics]);

  const activeTraceId = panelTraces.length > 0 ? panelTraces[0].id : null;

  // When `normalize` is on, GcmsPlot's buildData divides each visible column
  // by its OWN max so the tallest peak lands at 100. The primary `peaks` carry
  // RAW intensities, so their annotation y/priority must be scaled by the same
  // factor (100 / primary-spectrum-max) or the labels anchor off-screen above
  // the plot. Overlay peaks are already in the 0-100 range (their spectra were
  // normalized at the host), so they need no extra scaling here.
  const primaryNormScale = spectrumMetrics[0]?.normScale ?? 1;
  const primaryBaseline = spectrumMetrics[0]?.baseline ?? 0;

  // SpecPeak markers: kept only as the fallback data source for
  // `markersFromLabels` — GcmsPlot derives the actually-drawn apex triangles
  // from the labels it placed (see `markersFromLabels` below), so this list
  // is never itself iterated when there are 200 peaks to triangle-spam.
  const markers = useMemo<PlotMarker[]>(() => {
    const color = colors[0] || primaryToken();
    return peaks.map((p) => ({
      x: p.mz,
      y: p.intensity * primaryNormScale + primaryBaseline,
      kind: "apex",
      color,
    }));
  }, [peaks, colors, primaryNormScale, primaryBaseline]);

  // One line per annotation: m/z only. The rel% stays available via the
  // existing hover readout in GcmsPlot, so no information is lost — but a
  // one-line box is half the height of the old two-line (m/z + rel%) box,
  // which (along with the smaller 10px font, Phase 2 task C) roughly doubles
  // how many labels fit before layoutLabels starts dropping them. `color`
  // matches the marker colour above so a `markersFromLabels`-derived apex
  // triangle looks identical to the marker it replaces.
  //
  // Per-colour overlay labels (lock-to-cursor): each overlay's top peaks get
  // m/z labels in its own colour, fed through the same `markersFromLabels`
  // path as the primary so leader-cap + reveal-on-zoom apply uniformly.
  // Total label count is capped (primary first, then overlays by descending
  // priority) so overlays don't reflood the plot.
  const annotations = useMemo<LabelInput[]>(() => {
    const color = colors[0] || primaryToken();
    const primaryAnns = peaks.map((p) => ({
      x: p.mz,
      y: p.intensity * primaryNormScale + primaryBaseline,
      lines: [p.mz.toFixed(2)],
      priority: p.intensity * primaryNormScale + primaryBaseline,
      color,
    }));
    const overlayAnns: LabelInput[] = [];
    if (overlayPeaks) {
      for (let index = 0; index < overlayPeaks.length; index += 1) {
        const ov = overlayPeaks[index];
        const metric = spectrumMetrics[index + 1] ?? { normScale: 1, baseline: 0 };
        for (const p of ov.peaks) {
          overlayAnns.push({
            x: p.mz,
            y: p.intensity * metric.normScale + metric.baseline,
            lines: [p.mz.toFixed(2)],
            priority: p.intensity * metric.normScale + metric.baseline,
            color: ov.color,
          });
        }
      }
    }
    // Cap total labels: keep all primary, then top overlays by priority.
    const MAX_TOTAL = 40;
    if (primaryAnns.length + overlayAnns.length <= MAX_TOTAL) {
      return [...primaryAnns, ...overlayAnns];
    }
    const overlayKeep = overlayAnns
      .sort((a, b) => b.priority - a.priority)
      .slice(0, Math.max(0, MAX_TOTAL - primaryAnns.length));
    return [...primaryAnns, ...overlayKeep];
  }, [peaks, colors, overlayPeaks, primaryNormScale, primaryBaseline, spectrumMetrics]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <GcmsPlot
        axis="mz"
        drawMode="stick"
        xLabel="m/z"
        title={title}
        traces={panelTraces}
        activeTraceId={activeTraceId}
        annotations={annotations}
        markers={markers}
        markersFromLabels
        cursorX={null}
        selections={[]}
        background={null}
        xDomain={xDomain}
        normalize={normalize}
        stacked={stacked}
        logY={logY}
        captureRef={captureRef}
        minHeight={minHeight}
        onHover={() => {}}
        onClick={() => {}}
        onSelectRange={() => {}}
      />
    </div>
  );
}
