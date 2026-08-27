// Adapter from the TGA data model to the neutral figure engine (`lib/ir/figure`,
// the shared publication-figure system used by IR, Kinetics, MALDI, and GC/MS).
// It turns the visible runs (with their computed analysis) into the engine's
// `FigureData` shape — a line series per run on the left y-axis (weight %),
// an optional DTG line series per run on the right y2-axis, and data-anchored
// peak labels for every callout (onset, Td, Tmax, residue). Mirrors
// `lib/gcms/figure.ts`'s `buildGcmsFigureData` closely — same shape, same
// "always supply peakLabels" convention — so the hosts stay easy to compare.
//
// The y2 axis is the reason this host exists: weight % and DTG share the
// temperature x-axis but have independent y-scales, so the DTG series declares
// `axis: "y2"` and the figure engine (extended in WP5) draws a right-hand axis
// for it. Pure data shaping; no DOM, fully unit-testable.
//
// Markers are drawn in each run's OWN vertical band. A marker line that ran
// 0→100 regardless of the y-mode pointed at nothing once runs were stacked (or
// once the axis was mg), so every vertical now runs from its run's floor up to
// the run's curve at that temperature, and the callout is anchored on the curve
// itself. That is what makes a marker readable as belonging to one sample.

import type { FigureData, FigureSeriesData, PeakLabelDatum } from "@/lib/ir/figure";
import { downsample } from "./view";
import type { TgaRunAnalyzed } from "./store";

/** What the figure plots on the x-axis. */
export type TgaXAxis = "temperature" | "time";
/** What the figure plots on the primary y-axis. */
export type TgaYAxis = "weightPct" | "weightMg";

/** Which marker families to draw. Each is a boolean toggle in the include strip. */
export interface TgaMarkerToggles {
  onset: boolean;
  endset: boolean;
  td: boolean;
  tmax: boolean;
  residue: boolean;
  stepShade: boolean;
}

export interface BuildTgaFigureArgs {
  /** Visible runs, each with its computed analysis. */
  runs: TgaRunAnalyzed[];
  /** X-axis mode (temperature or time). */
  xAxis: TgaXAxis;
  /** Y-axis mode (weight % or weight mg). */
  yAxis: TgaYAxis;
  /** Draw the DTG series on the right-hand y2 axis. */
  showDtg: boolean;
  /** Annotate the markers with their temperature / residue value. */
  labelMarkers: boolean;
  /** Stack runs with a vertical offset per run (as MALDI stacks spectra). */
  stackRuns: boolean;
  /** Marker families to draw (onset tangents, Td drop-lines, Tmax, residue). */
  markers: TgaMarkerToggles;
  /** File-name stem for downloads. */
  sourceName?: string;
  /**
   * Cap on points per run before it reaches the SVG renderer, min/max-bucket
   * decimated via `downsample`. Generous — the preview decimates again to the
   * plot width, so this only bounds the *exported* SVG, and an export should
   * carry the curve the instrument recorded rather than a sketch of it.
   */
  maxTracePoints?: number;
}

const DEFAULT_MAX_TRACE_POINTS = 20000;

/** Fraction of a run's own height left as clear space above it when stacking. */
const STACK_GAP_FRACTION = 0.15;

/** Convert a Float64Array to a plain number[] — the figure engine is
 *  number[]-based; the TGA data model is typed-array-based. */
function toNumbers(arr: Float64Array): number[] {
  return Array.from(arr);
}

/** Per-run display multiplier: apply the run's scale and offset exactly as the
 *  on-screen plot does (v * scale + offset), so the figure matches the screen. */
function applyGain(y: number[], scale: number, offset: number): number[] {
  if (scale === 1 && offset === 0) return y;
  return y.map((v) => v * scale + offset);
}

/**
 * Value of a decimated curve at `xv`, linearly interpolated. Used to anchor
 * every marker on the curve it belongs to — the whole point of a callout is
 * that you can see which line it is talking about.
 *
 * Outside the recorded range it clamps to the nearest end: an extrapolated
 * onset can legitimately land below the first recorded temperature, and
 * dropping the callout would be a worse answer than drawing it at the edge.
 * Null only for an empty curve or an all-gap one.
 */
function valueAt(x: number[], y: number[], xv: number): number | null {
  const n = x.length;
  if (n === 0 || !Number.isFinite(xv)) return null;
  const ascending = n < 2 || x[n - 1] >= x[0];
  const lo = ascending ? x[0] : x[n - 1];
  const hi = ascending ? x[n - 1] : x[0];
  if (xv <= lo || xv >= hi) {
    const end = xv <= lo ? (ascending ? y[0] : y[n - 1]) : ascending ? y[n - 1] : y[0];
    return Number.isFinite(end) ? end : null;
  }
  // Binary search on the (monotone) x grid.
  let a = 0;
  let b = n - 1;
  while (b - a > 1) {
    const m = (a + b) >> 1;
    const cmp = ascending ? x[m] <= xv : x[m] >= xv;
    if (cmp) a = m;
    else b = m;
  }
  const x0 = x[a];
  const x1 = x[b];
  const y0 = y[a];
  const y1 = y[b];
  if (Number.isFinite(y0) && Number.isFinite(y1) && x1 !== x0) {
    return y0 + ((y1 - y0) * (xv - x0)) / (x1 - x0);
  }
  if (Number.isFinite(y0)) return y0;
  if (Number.isFinite(y1)) return y1;
  return null;
}

/** Min / max of the finite values of an array. */
function finiteExtent(values: number[]): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

/**
 * Build the figure-engine data for the TGA publication figure: one line series
 * per run on the left y-axis (weight % or mg), an optional DTG line series per
 * run on the right y2-axis, marker series (legendHidden) for onset tangents /
 * Td drop-lines / Tmax verticals / residue, and data-anchored peak labels for
 * every callout. Follows `buildGcmsFigureData`'s structure.
 */
export function buildTgaFigureData(args: BuildTgaFigureArgs): FigureData {
  const {
    runs,
    xAxis,
    yAxis,
    showDtg,
    labelMarkers,
    stackRuns,
    markers,
    sourceName,
    maxTracePoints,
  } = args;
  const maxPoints = maxTracePoints ?? DEFAULT_MAX_TRACE_POINTS;

  const series: FigureSeriesData[] = [];
  const peakLabels: PeakLabelDatum[] = [];

  // x-axis label and y-axis labels follow the mode toggles.
  const onTemperature = xAxis === "temperature";
  const xLabel = onTemperature ? "Temperature (°C)" : "Time (min)";
  // Stacking shifts each run's origin but keeps the SCALE, so a step still
  // measures correctly off the ticks — the axis just no longer reads as an
  // absolute weight. Saying "offset" is the difference between a misleading
  // axis and an honest one.
  const stackSuffix = stackRuns ? ", offset" : "";
  const yLabel =
    yAxis === "weightPct" ? `Weight (%${stackSuffix})` : `Weight (mg${stackSuffix})`;
  const y2Label = `Deriv. weight (%/°C${stackSuffix})`;

  // Stack accumulators — one per axis, so a stacked figure separates the DTG
  // traces the same way it separates the mass curves instead of piling every
  // run's derivative on top of the others in the middle of the plot.
  let stackTop = 0;
  let stackTopY2 = 0;

  const markerGroup = "Analysis markers";

  for (const run of runs) {
    if (!run.visible) continue;
    const a = run.analysis;
    const xArray = onTemperature ? run.tempC : run.timeMin;
    const yArray = yAxis === "weightPct" ? a.weightPct : run.weightMg;
    // Downsample to bound the exported SVG.
    const ds = downsample({ x: xArray, y: yArray }, maxPoints);
    const xs = toNumbers(ds.x);
    let ys = applyGain(toNumbers(ds.y), run.scale, run.offset);
    const extent = finiteExtent(ys);

    // Where this run's band starts. Stacked, that is the running stack floor;
    // unstacked, the run's own minimum — so a marker drop-line spans exactly
    // the curve it annotates, in either mode and on either y-unit.
    let runFloor = extent?.min ?? 0;
    let baseline: number | undefined;
    if (stackRuns) {
      baseline = stackTop;
      runFloor = stackTop;
      const shift = stackTop - (extent?.min ?? 0);
      ys = ys.map((v) => v + shift);
      const height = (extent?.max ?? 0) - (extent?.min ?? 0);
      stackTop += height * (1 + STACK_GAP_FRACTION) || 1;
    }

    // TGA line series on the left y-axis.
    series.push({
      id: `tga:${run.id}`,
      label: run.label,
      x: xs,
      y: ys,
      ...(baseline != null ? { baseline } : {}),
      group: run.label,
      styleHints: {
        kind: "line",
        lineWidth: 1.5,
        color: run.color,
        axis: "y",
      },
    });

    // DTG line series on the right y2 axis (dashed, same colour).
    if (showDtg) {
      const dtgDs = downsample({ x: xArray, y: a.dtg }, maxPoints);
      // The run's display gain carries into its derivative — d/dT of a scaled
      // curve is scaled by the same factor — but NOT its offset, whose
      // derivative is zero. Without this a run scaled ×2 grew its mass curve
      // and left its DTG behind.
      let dtgYs = applyGain(toNumbers(dtgDs.y), run.scale, 0);
      let dtgBaseline: number | undefined;
      if (stackRuns) {
        const dExtent = finiteExtent(dtgYs);
        dtgBaseline = stackTopY2;
        const shift = stackTopY2 - (dExtent?.min ?? 0);
        dtgYs = dtgYs.map((v) => v + shift);
        const height = (dExtent?.max ?? 0) - (dExtent?.min ?? 0);
        stackTopY2 += height * (1 + STACK_GAP_FRACTION) || 1;
      }
      series.push({
        id: `dtg:${run.id}`,
        label: `${run.label} DTG`,
        x: toNumbers(dtgDs.x),
        y: dtgYs,
        ...(dtgBaseline != null ? { baseline: dtgBaseline } : {}),
        group: run.label,
        legendHidden: true,
        styleHints: {
          kind: "line",
          lineWidth: 1,
          lineStyle: "dashed",
          color: run.color,
          axis: "y2",
        },
      });
    }

    // Marker series + peak labels. Each marker is a 2-point line series
    // (legendHidden, grouped under "Analysis markers") so it appears in the
    // Series controls but never clutters the legend; the callout text is a
    // peak label (customText so the Decimals control never mangles it).
    //
    // A vertical marker runs from the run's floor to the curve, and its label
    // sits on the curve — so with several runs overlaid (or stacked) each
    // callout visibly belongs to one line. `pushVertical` is the single place
    // that geometry is decided.
    const pushVertical = (
      id: string,
      text: string,
      xv: number,
      lineStyle: "dotted" | "dashed",
    ) => {
      const top = valueAt(xs, ys, xv);
      if (top == null) return;
      series.push({
        id,
        label: text,
        x: [xv, xv],
        y: [runFloor, top],
        group: markerGroup,
        legendHidden: true,
        styleHints: { kind: "line", lineWidth: 1, lineStyle, color: run.color, axis: "y" },
      });
      if (labelMarkers) {
        peakLabels.push({
          id: `${id}:lbl`,
          x: xv,
          y: top,
          text,
          customText: true,
          seriesId: `tga:${run.id}`,
          color: run.color,
        });
      }
    };

    // Onset / endset / Tmax verticals. All three are TEMPERATURES, so they are
    // only meaningful against a temperature x-axis; in time mode they would sit
    // at arbitrary minutes, so they are withheld (the on-screen plot withholds
    // them for the same reason).
    if (onTemperature) {
      for (const step of a.steps) {
        if (markers.onset && step.tOnset != null) {
          pushVertical(
            `onset:${run.id}:${step.index}`,
            `Onset ${step.tOnset.toFixed(1)} °C`,
            step.tOnset,
            "dotted",
          );
        }
        if (markers.endset && step.tEndset != null) {
          pushVertical(
            `endset:${run.id}:${step.index}`,
            `Endset ${step.tEndset.toFixed(1)} °C`,
            step.tEndset,
            "dotted",
          );
        }
        if (markers.tmax && Number.isFinite(step.tMax)) {
          pushVertical(
            `tmax:${run.id}:${step.index}`,
            `Tmax ${step.tMax.toFixed(1)} °C`,
            step.tMax,
            "dashed",
          );
        }
      }

      // Td drop-lines (one per threshold, at the computed temperature).
      if (markers.td) {
        for (const [thresholdStr, tVal] of Object.entries(a.td)) {
          const threshold = Number(thresholdStr);
          if (tVal == null || !Number.isFinite(tVal)) continue;
          pushVertical(
            `td:${run.id}:${threshold}`,
            `T${threshold}% ${tVal.toFixed(1)} °C`,
            tVal,
            "dotted",
          );
        }
      }
    }

    // Residue level: a horizontal line at the run's own residue, in whichever
    // unit the primary axis is showing, carried through the same gain and stack
    // shift as the curve so it lands ON the curve's tail.
    if (markers.residue) {
      const raw = yAxis === "weightPct" ? a.residue.pct : a.residue.mg;
      if (Number.isFinite(raw) && xs.length > 0) {
        const level = raw * run.scale + run.offset + (stackRuns ? runFloor - (extent?.min ?? 0) : 0);
        const xLo = xs[0];
        const xHi = xs[xs.length - 1];
        series.push({
          id: `residue:${run.id}`,
          label: `Residue ${raw.toFixed(1)} ${yAxis === "weightPct" ? "%" : "mg"}`,
          x: [xLo, xHi],
          y: [level, level],
          group: markerGroup,
          legendHidden: true,
          styleHints: { kind: "line", lineWidth: 1, lineStyle: "dashed", color: run.color, axis: "y" },
        });
        if (labelMarkers) {
          peakLabels.push({
            id: `residue:${run.id}:lbl`,
            // Towards the right-hand end, where a TGA curve has levelled off —
            // mid-plot the residue line crosses the steep part of every other
            // run and the text lands on top of the curves.
            x: xLo + (xHi - xLo) * 0.86,
            y: level,
            text: `Residue ${raw.toFixed(1)} ${yAxis === "weightPct" ? "%" : "mg"}`,
            customText: true,
            seriesId: `tga:${run.id}`,
            color: run.color,
          });
        }
      }
    }
  }

  // Seed x: the first visible run's x grid (temperature or time).
  const firstVisible = runs.find((r) => r.visible);
  const seedX = firstVisible ? toNumbers(onTemperature ? firstVisible.tempC : firstVisible.timeMin) : [];

  return {
    x: seedX,
    series,
    xLabel,
    yLabel,
    y2Label: showDtg ? y2Label : undefined,
    sourceName: sourceName || firstVisible?.fileName.replace(/\.[^.]+$/, "") || "tga",
    // Always supply peakLabels (possibly empty) so the maker's "Peaks & labels"
    // section always appears — the convention both existing adapters follow.
    peakLabels: labelMarkers ? peakLabels : [],
  };
}
