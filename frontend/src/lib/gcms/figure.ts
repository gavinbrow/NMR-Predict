// Adapter from the GC/MS data model to the neutral figure engine (`lib/ir/figure`,
// the shared publication-figure system already used by IR, Kinetics and MALDI).
// It turns the visible chromatogram trace(s) and/or the resolved spectrum
// slot(s), plus their merged peak lists, into the engine's `FigureData` shape —
// line series for chromatograms, stick series for mass spectra (the engine
// already has `SeriesKind: "sticks"`, added for MALDI, so no engine change is
// needed here), and data-anchored RT/m/z peak labels. Mirrors
// `lib/maldi/figure.ts`'s `buildMaldiFigureData` closely — same shape, same
// "always supply peakLabels" convention — so the two hosts stay easy to compare.
// Pure data shaping; no DOM, fully unit-testable.

import type { FigureData, FigureSeriesData, PeakLabelDatum } from "@/lib/ir/figure";
import { downsample } from "./view";
import type { ChromPeak, ChromTrace, MassSpectrum, SpecPeak } from "./types";

/** What the figure draws. See {@link buildGcmsFigureData}'s doc comment for how
 *  "both" reconciles the chromatogram's RT axis with the spectrum's m/z axis. */
export type GcmsFigureSubject = "chromatogram" | "spectrum" | "both";

/**
 * One spectrum slot to plot as a stick series. `spectra[0]` is the primary —
 * its peaks (`specPeaks`) are labelled, mirroring `MaldiFigureSpectrum`'s
 * "first entry is primary" convention. `MassSpectrum` itself carries no
 * colour (colours live on the `SpectrumSlot` / the active document in
 * `Gcms.tsx`), so the host wraps each spectrum it wants to include with the
 * swatch colour it's already showing on screen.
 */
export interface GcmsFigureSpectrum {
  id: string;
  label: string;
  /** Swatch colour (the slot's own colour, or the active document's colour
   *  for the "live" slot) — flows straight into the stick series so the
   *  exported figure matches the on-screen spectrum panel. */
  color: string;
  spectrum: MassSpectrum;
  peaks?: SpecPeak[];
  baseline?: number;
}

export interface BuildGcmsFigureArgs {
  subject: GcmsFigureSubject;
  /** Visible chromatogram traces, each becoming its own line series. */
  traces: ChromTrace[];
  /** Spectrum slots to include, each becoming its own stick series. */
  spectra: GcmsFigureSpectrum[];
  /** Chromatographic peaks (already merged derived+manual, already filtered
   *  to what should be shown) — drives the RT peak labels. */
  chromPeaks: ChromPeak[];
  /** Spectrum peaks (already merged derived+manual) of the PRIMARY spectrum
   *  (`spectra[0]`) — drives the m/z peak labels. */
  specPeaks: SpecPeak[];
  /** Annotate peaks with their retention time / m/z. */
  labelPeaks: boolean;
  /** File-name stem for downloads. */
  sourceName?: string;
  /**
   * Cap on points per chromatogram trace before it reaches the SVG renderer,
   * min/max-bucket decimated via `downsample` (the same envelope-preserving
   * algorithm the live chromatogram plot already uses for panning/zooming —
   * `lib/gcms/view.ts`). A real Agilent run can be 3,000-10,000+ scans; an SVG
   * export with that many path points is slow to pan and needlessly large as
   * a vector file. Peaks stay exact because each bucket keeps its min AND max
   * point, so narrow chromatographic peaks survive the decimation.
   */
  maxTracePoints?: number;
}

/** Default `maxTracePoints` — comfortably above what a real GC run needs for a
 *  crisp on-screen/exported line while keeping the SVG small. */
const DEFAULT_MAX_TRACE_POINTS = 2000;

/** Convert a Float64Array to a plain number[] — the figure engine is
 *  number[]-based; the GC/MS data model is typed-array-based for memory. */
function toNumbers(arr: Float64Array): number[] {
  return Array.from(arr);
}

/** The on-screen chromatogram applies a per-trace intensity gain (`scale`,
 *  Phase 3, item 6) and a vertical `offset` before drawing — see `GcmsPlot`'s
 *  `buildData` / `scaleColumn` / `applyOffset`. The figure is meant to match
 *  what the user arranged on screen (WYSIWYG), so we apply the same linear
 *  transform here rather than exporting the raw trace. A single point's screen
 *  y is `intensity * scale + offset`; the same formula positions its peak
 *  label so the label stays on the curve. Non-finite / non-positive `scale` is
 *  treated as 1 and a missing `offset` as 0, mirroring `scaleColumn`. */
function traceGain(trace: ChromTrace): { scale: number; offset: number } {
  const scale = Number.isFinite(trace.scale) && trace.scale > 0 ? trace.scale : 1;
  const offset = Number.isFinite(trace.offset) ? trace.offset : 0;
  return { scale, offset };
}

/**
 * Build the figure-engine `FigureData` for a GC/MS view. Each visible
 * chromatogram trace becomes a line series on its own (downsampled) RT grid;
 * each included spectrum slot becomes a stick series on its own m/z grid. The
 * merged chrom/spec peak lists optionally become data-anchored labels, each
 * carrying its owning series id (`trace:${id}` / `sticks:${id}`) so "colour
 * labels by series" resolves correctly — same mechanism as the MALDI adapter's
 * ladder grouping, just without the ladder concept (GC/MS peaks don't belong
 * to assigned series the way MALDI's do).
 *
 * "both": the engine's `FigureData` has ONE shared x-axis label, but a
 * chromatogram's x is retention time (minutes, roughly 0-60) and a spectrum's
 * x is m/z (roughly 50-500) — genuinely different quantities with no natural
 * shared scale, and the engine (deliberately not modified here) has no notion
 * of a second/secondary x-axis. Rather than silently coercing one onto the
 * other, "both" draws BOTH series groups on the one plot (every
 * `FigureSeriesData` already carries its own independent `x` array, so this
 * is not a shared-x hack) with a combined axis label naming both quantities,
 * so the user sees exactly what got included and can hide/style either
 * group's series individually in the styling panel afterwards. Picking a
 * single subject (Chromatogram or Spectrum) remains the clean, recommended
 * path for a publication figure; "both" is there for a user who explicitly
 * wants one figure with everything in it and is willing to then hide/rescale
 * what they don't want. This is a documented product decision, not a
 * limitation worth an engine change.
 */
export function buildGcmsFigureData(args: BuildGcmsFigureArgs): FigureData {
  const { subject, traces, spectra, chromPeaks, specPeaks, labelPeaks, sourceName, maxTracePoints } =
    args;
  const maxPoints = maxTracePoints ?? DEFAULT_MAX_TRACE_POINTS;

  const series: FigureSeriesData[] = [];
  const peakLabels: PeakLabelDatum[] = [];

  const includeChrom = subject === "chromatogram" || subject === "both";
  const includeSpec = subject === "spectrum" || subject === "both";

  if (includeChrom) {
    for (const trace of traces) {
      const { scale, offset } = traceGain(trace);
      const ds = downsample({ x: trace.rtMin, y: trace.intensity }, maxPoints);
      const y = toNumbers(ds.y);
      // Match the on-screen curve: intensity * scale + offset. Applied after
      // the min/max-envelope downsample — a linear, monotonic transform, so it
      // preserves the decimated envelope exactly. Skipped when it's a no-op.
      const yScaled = scale === 1 && offset === 0 ? y : y.map((v) => v * scale + offset);
      series.push({
        id: `trace:${trace.id}`,
        label: trace.label,
        x: toNumbers(ds.x),
        y: yScaled,
        styleHints: { kind: "line", lineWidth: 1.25, color: trace.color },
      });
    }
    if (labelPeaks) {
      for (const p of chromPeaks) {
        const owningTrace = traces.find((t) => t.id === p.traceId);
        const custom = typeof p.name === "string" && p.name.length > 0;
        // Position the label on the transformed curve so it tracks the trace's
        // gain/offset (same formula as the series y above).
        const g = owningTrace ? traceGain(owningTrace) : { scale: 1, offset: 0 };
        peakLabels.push({
          id: p.id,
          x: p.rtApex,
          y: p.height * g.scale + g.offset,
          text: custom ? p.name! : p.rtApex.toFixed(3),
          ...(custom ? { customText: true } : {}),
          ...(owningTrace ? { seriesId: `trace:${owningTrace.id}` } : {}),
        });
      }
    }
  }

  if (includeSpec) {
    for (const entry of spectra) {
      series.push({
        id: `sticks:${entry.id}`,
        label: entry.label,
        x: toNumbers(entry.spectrum.mz),
        y: toNumbers(entry.spectrum.intensity),
        baseline: entry.baseline,
        styleHints: { kind: "sticks", lineWidth: 1, color: entry.color },
      });
    }
    if (labelPeaks) {
      // Spec peaks (picked against the LIVE spectrum elsewhere in the host)
      // are labelled against the primary — first — included spectrum, mirroring
      // MALDI's "spectra[0] is primary" convention.
      spectra.forEach((entry, index) => {
        const peaks = entry.peaks ?? (index === 0 ? specPeaks : []);
        for (const p of peaks) {
          peakLabels.push({
            id: p.id,
            x: p.mz,
            y: p.intensity,
            text: p.mz.toFixed(2),
            seriesId: `sticks:${entry.id}`,
          });
        }
      });
    }
  }

  // Shared x seed: whichever axis is actually drawn (the first chromatogram
  // trace's RT grid, else the primary spectrum's m/z grid). Every series above
  // supplies its own `x`, so this only seeds the initial x-range before the
  // user (or `defaultFigureOptions`) has touched anything.
  const seedX = includeChrom && traces[0]
    ? toNumbers(traces[0].rtMin)
    : includeSpec && spectra[0]
      ? toNumbers(spectra[0].spectrum.mz)
      : [];

  const xLabel =
    subject === "chromatogram"
      ? "Retention time (min)"
      : subject === "spectrum"
        ? "m/z"
        : "Retention time (min) / m/z";

  return {
    x: seedX,
    series,
    xLabel,
    yLabel: "Intensity",
    reversedX: false,
    sourceName: sourceName || "gcms",
    // Always present (possibly empty), like the MALDI adapter, so the figure
    // maker's "Peaks & labels" controls always appear for GC/MS.
    peakLabels: labelPeaks ? peakLabels : [],
  };
}

/**
 * Build ONE stacked figure for `subject === "both"`: the chromatogram traces
 * sit at the TOP of the plot area (their y raised by a vertical offset), the
 * spectrum sticks sit at the BOTTOM. The shared horizontal axis is the real
 * m/z range so spectrum ticks and peak positions remain scientifically useful.
 * Chromatogram RT is projected across that span only for layout; its peak
 * labels retain their real RT values as explicit custom text.
 *
 * This produces a SINGLE FigureData (one FigureMaker, one styling panel, one
 * export) — the user explicitly asked for "1 figure, stacked, 1 image" rather
 * than two side-by-side figure makers.
 */
export function buildGcmsStackedFigureData(args: Omit<BuildGcmsFigureArgs, "subject">): FigureData {
  const { traces, spectra, chromPeaks, specPeaks, labelPeaks, sourceName, maxTracePoints } =
    args;
  const maxPoints = maxTracePoints ?? DEFAULT_MAX_TRACE_POINTS;

  const series: FigureSeriesData[] = [];
  const peakLabels: PeakLabelDatum[] = [];

  // Chromatogram RT range (union of every included trace).
  let rtLo = Infinity;
  let rtHi = -Infinity;
  for (const t of traces) {
    if (t.rtMin.length === 0) continue;
    rtLo = Math.min(rtLo, t.rtMin[0]);
    rtHi = Math.max(rtHi, t.rtMin[t.rtMin.length - 1]);
  }
  if (!Number.isFinite(rtLo) || !Number.isFinite(rtHi)) {
    rtLo = 0;
    rtHi = 1;
  }
  const rtSpan = rtHi - rtLo || 1;

  // Spectrum m/z range (union of every included spectrum, plus the spec peaks).
  let mzLo = Infinity;
  let mzHi = -Infinity;
  for (const entry of spectra) {
    for (const m of entry.spectrum.mz) {
      if (m < mzLo) mzLo = m;
      if (m > mzHi) mzHi = m;
    }
  }
  if (!Number.isFinite(mzLo) || !Number.isFinite(mzHi)) {
    mzLo = 0;
    mzHi = 1;
  }
  const mzSpan = mzHi - mzLo || 1;

  // Spectrum max intensity (drives the vertical offset that separates the two
  // groups so the chromatogram sits clearly above the spectrum).
  let specMax = 0;
  for (const entry of spectra) {
    for (const v of entry.spectrum.intensity) {
      if (Number.isFinite(v) && v > specMax) specMax = v;
    }
  }
  // Chromatogram max intensity (after per-trace gain/offset, matching what the
  // on-screen curve shows).
  let chromMax = 0;
  for (const t of traces) {
    const { scale, offset } = traceGain(t);
    for (const v of t.intensity) {
      const w = v * scale + offset;
      if (Number.isFinite(w) && w > chromMax) chromMax = w;
    }
  }
  // Vertical offset: stack the chromatogram above the spectrum with a gap of
  // ~15% of the spectrum max so the two groups never overlap.
  const gap = specMax * 0.15;
  const yOffset = specMax + gap;

  // Chromatogram traces → line series, RT projected onto the real m/z axis,
  // y raised by yOffset so they sit at the top of the plot.
  for (const trace of traces) {
    if (trace.rtMin.length === 0) continue;
    const { scale, offset } = traceGain(trace);
    const ds = downsample({ x: trace.rtMin, y: trace.intensity }, maxPoints);
    const xs = Array.from(ds.x, (rt) => mzLo + ((rt - rtLo) / rtSpan) * mzSpan);
    const ys = Array.from(ds.y, (v, i) => {
      const w = v * scale + offset;
      return Number.isFinite(w) ? w + yOffset : NaN;
    });
    series.push({
      id: `trace:${trace.id}`,
      label: trace.label,
      x: xs,
      y: ys,
      styleHints: { kind: "line", lineWidth: 1.25, color: trace.color },
    });
  }
  if (labelPeaks) {
    for (const p of chromPeaks) {
      const owningTrace = traces.find((t) => t.id === p.traceId);
      const custom = typeof p.name === "string" && p.name.length > 0;
      const g = owningTrace ? traceGain(owningTrace) : { scale: 1, offset: 0 };
      const xProjected = mzLo + ((p.rtApex - rtLo) / rtSpan) * mzSpan;
      const yAnchor = p.height * g.scale + g.offset + yOffset;
      peakLabels.push({
        id: p.id,
        x: xProjected,
        y: yAnchor,
        text: custom ? p.name! : p.rtApex.toFixed(3),
        // The anchor is projected m/z-space, so always preserve real RT text.
        customText: true,
        ...(owningTrace ? { seriesId: `trace:${owningTrace.id}` } : {}),
      });
    }
  }

  // Spectrum sticks → stick series on their real m/z values.
  for (const entry of spectra) {
    series.push({
      id: `sticks:${entry.id}`,
      label: entry.label,
      x: toNumbers(entry.spectrum.mz),
      y: toNumbers(entry.spectrum.intensity),
      baseline: entry.baseline,
      styleHints: { kind: "sticks", lineWidth: 1, color: entry.color },
    });
  }
  if (labelPeaks) {
    spectra.forEach((entry, index) => {
      const peaks = entry.peaks ?? (index === 0 ? specPeaks : []);
      for (const p of peaks) {
        peakLabels.push({
          id: p.id,
          x: p.mz,
          y: p.intensity,
          text: p.mz.toFixed(2),
          seriesId: `sticks:${entry.id}`,
        });
      }
    });
  }

  return {
    x: [mzLo, mzHi],
    series,
    xLabel: "m/z (bottom); chromatogram labels show RT (min)",
    yLabel: "Intensity",
    reversedX: false,
    sourceName: sourceName || "gcms",
    peakLabels: labelPeaks ? peakLabels : [],
  };
}
