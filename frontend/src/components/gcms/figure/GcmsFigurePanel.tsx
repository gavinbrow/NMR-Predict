import { Download, FileCode } from "lucide-react";
import { FigureMaker } from "@/components/ir/figure/FigureMaker";
import { Switch } from "@/components/ui/switch";
import type { FigureData, FigureOptions } from "@/lib/ir/figure";
import type { GcmsFigureSpectrum, GcmsFigureSubject } from "@/lib/gcms/figure";
import type { ChromTrace } from "@/lib/gcms/types";

interface GcmsFigurePanelProps {
  /** Whether any run is open at all (gates the empty state). */
  hasRun: boolean;

  // --- What goes into the figure (WP6 Include strip). All state is owned by
  //     the host (`Gcms.tsx`) so switching tabs never discards an
  //     in-progress figure — the same hoisting pattern MALDI uses (see
  //     `MaldiFigurePanel`'s doc comment / `Maldi.tsx`'s "Figure tab state").

  subject: GcmsFigureSubject;
  onSubjectChange: (v: GcmsFigureSubject) => void;

  /** Every currently-visible chromatogram trace, offered as a checkbox. */
  candidateTraces: ChromTrace[];
  /** Ticked trace ids to include (empty = include every visible trace). */
  includedTraceIds: Set<string>;
  onToggleTrace: (id: string) => void;

  /** Every currently-resolved spectrum slot, offered as a checkbox. */
  candidateSpectra: GcmsFigureSpectrum[];
  /** Ticked slot ids to include (empty = include every resolved slot). */
  includedSpectrumIds: Set<string>;
  onToggleSpectrum: (id: string) => void;

  /** Annotate chrom/spec peaks with their RT / m/z. */
  labelPeaks: boolean;
  onLabelPeaksChange: (v: boolean) => void;

  /** Peaks hidden from the figure only (peak stays in the tables/exports). */
  hiddenPeakCount: number;
  onRestorePeaks: () => void;
  onDeletePeak: (id: string) => void;

  /** Chromatogram figure data + options (always built by the host; the subject
    *  only controls which FigureMaker(s) render, preserving styling across
    *  subject switches). */
  chromFigureData: FigureData;
  chromFigureOptions: FigureOptions;
  onChromFigureOptionsChange: (next: FigureOptions) => void;
  /** Spectrum figure data + options. */
  specFigureData: FigureData;
  specFigureOptions: FigureOptions;
  onSpecFigureOptionsChange: (next: FigureOptions) => void;
  /** Stacked "both" figure data + options — ONE FigureMaker rendering the
    *  chromatogram above the spectrum on a shared normalized x-axis, exporting
    *  one combined image. Replaces the old two-side-by-side FigureMakers. */
  bothFigureData: FigureData;
  bothFigureOptions: FigureOptions;
  onBothFigureOptionsChange: (next: FigureOptions) => void;
}

/** A switch + label, matching the MALDI Figure tab's toolbar idiom. */
function ToggleLine({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
    </div>
  );
}

/** One checkbox row with a colour swatch, used for both the trace and
 *  spectrum-slot pickers below. */
function SwatchCheckbox({
  checked,
  color,
  label,
  onChange,
}: {
  checked: boolean;
  color: string;
  label: string;
  onChange: () => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-foreground">
      <input type="checkbox" checked={checked} onChange={onChange} className="h-3.5 w-3.5" />
      <span className="h-3 w-3 shrink-0 rounded-full border border-border/60" style={{ backgroundColor: color }} />
      <span className="truncate">{label}</span>
    </label>
  );
}

const SUBJECTS: { value: GcmsFigureSubject; label: string }[] = [
  { value: "chromatogram", label: "Chromatogram" },
  { value: "spectrum", label: "Spectrum" },
  { value: "both", label: "Both" },
];

/**
 * The GC/MS "Figure" tab: compose what goes into the publication figure (which
 * chromatogram traces, which spectrum slots, whether to label peaks) here,
 * then style every detail and export with the shared figure maker — the same
 * engine IR/Kinetics/MALDI use, unchanged (mass-spectrum sticks were already
 * added for MALDI). Stateless by design: every piece of editable state (the
 * subject, the include sets, the figure-only peak hides, the figure options)
 * is owned by `Gcms.tsx` so a tab switch never discards the user's
 * in-progress figure — `TabsContent` has no `forceMount`.
 */
export function GcmsFigurePanel({
  hasRun,
  subject,
  onSubjectChange,
  candidateTraces,
  includedTraceIds,
  onToggleTrace,
  candidateSpectra,
  includedSpectrumIds,
  onToggleSpectrum,
  labelPeaks,
  onLabelPeaksChange,
  hiddenPeakCount,
  onRestorePeaks,
  onDeletePeak,
  chromFigureData,
  chromFigureOptions,
  onChromFigureOptionsChange,
  specFigureData,
  specFigureOptions,
  onSpecFigureOptionsChange,
  bothFigureData,
  bothFigureOptions,
  onBothFigureOptionsChange,
}: GcmsFigurePanelProps) {
  if (!hasRun) {
    return (
      <div className="rounded-2xl border border-border/60 bg-card p-4 shadow-card">
        <p className="py-20 text-center text-sm text-muted-foreground">
          Import a run to build a figure.
        </p>
      </div>
    );
  }

  const showTraces = subject !== "spectrum";
  const showSpectra = subject !== "chromatogram";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-border/60 bg-card px-4 py-3 shadow-card">
        <span className="text-xs font-semibold text-foreground">Include</span>
        <div className="flex items-center gap-3">
          {SUBJECTS.map((s) => (
            <label key={s.value} className="flex items-center gap-1.5 text-xs text-foreground">
              <input
                type="radio"
                name="gcms-figure-subject"
                checked={subject === s.value}
                onChange={() => onSubjectChange(s.value)}
                className="h-3.5 w-3.5"
              />
              {s.label}
            </label>
          ))}
        </div>
        <ToggleLine id="fig-label-peaks" label="Label peaks" checked={labelPeaks} onChange={onLabelPeaksChange} />
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

      {showTraces && (
        <div className="rounded-2xl border border-border/60 bg-card px-4 py-3 shadow-card">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-foreground">Chromatogram traces</span>
            <span className="text-[11px] text-muted-foreground">
              {includedTraceIds.size === 0
                ? "All visible traces — tick to show only those"
                : `${includedTraceIds.size} of ${candidateTraces.length} shown`}
            </span>
          </div>
          {candidateTraces.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No visible traces.</p>
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {candidateTraces.map((t) => (
                <SwatchCheckbox
                  key={t.id}
                  checked={includedTraceIds.size === 0 || includedTraceIds.has(t.id)}
                  color={t.color}
                  label={t.label}
                  onChange={() => onToggleTrace(t.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {showSpectra && (
        <div className="rounded-2xl border border-border/60 bg-card px-4 py-3 shadow-card">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-foreground">Spectrum slots</span>
            <span className="text-[11px] text-muted-foreground">
              {includedSpectrumIds.size === 0
                ? "All resolved slots — tick to show only those"
                : `${includedSpectrumIds.size} of ${candidateSpectra.length} shown`}
            </span>
          </div>
          {candidateSpectra.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No resolved spectrum.</p>
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {candidateSpectra.map((s) => (
                <SwatchCheckbox
                  key={s.id}
                  checked={includedSpectrumIds.size === 0 || includedSpectrumIds.has(s.id)}
                  color={s.color}
                  label={s.label}
                  onChange={() => onToggleSpectrum(s.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {subject === "both" ? (
        <FigureMaker
          data={bothFigureData}
          options={bothFigureOptions}
          onChange={onBothFigureOptionsChange}
          onDeletePeak={onDeletePeak}
        />
      ) : (
        <FigureMaker
          data={subject === "spectrum" ? specFigureData : chromFigureData}
          options={subject === "spectrum" ? specFigureOptions : chromFigureOptions}
          onChange={subject === "spectrum" ? onSpecFigureOptionsChange : onChromFigureOptionsChange}
          onDeletePeak={onDeletePeak}
        />
      )}
    </div>
  );
}
