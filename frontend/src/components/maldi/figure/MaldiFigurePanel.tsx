import { FigureMaker } from "@/components/ir/figure/FigureMaker";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { FigureData, FigureOptions } from "@/lib/ir/figure";
import type { Adduct, Peak, Series, SpectrumData } from "@/lib/maldi/types";
import type { MaldiFigureSpectrum } from "@/lib/maldi/figure";
import { seriesDisplayLabel } from "@/lib/maldi/polymers";

interface MaldiFigurePanelProps {
  /** The spectrum currently displayed (processed when available, else raw). */
  active: SpectrumData | null;
  /** Picked peaks of the active spectrum. */
  peaks: Peak[];
  /** Currently emphasised peaks (a selected series / cluster), if any. */
  highlightedPeakIds?: Set<string>;
  /** Other open spectra, available to overlay as extra traces. */
  otherSpectra: MaldiFigureSpectrum[];

  // --- Hoisted figure state (owned by the always-mounted host so it survives
  //     tab switches — the same pattern FigureDialog.tsx:16-18 documents).
  //     Previously these lived as local useState here, which meant every tab
  //     switch tore down the Figure tab and discarded all edits (TabsContent
  //     has no forceMount). See WP0a.

  /** Include the continuous profile trace(s). */
  showProfile: boolean;
  onShowProfileChange: (v: boolean) => void;
  /** Include the picked peaks as vertical sticks. Surfaced in the maker's
   *  "Peaks & labels" controls rather than this bar — it is a statement about
   *  the peaks, and that is where users go looking for it. */
  showSticks: boolean;
  onShowSticksChange: (v: boolean) => void;
  /** Narrow sticks + labels to the highlighted series/cluster only. */
  selectedOnly: boolean;
  onSelectedOnlyChange: (v: boolean) => void;
  /**
   * Include library-flagged peaks (isotope satellites, shoulders, matrix/salt/
   * contaminant). Off by default so the publication figure matches what the
   * analysis UI treats as signal — `unexplainedPeaks` (seriesMatch.ts:16-18)
   * and the PeakTable "unexplained" filter both exclude flagged peaks. See WP0c.
   */
  includeFlagged: boolean;
  onIncludeFlaggedChange: (v: boolean) => void;
  /** Peaks that survive the include/flag/selection filters (computed by the host). */
  shownPeaks: Peak[];

  // --- Figure-only series picker + peak exclusion (WP6b). Both are figure-local
  //     and independent of the plot's highlight, so composing a figure never
  //     disturbs the analysis view and vice versa.

  /** The confirmed ladders offered in the picker (`series.filter(endGroupLocked)`
   *  — superseded duplicate readings the rest of the UI hides never reach here). */
  confirmedSeries: Series[];
  /** Adducts, for resolving a ladder's fallback label (`seriesDisplayLabel`). */
  adducts: Adduct[];
  /** The ladder colour of a series — reused verbatim from the page so the figure
   *  agrees with the plot stems and the sidebar swatches. */
  colorForSeries: (s: Series) => string;
  /** Ids of the ladders ticked in the picker (empty = show every peak). */
  selectedSeriesIds: Set<string>;
  onToggleSeries: (id: string) => void;
  /** How many peaks are currently hidden by figure-only deletes (in this view). */
  hiddenPeakCount: number;
  /** Restore every figure-only-deleted peak (never a one-way door). */
  onRestorePeaks: () => void;
  /** Remove one peak's stick + label from the figure (the peak stays elsewhere).
   *  Wired down to the selected-label editor's "Delete peak from figure". */
  onDeletePeak: (id: string) => void;
  /** Set (`color`) or clear (`null`) one peak's own colour — the same
   *  `Peak.color` the Peak table edits, reachable from the figure's label list
   *  so a single peak can be recoloured without leaving the figure. */
  onSetPeakColor: (id: string, color: string | null) => void;

  /** Figure-engine data + options, owned by the host. */
  figureData: FigureData;
  figureOptions: FigureOptions;
  onFigureOptionsChange: (next: FigureOptions) => void;
}

/** A switch + label in the MALDI toolbar idiom. */
function ToggleLine({
  id,
  label,
  checked,
  onChange,
  disabled,
  title,
  helper,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  /** Tooltip on the whole line — used to explain a disabled state. */
  title?: string;
  /** One-line caption under the label, in the panel's helper-text style. */
  helper?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5" title={title}>
      <div className="flex items-center gap-1.5">
        <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
        <label htmlFor={id} className="text-xs text-muted-foreground">
          {label}
        </label>
      </div>
      {helper && <span className="text-[11px] text-muted-foreground">{helper}</span>}
    </div>
  );
}

/**
 * The MALDI "Figure" tab: compose what goes into the publication figure (profile
 * trace, centroid sticks, which peaks, which spectra) here, then style every
 * detail and export with the shared figure maker — the same engine the IR view
 * uses, extended with stick spectra and data-anchored m/z labels.
 *
 * Stateless by design: all editable state (the include toggles, the series
 * picker, the figure-only deletes, the figure options, the filtered peak set) is
 * owned by the host page so switching tabs no longer discards the user's
 * in-progress figure. The host keeps the `useFigureOptions` hook at its own top
 * level, mirroring FigureDialog.tsx and ViewExport.tsx.
 */
export function MaldiFigurePanel({
  active,
  peaks,
  highlightedPeakIds,
  otherSpectra,
  showProfile,
  onShowProfileChange,
  showSticks,
  onShowSticksChange,
  selectedOnly,
  onSelectedOnlyChange,
  includeFlagged,
  onIncludeFlaggedChange,
  shownPeaks,
  confirmedSeries,
  adducts,
  colorForSeries,
  selectedSeriesIds,
  onToggleSeries,
  hiddenPeakCount,
  onRestorePeaks,
  onDeletePeak,
  onSetPeakColor,
  figureData,
  figureOptions,
  onFigureOptionsChange,
}: MaldiFigurePanelProps) {
  const hasSelection = (highlightedPeakIds?.size ?? 0) > 0;
  // The overlay set is driven by the Documents panel's per-row visibility
  // checkbox — `otherSpectra` already contains only the VISIBLE non-active
  // documents (filtered by the host). The old `includeOthers` switch is gone:
  // two unsynchronised visibility models would let the screen and the exported
  // figure disagree (maldi-overhaul-plan.md → WP4).
  const hasOthers = otherSpectra.length > 0;
  // A flagged peak is one the library/background detector has tagged. Whether
  // to draw them is a figure-only choice; the underlying peak list is unchanged.
  const hasFlagged = peaks.some((p) => p.flag);

  if (!active) {
    return (
      <div className="rounded-2xl border border-border/60 bg-card p-4 shadow-card">
        <p className="py-20 text-center text-sm text-muted-foreground">
          Import a spectrum to build a figure.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* What goes into the figure (styling lives in the maker's controls panel). */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-border/60 bg-card px-4 py-3 shadow-card">
        <span className="text-xs font-semibold text-foreground">Include</span>
        <ToggleLine id="fig-profile" label="Profile trace" checked={showProfile} onChange={onShowProfileChange} />
        <ToggleLine
          id="fig-selected"
          label="Selected peaks only"
          checked={selectedOnly}
          onChange={onSelectedOnlyChange}
          disabled={!hasSelection}
          title={!hasSelection ? "Select a series or cluster in the plot/table to enable" : undefined}
        />
        {/* The "Overlay open spectra" toggle was deleted in WP4 — the overlay
            set is now driven by the Documents panel's per-row visibility
            checkbox, so the screen and the exported figure can't disagree. The
            count of overlaid spectra is still surfaced here as a read-only
            hint so the user knows how many traces will appear in the figure. */}
        {hasOthers && (
          <span className="text-[11px] text-muted-foreground" title="Visible non-active documents are overlaid as profile traces">
            {`+${otherSpectra.length} overlaid`}
          </span>
        )}
        <ToggleLine
          id="fig-flagged"
          label="Include flagged peaks"
          checked={includeFlagged}
          onChange={onIncludeFlaggedChange}
          disabled={!hasFlagged}
          title={!hasFlagged ? "No peaks are currently flagged" : undefined}
          helper="Flagged = isotope satellites, shoulders, matrix/salt/contaminant noise"
        />
        <span className="ml-auto text-[11px] text-muted-foreground">
          {shownPeaks.length} peak{shownPeaks.length === 1 ? "" : "s"} · style &amp; export below
        </span>
        {/* Figure-only deletes are never a one-way door — surface the count with
            a one-click restore (WP6b, decision 1). */}
        {hiddenPeakCount > 0 && (
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {hiddenPeakCount} hidden ·
            <button
              type="button"
              onClick={onRestorePeaks}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Restore all
            </button>
          </span>
        )}
      </div>

      {/* Series picker: choose which assigned ladders the figure draws. With none
          ticked every shown peak is drawn; tick one or more and only those
          ladders' peaks appear, each stick in its ladder colour. Independent of
          the plot's highlight (WP6b). */}
      {confirmedSeries.length > 0 && (
        <div className="rounded-2xl border border-border/60 bg-card px-4 py-3 shadow-card">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-foreground">Series</span>
            <span className="text-[11px] text-muted-foreground">
              {selectedSeriesIds.size === 0
                ? "All peaks — tick ladders to show only those"
                : `${selectedSeriesIds.size} of ${confirmedSeries.length} shown`}
            </span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {confirmedSeries.map((s) => (
              <label key={s.id} className="flex items-center gap-1.5 text-xs text-foreground">
                <input
                  type="checkbox"
                  checked={selectedSeriesIds.has(s.id)}
                  onChange={() => onToggleSeries(s.id)}
                  className="h-3.5 w-3.5"
                />
                <span
                  className="h-3 w-3 shrink-0 rounded-full border border-border/60"
                  style={{ backgroundColor: colorForSeries(s) }}
                />
                <span className="truncate">{seriesDisplayLabel(s, adducts)}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <FigureMaker
        data={figureData}
        options={figureOptions}
        onChange={onFigureOptionsChange}
        onDeletePeak={onDeletePeak}
        showSticks={showSticks}
        onShowSticksChange={onShowSticksChange}
        onSetPeakColor={onSetPeakColor}
      />
    </div>
  );
}
