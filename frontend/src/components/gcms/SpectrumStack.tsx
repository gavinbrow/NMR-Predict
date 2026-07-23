import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { MutableRefObject } from "react";
import type { MassSpectrum, SpecPeak, SpectrumSlot } from "@/lib/gcms/types";
import { SpectrumPanel } from "./SpectrumPanel";

/** One rendered panel: the owning (stack/background) slot plus its
 *  (already-assembled, already background-subtracted) spectra/ids/colors,
 *  ready to hand to a {@link SpectrumPanel} — see `assemblePanels` in
 *  `lib/gcms/slots.ts` for how `Gcms.tsx` builds this list. `overlaySlots` are
 *  any "overlay"-mode slots folded into THIS panel's spectra (in the same
 *  order as `spectra[1..]`) — they don't get a GcmsPlot of their own, but
 *  they still need a header row (mode select + remove ×), or switching one
 *  back to "stack"/removing it would have no UI once it's overlaid. */
export interface SpectrumStackPanel {
  slot: SpectrumSlot;
  overlaySlots: SpectrumSlot[];
  spectra: MassSpectrum[];
  ids: string[];
  colors: string[];
  peaks: SpecPeak[];
  /** Per-colour m/z labels for overlaid (lock-to-cursor) spectra. */
  overlayPeaks: { peaks: SpecPeak[]; color: string }[];
  title: string;
}

export interface SpectrumStackProps {
  panels: SpectrumStackPanel[];
  xDomain?: [number, number];
  normalize: boolean;
  stacked: boolean;
  logY: boolean;
  /** Wired to the "live" panel only — this is what the Export panel's
   *  "spectrum PNG" button grabs, matching the single-panel behaviour before
   *  this phase. */
  captureRef?: MutableRefObject<((scale?: number) => string | null) | null>;
  onModeChange(slotId: string, mode: SpectrumSlot["mode"]): void;
  onRemove(slotId: string): void;
  onAddToComparison?(slotId: string): void;
  /** The active run's RT bounds — clamps the numeric RT editor (bug 9). */
  rtRange?: [number, number];
  /** Bug 9: commit an edited RT window for a range-derived slot. */
  onEditRange?(slotId: string, region: [number, number]): void;
}

/**
 * Vertical stack of spectrum panels (Phase 4 task B) — one per "stack"/
 * "background" slot, each with a small header strip (colour swatch, label,
 * mode select, remove ×). Purely presentational: every piece of state
 * (slots, modes, which spectra belong to which panel) lives in `Gcms.tsx`;
 * this component only renders what it's given and forwards the two gestures
 * (mode change, remove) back up.
 */
export function SpectrumStack(props: SpectrumStackProps): JSX.Element {
  const {
    panels,
    xDomain,
    normalize,
    stacked,
    logY,
    captureRef,
    onModeChange,
    onRemove,
    onAddToComparison,
    rtRange,
    onEditRange,
  } = props;

  if (panels.length === 0) {
    return (
      <div className="flex h-full min-h-[180px] items-center justify-center text-xs text-muted-foreground">
        No mass spectra in this run
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto">
      {panels.map((p) => {
        const isLive = p.slot.id === "live";
        return (
          <div
            key={p.slot.id}
            className="flex min-h-[260px] flex-1 flex-col overflow-hidden rounded-lg border border-border/60 p-2"
          >
            <SlotHeaderRow
              slot={p.slot}
              removable={!isLive}
              onModeChange={onModeChange}
              onRemove={onRemove}
              onAddToComparison={onAddToComparison}
              rtRange={rtRange}
              onEditRange={onEditRange}
            />
            {/* Overlay slots folded into THIS panel each get their OWN header
                row (mode select + remove ×) even though they share this
                panel's GcmsPlot — otherwise switching one back to "stack" or
                removing it would have no control once it's overlaid. */}
            {p.overlaySlots.map((slot) => (
              <SlotHeaderRow
                key={slot.id}
                slot={slot}
                removable
                indent
                onModeChange={onModeChange}
                onRemove={onRemove}
                onAddToComparison={onAddToComparison}
                rtRange={rtRange}
                onEditRange={onEditRange}
              />
            ))}
            <div className="min-h-0 flex-1 overflow-hidden">
              <SpectrumPanel
                spectra={p.spectra}
                ids={p.ids}
                colors={p.colors}
                peaks={p.peaks}
                overlayPeaks={p.overlayPeaks}
                title={p.title}
                normalize={normalize}
                stacked={stacked}
                logY={logY}
                xDomain={xDomain}
                captureRef={isLive ? captureRef : undefined}
                minHeight={140}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** One header row: colour swatch, label, mode select, remove ×. Shared by a
 *  panel's own (anchor) slot and by any overlay slots folded into it. */
function SlotHeaderRow({
  slot,
  removable,
  indent = false,
  onModeChange,
  onRemove,
  onAddToComparison,
  rtRange,
  onEditRange,
}: {
  slot: SpectrumSlot;
  removable: boolean;
  indent?: boolean;
  onModeChange(slotId: string, mode: SpectrumSlot["mode"]): void;
  onRemove(slotId: string): void;
  onAddToComparison?(slotId: string): void;
  rtRange?: [number, number];
  onEditRange?(slotId: string, region: [number, number]): void;
}) {
  return (
    <div className={indent ? "pl-3" : ""}>
      <div className="relative z-10 mb-1 flex shrink-0 items-center justify-between gap-2 bg-card">
        <div className="flex min-w-0 items-center gap-1.5">
          {/* The per-slot colour swatch — the one inline colour here. */}
          <span
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-border/60"
            style={{ backgroundColor: slot.color }}
          />
          <span className="truncate text-xs font-medium text-foreground" title={slot.label}>
            {slot.label}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {onAddToComparison && (
            <button
              type="button"
              onClick={() => onAddToComparison(slot.id)}
              className="flex h-6 items-center gap-1 rounded border border-border/60 bg-background px-1.5 text-[10px] text-muted-foreground hover:border-primary/40 hover:text-primary"
              title={`Add ${slot.label} to cross-document comparison`}
            >
              <Plus className="h-3 w-3" />
              Add to compare
            </button>
          )}
          {/* Slot 0 (live) is always the stacking anchor — its mode is fixed to
              "stack" (there's nothing preceding it to overlay onto, and
              subtracting the live cursor spectrum from itself makes no sense),
              so the select (and remove ×) are hidden there. */}
          {removable && (
            <select
              className="h-6 rounded border border-border/60 bg-background px-1 text-[11px]"
              value={slot.mode}
              onChange={(e) => onModeChange(slot.id, e.target.value as SpectrumSlot["mode"])}
              title="Stack (own panel) / Overlay (into the panel above) / Background (subtract from every other slot)"
            >
              <option value="stack">Stack</option>
              <option value="overlay">Overlay</option>
              <option value="background">Background</option>
            </select>
          )}
          {removable && (
            <button
              type="button"
              onClick={() => onRemove(slot.id)}
              className="shrink-0 text-muted-foreground/60 hover:text-destructive"
              title="Remove this spectrum"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      {/* Bug 9: numeric RT start/end editor — only for range-derived slots
          ("sel"/"sel-N" selections and the Ctrl-drag "bg" window), since a
          "cursor" (live) or "scan" (frozen point) slot has no window to
          edit. */}
      {slot.source.kind === "range" && onEditRange && (
        <RangeEditRow
          slotId={slot.id}
          region={slot.source.regions[0]}
          rtRange={rtRange}
          onCommit={(region) => onEditRange(slot.id, region)}
        />
      )}
    </div>
  );
}

/** The two number inputs (RT start / RT end) for {@link SlotHeaderRow}'s
 *  range-editor row. Local, uncontrolled-feeling state so the user can type
 *  freely; commits on blur or Enter, clamped to `rtRange` and to `lo < hi`.
 *  Re-syncs from the slot's actual region whenever it changes externally
 *  (e.g. a fresh Ctrl-drag on the "bg" window while this row is open). */
function RangeEditRow({
  slotId,
  region,
  rtRange,
  onCommit,
}: {
  slotId: string;
  region: [number, number] | undefined;
  rtRange?: [number, number];
  onCommit(region: [number, number]): void;
}) {
  const [lo, setLo] = useState(String(region?.[0] ?? 0));
  const [hi, setHi] = useState(String(region?.[1] ?? 0));

  useEffect(() => {
    setLo(String(region?.[0] ?? 0));
    setHi(String(region?.[1] ?? 0));
    // Re-sync only when the SLOT identity or its actual region values change,
    // not on every keystroke of this component's own local state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotId, region?.[0], region?.[1]]);

  const commit = () => {
    let a = Number(lo);
    let b = Number(hi);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      setLo(String(region?.[0] ?? 0));
      setHi(String(region?.[1] ?? 0));
      return;
    }
    if (rtRange) {
      a = Math.min(Math.max(a, rtRange[0]), rtRange[1]);
      b = Math.min(Math.max(b, rtRange[0]), rtRange[1]);
    }
    if (a > b) [a, b] = [b, a];
    setLo(String(a));
    setHi(String(b));
    onCommit([a, b]);
  };

  return (
    <div className="mb-1 flex shrink-0 items-center gap-1 pl-4 text-[11px] text-muted-foreground">
      <span>RT</span>
      <input
        type="number"
        step="any"
        value={lo}
        onChange={(e) => setLo(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        title="Range start (min)"
        className="h-6 w-16 rounded border border-border/60 bg-background px-1 text-[11px]"
      />
      <span>–</span>
      <input
        type="number"
        step="any"
        value={hi}
        onChange={(e) => setHi(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        title="Range end (min)"
        className="h-6 w-16 rounded border border-border/60 bg-background px-1 text-[11px]"
      />
      <span>min</span>
    </div>
  );
}
