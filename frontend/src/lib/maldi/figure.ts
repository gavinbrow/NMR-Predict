// Adapter from the MALDI data model to the neutral figure engine (`lib/ir/figure`,
// the shared publication-figure system). It turns the active spectrum, its picked
// peaks, and any overlaid spectra into the engine's `FigureData` shape — a profile
// trace, an optional centroid/stick series, and data-anchored m/z peak labels —
// so the same fully-controllable figure maker the IR view uses renders MALDI
// publication figures. Pure data shaping; no DOM, fully unit-testable.

import type { FigureData, FigureSeriesData, PeakLabelDatum } from "@/lib/ir/figure";
import type { Peak, SpectrumData } from "./types";

/** One spectrum to plot. The first entry is the primary (its peaks are labelled). */
export interface MaldiFigureSpectrum {
  id: string;
  name: string;
  spectrum: SpectrumData;
}

export interface BuildMaldiFigureArgs {
  /** Spectra to draw as profile traces; `spectra[0]` is the primary. */
  spectra: MaldiFigureSpectrum[];
  /** Peaks of the primary spectrum, already filtered to what should be shown
   *  (e.g. accepted-only, or just the selected series). Drives sticks + labels. */
  peaks: Peak[];
  /** Draw the continuous profile trace(s). */
  showProfile: boolean;
  /** Draw the picked peaks as vertical sticks (centroid spectrum). */
  showSticks: boolean;
  /** Annotate peaks with their m/z. */
  labelPeaks: boolean;
  /** File-name stem for downloads. */
  sourceName: string;
}

/** A neutral dark trace for the primary spectrum (matches the on-screen viewer). */
const PRIMARY_TRACE = "#1e293b";
/** Sky stems for the centroid/stick series (matches the viewer's peak markers). */
const STICK_COLOR = "#0ea5e9";

/** The drawable m/z of a peak (centroid-refined when available). */
const peakMz = (p: Peak): number => p.centroid ?? p.mz;

/**
 * Build the figure-engine `FigureData` for a MALDI view. Each spectrum becomes a
 * line series on its own m/z grid; the primary's peaks optionally become a stick
 * series and a set of m/z labels. `peakLabels` is always present (possibly empty)
 * so the figure maker shows the "Peaks & labels" controls for MALDI.
 */
export function buildMaldiFigureData(args: BuildMaldiFigureArgs): FigureData {
  const { spectra, peaks, showProfile, showSticks, labelPeaks, sourceName } = args;
  const series: FigureSeriesData[] = [];

  if (showProfile) {
    spectra.forEach((s, i) => {
      series.push({
        id: `profile:${s.id}`,
        label: s.name,
        x: Array.from(s.spectrum.mz),
        y: Array.from(s.spectrum.intensity),
        // Primary trace dark; overlays fall back to the engine's palette.
        styleHints: { kind: "line", lineWidth: 1, ...(i === 0 ? { color: PRIMARY_TRACE } : {}) },
      });
    });
  }

  if (showSticks && peaks.length > 0) {
    series.push({
      id: "sticks",
      label: "Peaks",
      x: peaks.map(peakMz),
      y: peaks.map((p) => p.intensity),
      styleHints: { kind: "sticks", lineWidth: 1, color: STICK_COLOR },
    });
  }

  const peakLabels: PeakLabelDatum[] = labelPeaks
    ? peaks.map((p) => {
        const mz = peakMz(p);
        return { id: p.id, x: mz, y: p.intensity, text: mz.toFixed(2) };
      })
    : [];

  // The shared grid is the primary spectrum's m/z (used to seed the x-range and as
  // the fallback for any series that omits its own x — none here do).
  const primaryMz = spectra[0]?.spectrum.mz;
  return {
    x: primaryMz ? Array.from(primaryMz) : [],
    series,
    xLabel: "m/z",
    yLabel: "Intensity",
    reversedX: false,
    sourceName: sourceName || "maldi",
    peakLabels,
  };
}
