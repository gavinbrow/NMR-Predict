import { useMemo, useState } from "react";
import { FigureMaker } from "@/components/ir/figure/FigureMaker";
import { useFigureOptions } from "@/components/ir/figure/useFigureOptions";
import { Switch } from "@/components/ui/switch";
import { buildMaldiFigureData, type MaldiFigureSpectrum } from "@/lib/maldi/figure";
import type { Peak, SpectrumData } from "@/lib/maldi/types";

interface MaldiFigurePanelProps {
  /** The spectrum currently displayed (processed when available, else raw). */
  active: SpectrumData | null;
  /** Display name / download stem for the primary spectrum. */
  activeName: string;
  /** Picked peaks of the active spectrum. */
  peaks: Peak[];
  /** Currently emphasised peaks (a selected series / cluster), if any. */
  highlightedPeakIds?: Set<string>;
  /** Other open spectra, available to overlay as extra traces. */
  otherSpectra: MaldiFigureSpectrum[];
}

/** A switch + label in the MALDI toolbar idiom. */
function ToggleLine({
  id,
  label,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
    </div>
  );
}

/**
 * The MALDI "Figure" tab: compose what goes into the publication figure (profile
 * trace, centroid sticks, which peaks, which spectra) here, then style every
 * detail and export with the shared figure maker — the same engine the IR view
 * uses, extended with stick spectra and data-anchored m/z labels.
 */
export function MaldiFigurePanel({
  active,
  activeName,
  peaks,
  highlightedPeakIds,
  otherSpectra,
}: MaldiFigurePanelProps) {
  const [showProfile, setShowProfile] = useState(true);
  const [showSticks, setShowSticks] = useState(false);
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [includeOthers, setIncludeOthers] = useState(false);

  const hasSelection = (highlightedPeakIds?.size ?? 0) > 0;
  const hasOthers = otherSpectra.length > 0;

  // Peaks that drive the sticks + labels: accepted, optionally narrowed to the
  // current selection.
  const shownPeaks = useMemo(() => {
    const accepted = peaks.filter((p) => p.accepted !== false && !p.ignored);
    if (selectedOnly && hasSelection) {
      return accepted.filter((p) => highlightedPeakIds!.has(p.id));
    }
    return accepted;
  }, [peaks, selectedOnly, hasSelection, highlightedPeakIds]);

  const figureData = useMemo(() => {
    const spectra: MaldiFigureSpectrum[] = [];
    if (active) spectra.push({ id: "active", name: activeName || "spectrum", spectrum: active });
    if (includeOthers) spectra.push(...otherSpectra);
    return buildMaldiFigureData({
      spectra,
      peaks: shownPeaks,
      showProfile,
      showSticks,
      labelPeaks: true, // label DATA is always supplied; the maker toggles display.
      sourceName: activeName,
    });
  }, [active, activeName, otherSpectra, includeOthers, shownPeaks, showProfile, showSticks]);

  const [figureOptions, setFigureOptions] = useFigureOptions(figureData);

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
        <ToggleLine id="fig-profile" label="Profile trace" checked={showProfile} onChange={setShowProfile} />
        <ToggleLine
          id="fig-sticks"
          label="Peak sticks"
          checked={showSticks}
          onChange={setShowSticks}
          disabled={shownPeaks.length === 0}
        />
        {hasSelection && (
          <ToggleLine
            id="fig-selected"
            label="Selected peaks only"
            checked={selectedOnly}
            onChange={setSelectedOnly}
          />
        )}
        {hasOthers && (
          <ToggleLine
            id="fig-others"
            label={`Overlay open spectra (${otherSpectra.length})`}
            checked={includeOthers}
            onChange={setIncludeOthers}
          />
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {shownPeaks.length} peak{shownPeaks.length === 1 ? "" : "s"} · style &amp; export below
        </span>
      </div>

      <FigureMaker data={figureData} options={figureOptions} onChange={setFigureOptions} />
    </div>
  );
}
