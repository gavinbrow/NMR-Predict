import { FigureMaker } from "@/components/ir/figure/FigureMaker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { FigureData, FigureOptions } from "@/lib/ir/figure";
import type { Peak, SpectrumData } from "@/lib/maldi/types";

/** One assigned ladder offered in the figure's picker, pre-resolved by the host
 *  (label and colour are the same ones the adapter hands the figure engine). */
export interface MaldiFigureLadderInfo {
  id: string;
  label: string;
  color: string;
}

/**
 * One open spectrum offered to the figure. Every open document is listed —
 * drawn or not — so a multi-spectrum figure can be composed here without going
 * back to the Documents panel: {@link visible} is the tick that puts a spectrum
 * in the figure, and {@link scale}/{@link offset} decide where it sits once it
 * is in. A cross-file figure lists these as sections so the ladders of each file
 * can be picked — and, in the maker's Series controls, styled — file by file
 * rather than out of one undifferentiated list.
 */
export interface MaldiFigureFileInfo {
  id: string;
  name: string;
  /** The document's trace colour (the Documents panel swatch). */
  color: string;
  /** Whether this spectrum is drawn at all — the same `visible` flag the
   *  Documents panel's checkbox sets, not a figure-only copy of it. */
  visible: boolean;
  /** True for the active document, which cannot be hidden (the host forces it
   *  visible; active-but-hidden would describe a spectrum nothing shows). */
  active: boolean;
  /** Peaks of this file the figure draws (or would draw, while it is hidden). */
  peakCount: number;
  /** The document's manual intensity multiplier (1 = as measured). Shared with
   *  the on-screen plot, so a file scaled here is scaled there too. */
  scale: number;
  /** The document's vertical offset, in whatever unit the y-axis is currently
   *  showing. Non-zero is what lifts a spectrum clear of the ones below it. */
  offset: number;
  /** This file's confirmed ladders. */
  ladders: MaldiFigureLadderInfo[];
}

interface MaldiFigurePanelProps {
  /** The spectrum currently displayed (processed when available, else raw). */
  active: SpectrumData | null;
  /** Picked peaks of the active spectrum. */
  peaks: Peak[];
  /** Currently emphasised peaks (a selected series / cluster), if any. */
  highlightedPeakIds?: Set<string>;

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

  /**
   * Every OPEN document, active first, each with its confirmed ladders —
   * superseded duplicate readings the rest of the UI hides never reach here.
   * Hidden documents are listed too, so a second spectrum can be added to the
   * figure from here; only the ticked ones are drawn. One entry is the ordinary
   * single-file case; more than one is a cross-file figure and the picker
   * sections itself by file.
   */
  files: MaldiFigureFileInfo[];
  /** Ids of the ladders ticked in the picker (empty = show every peak). Spans
   *  files: ladder ids are globally unique. */
  selectedSeriesIds: Set<string>;
  onToggleSeries: (id: string) => void;
  /** Tick (`true`) or untick (`false`) every ladder of one file at once. */
  onToggleFileSeries: (fileId: string, on: boolean) => void;
  /** Set one file's intensity multiplier (the same value the Documents panel's
   *  "×" edits — the figure mirrors the plot rather than keeping a second one). */
  onSetFileScale: (fileId: string, scale: number) => void;
  /** Draw / stop drawing one spectrum. Sets the same `MaldiDocument.visible` the
   *  Documents panel's checkbox does, so the plot and the figure can't disagree
   *  about which spectra are in play. */
  onToggleFileVisible: (fileId: string, visible: boolean) => void;
  /** Set one file's vertical offset (the Documents panel's second per-row
   *  number) — the manual counterpart to {@link stacked}, for nudging one
   *  spectrum on its own. */
  onSetFileOffset: (fileId: string, offset: number) => void;
  /** Stack: spread the drawn spectra out with evenly-spaced vertical offsets so
   *  they read as a waterfall instead of sitting on top of each other. Shared
   *  with the Documents panel's Stack switch — one stack, in both places. */
  stacked: boolean;
  onStackedChange: (v: boolean) => void;
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
  showProfile,
  onShowProfileChange,
  showSticks,
  onShowSticksChange,
  selectedOnly,
  onSelectedOnlyChange,
  includeFlagged,
  onIncludeFlaggedChange,
  shownPeaks,
  files,
  selectedSeriesIds,
  onToggleSeries,
  onToggleFileSeries,
  onSetFileScale,
  onToggleFileVisible,
  onSetFileOffset,
  stacked,
  onStackedChange,
  hiddenPeakCount,
  onRestorePeaks,
  onDeletePeak,
  onSetPeakColor,
  figureData,
  figureOptions,
  onFigureOptionsChange,
}: MaldiFigurePanelProps) {
  const hasSelection = (highlightedPeakIds?.size ?? 0) > 0;
  // Which spectra the figure draws is one flag, `MaldiDocument.visible`, shared
  // with the Documents panel and the plot — the old `includeOthers` switch is
  // gone because two unsynchronised visibility models would let the screen and
  // the exported figure disagree (maldi-overhaul-plan.md → WP4). What lives here
  // is a SECOND control over that same flag, not a second model: `files` lists
  // every open document and the tick beside each one IS the Documents panel's
  // checkbox. Without it, putting a second spectrum in a figure meant leaving
  // the Figure tab — and in fullscreen, where the Documents panel is off-screen
  // entirely, it meant leaving the figure.
  const crossFile = files.length > 1;
  const drawnFiles = files.filter((f) => f.visible);
  // Only a drawn file's ladders belong in the picker's counts — a tick left on a
  // spectrum that is currently hidden contributes nothing to the figure.
  const allLadders = drawnFiles.flatMap((f) => f.ladders);
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
        {/* Stack is the Documents panel's switch on the Documents panel's own
            state: it spreads the drawn spectra out with evenly-spaced vertical
            offsets, so a two-spectrum figure reads as a waterfall rather than as
            two curves on top of one another. It needs a second spectrum to mean
            anything — which is exactly the figure that needs it. */}
        <ToggleLine
          id="fig-stack"
          label="Stack spectra"
          checked={stacked}
          onChange={onStackedChange}
          disabled={!crossFile}
          title={
            crossFile
              ? "Spread the drawn spectra out with evenly-spaced vertical offsets (stacks the plot too)"
              : "Open a second spectrum to stack"
          }
          helper={
            crossFile ? "Waterfall — × sets each one's height, ↕ its place" : undefined
          }
        />
        {crossFile && (
          <span
            className="text-[11px] text-muted-foreground"
            title="Tick a spectrum below to draw it: its trace, its peaks and its ladders."
          >
            {`${drawnFiles.length} of ${files.length} spectra`}
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

      {/* Spectrum + series picker: which of the open spectra the figure draws,
          and which of their assigned ladders. With no ladder ticked every shown
          peak is drawn; tick one or more and only those ladders' peaks appear,
          each stick in its ladder colour. Independent of the plot's highlight
          (WP6b). Across files it sections by file, so a two-polymer sample in one
          file and a reference in another stay legible; the colours and wording
          match what the figure's Series controls show. */}
      {/* One block per open spectrum: whether it is drawn, how it is scaled and
          offset, and its assigned ladders. Every number here is the same
          `MaldiDocument` field the Documents panel edits — Normalize takes every
          spectrum to its own 100 %, which is rarely the comparison you actually
          want, so × is where a file gets brought up or pushed down against the
          others, and ↕ is where it gets lifted clear of them. Editing them here
          moves the plot too, deliberately: the figure is a picture of what is on
          screen, and a second, figure-only copy would let the two disagree. */}
      {files.length > 0 && (
        <div className="rounded-2xl border border-border/60 bg-card px-4 py-3 shadow-card">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-foreground">
              {crossFile ? "Spectra & series" : "Spectrum & series"}
            </span>
            {allLadders.length > 0 && (
              <span className="text-[11px] text-muted-foreground">
                {selectedSeriesIds.size === 0
                  ? "All peaks — tick ladders to show only those"
                  : `${selectedSeriesIds.size} of ${allLadders.length} shown`}
              </span>
            )}
          </div>
          <div className="grid gap-2.5">
            {files.map((f) => {
              const on = f.ladders.filter((l) => selectedSeriesIds.has(l.id)).length;
              return (
                <div key={f.id} className="grid gap-1.5">
                  <div className="flex items-center gap-1.5">
                    {/* The tick that puts this spectrum in the figure. The active
                        document's is disabled: the host forces it visible, so an
                        enabled box that springs back would just look broken. */}
                    <input
                      type="checkbox"
                      checked={f.visible}
                      disabled={f.active}
                      onChange={(e) => onToggleFileVisible(f.id, e.target.checked)}
                      className="h-3.5 w-3.5 shrink-0 disabled:opacity-50"
                      title={
                        f.active
                          ? "The active spectrum is always drawn — switch to another document to leave this one out"
                          : f.visible
                            ? `Leave ${f.name} out of the figure`
                            : `Draw ${f.name} in the figure`
                      }
                      aria-label={`Draw ${f.name} in the figure`}
                    />
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full border border-border/60"
                      style={{ backgroundColor: f.color }}
                    />
                    <span
                      className={[
                        "truncate text-[11px] font-semibold",
                        f.visible ? "text-foreground" : "text-muted-foreground",
                      ].join(" ")}
                    >
                      {f.name}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {f.visible ? `${f.peakCount} peak${f.peakCount === 1 ? "" : "s"}` : "not drawn"}
                    </span>
                    {/* Scale and offset only mean something for a drawn spectrum,
                        and a hidden row collapses to its tick and its name. */}
                    {f.visible && (
                      <>
                        <label
                          className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
                          title={
                            stacked
                              ? "How tall this spectrum is drawn — 1 fills its own slot. The stack re-spaces around it, so turning one up doesn't run it through the one above. Also applies on the spectrum plot."
                              : "Intensity multiplier for this file — 1 draws it as measured. Also applies on the spectrum plot."
                          }
                        >
                          <span aria-hidden>×</span>
                          <Input
                            type="number"
                            step={0.1}
                            min={0}
                            value={f.scale}
                            onChange={(e) => onSetFileScale(f.id, Number(e.target.value))}
                            aria-label={`Intensity multiplier for ${f.name}`}
                            className="h-6 w-16 px-1 text-[11px]"
                          />
                        </label>
                        {f.scale !== 1 && (
                          <button
                            type="button"
                            onClick={() => onSetFileScale(f.id, 1)}
                            className="shrink-0 text-[11px] underline underline-offset-2 text-muted-foreground hover:text-foreground"
                            title="Draw this file at its measured intensity"
                          >
                            Reset
                          </button>
                        )}
                        <label
                          className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
                          title="Vertical offset for this file, in the y-axis' current unit — how far up the stack it sits. Also applies on the spectrum plot."
                        >
                          <span aria-hidden>&#8597;</span>
                          <Input
                            type="number"
                            value={f.offset}
                            onChange={(e) => onSetFileOffset(f.id, Number(e.target.value) || 0)}
                            aria-label={`Vertical offset for ${f.name}`}
                            className="h-6 w-20 px-1 text-[11px]"
                          />
                        </label>
                        {f.offset !== 0 && (
                          <button
                            type="button"
                            onClick={() => onSetFileOffset(f.id, 0)}
                            className="shrink-0 text-[11px] underline underline-offset-2 text-muted-foreground hover:text-foreground"
                            title="Drop this file back onto the baseline"
                          >
                            Reset
                          </button>
                        )}
                      </>
                    )}
                    {f.visible && f.ladders.length > 0 && (
                      <button
                        type="button"
                        onClick={() => onToggleFileSeries(f.id, on < f.ladders.length)}
                        className="ml-auto shrink-0 text-[11px] underline underline-offset-2 text-muted-foreground hover:text-foreground"
                      >
                        {on < f.ladders.length ? "All" : "None"}
                      </button>
                    )}
                  </div>
                  {/* A hidden spectrum's ladders are not offered: ticking one is
                      the statement "draw only these ladders", and a tick on a
                      spectrum that isn't drawn would empty the whole figure. */}
                  {f.visible && f.ladders.length > 0 && (
                    <div className="flex flex-wrap gap-x-4 gap-y-1.5 pl-4">
                      {f.ladders.map((l) => (
                        <label
                          key={l.id}
                          className="flex items-center gap-1.5 text-xs text-foreground"
                        >
                          <input
                            type="checkbox"
                            checked={selectedSeriesIds.has(l.id)}
                            onChange={() => onToggleSeries(l.id)}
                            className="h-3.5 w-3.5"
                          />
                          <span
                            className="h-3 w-3 shrink-0 rounded-full border border-border/60"
                            style={{ backgroundColor: l.color }}
                          />
                          <span className="truncate">{l.label}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
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
