// Adapter from the DSC data model to the neutral figure engine (`lib/ir/figure`,
// the shared publication-figure system used by IR, Kinetics, MALDI, GC/MS and
// TGA). Turns the visible runs (with their computed `DscAnalysis`) into the
// engine's `FigureData` shape — a heat-flow line series per run·segment on the
// left y-axis, an optional derivative or temperature-program series per run on
// the right y2-axis, and data-anchored labels for every transition callout
// (Tg onset/mid/endset, peak T/onset/endset, ΔH). Mirrors `lib/tga/figure.ts`
// closely — same shape, same "always supply peakLabels" convention, same
// "verticals live in the run's own band" marker geometry — so the hosts stay
// easy to compare. Pure data shaping; no DOM, fully unit-testable.
//
// §WP5's hard constraint: NO changes to `lib/ir/figure.ts`, `FigureSvg.tsx` or
// `FigureControls.tsx`. DSC callouts are lines + text only, exactly like TGA's
// onset/Tmax markers — no shaded regions, no new series kind.
//
// Two things this adapter has to solve that TGA's never needed to:
//
// 1. `DscAnalysis` (from `computeDscAnalysis`) only ever covers the run's
//    ACTIVE segment — a TRIOS heat→cool→heat→cool method has four, and
//    `segmentMode: "all"` asks to draw every one of them. The other three
//    segments have no computed view, so their curves are rebuilt here
//    straight from the run's raw arrays (`segmentCurve`), using the
//    SAME normalization mode and exo sign the active segment's view was
//    built with. The sign in particular isn't derivable from anything this
//    module receives (`BuildDscFigureArgs` carries no `DscParams` — the
//    figure panel only ever gets the current *display* toggles, not the
//    workspace's analysis params), so it is reverse-engineered once per run
//    from the active view via `runExoSign` — see that function's doc comment.
// 2. The figure's own `yAxis` toggle (W/g vs mW) is independent of whatever
//    `DscParams.normMode` the workspace is currently analyzing with, so a
//    conversion factor (`heatFlowScale`) is applied uniformly to every
//    segment's curve rather than trusting `run.analysis.view.heatFlow`'s
//    units to already match what the user asked to see.
//
// Markers (baseline / tangent / mark lines, ΔH labels) are drawn ONLY off the
// run's active-segment `DscFeature`s — those are the only ones with computed
// `DscFeatureResult`s (`computeDscAnalysis` only analyzes features whose
// `segmentId` matches the resolved active segment) — so a non-active segment
// drawn in "all" mode contributes a curve but never a callout.

import { polyfitDeg1 } from "@/lib/ir/numerics";
import type { FigureData, FigureSeriesData, PeakLabelDatum } from "@/lib/ir/figure";
import type { GlassResult, PeakResult } from "./compute";
import { ascendingView } from "./numerics";
import type { DscRunAnalyzed } from "./store";
import type { DscFeatureKind, DscSegment } from "./types";
import { downsample } from "./view";

/** What the figure plots on the x-axis. */
export type DscXAxis = "temperature" | "time";
/** What the figure plots on the primary y-axis. */
export type DscYAxis = "wattsPerGram" | "milliwatts";
/** What (if anything) the figure plots on the right-hand y2 axis. */
export type DscY2 = "none" | "derivative" | "program";

/** Which marker families to draw. Each is a boolean toggle in the Markers strip. */
export interface DscMarkerToggles {
  glassOnset: boolean;
  glassMid: boolean;
  glassEndset: boolean;
  peakTemp: boolean;
  peakOnset: boolean;
  peakEndset: boolean;
  baselines: boolean;
  tangents: boolean;
  enthalpyLabels: boolean;
}

export interface BuildDscFigureArgs {
  /** Visible runs, each with its computed analysis. */
  runs: DscRunAnalyzed[];
  /** X-axis mode (temperature or time). */
  xAxis: DscXAxis;
  /** Y-axis mode (heat flow in W/g or mW). */
  yAxis: DscYAxis;
  /** What to draw on the right-hand y2 axis, if anything. */
  y2: DscY2;
  /** Draw only the active segment, or every segment of every visible run. */
  segmentMode: "active" | "all";
  /** Annotate the markers with their temperature / ΔH value. */
  labelFeatures: boolean;
  /** Stack runs with a vertical offset per run (as MALDI stacks spectra). */
  stackRuns: boolean;
  /** Marker families to draw. */
  markers: DscMarkerToggles;
  /** File-name stem for downloads. */
  sourceName?: string;
  /**
   * Cap on points per run·segment before it reaches the SVG renderer,
   * min/max-bucket decimated via `downsample`. Generous — the preview
   * decimates again to the plot width, so this only bounds the *exported*
   * SVG, and an export should carry the curve the instrument recorded rather
   * than a sketch of it.
   */
  maxTracePoints?: number;
}

const DEFAULT_MAX_TRACE_POINTS = 20000;

/** Fraction of a run's own height left as clear space above it when stacking. */
const STACK_GAP_FRACTION = 0.15;

const MARKER_GROUP = "Analysis markers";

/** Convert a Float64Array to a plain number[] — the figure engine is
 *  number[]-based; the DSC data model is typed-array-based. */
function toNumbers(arr: Float64Array): number[] {
  return Array.from(arr);
}

/** Per-run display multiplier: apply the run's scale and offset exactly as
 *  the on-screen plot does (v * scale + offset), so the figure matches the
 *  screen. */
function applyGain(y: number[], scale: number, offset: number): number[] {
  if (scale === 1 && offset === 0) return y;
  return y.map((v) => v * scale + offset);
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
 * Value of a decimated curve at `xv`, linearly interpolated. Used to anchor
 * every marker on the curve it belongs to — the whole point of a callout is
 * that you can see which line it is talking about.
 *
 * Outside the recorded range it clamps to the nearest end. Null only for an
 * empty curve or an all-gap one. Copied from `lib/tga/figure.ts` — identical
 * contract.
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

function evalLine(line: { slope: number; intercept: number }, x: number): number {
  return line.slope * x + line.intercept;
}

/**
 * The exo/endo display sign currently in effect for `run`, derived from its
 * already-computed active-segment view rather than from `DscParams` (which
 * this module never receives — see the file doc comment). `exoDisplaySign`
 * in `compute.ts` depends only on `params.exoUp` and `run.meta.exoDirection`,
 * never on the segment, so the sign the active view was built with is the
 * same sign every other segment of the SAME run must use in `"all"` mode.
 *
 * Derived by comparing the sign of the analyzed active view's heat flow
 * against the matching raw sample: dividing by a positive mass never flips
 * sign, so `sign(normalized[i]) === sign(raw[i])` regardless of normalization
 * mode, and the ONLY thing that can flip it from there is the display sign
 * that was applied. Falls back to the default `exoUp = true` convention
 * (`meta.exoDirection === "up"` ⇒ +1) when the active view is empty or every
 * sample lines up as zero/non-finite.
 */
function runExoSign(run: DscRunAnalyzed): 1 | -1 {
  const view = run.analysis.view;
  const fallback: 1 | -1 = run.meta.exoDirection === "up" ? 1 : -1;
  if (view.tempC.length === 0) return fallback;
  const rawAligned = ascendingView(run.heatFlowMw, view.segStart, view.segEnd, view.reversed);
  const n = Math.min(view.heatFlow.length, rawAligned.length);
  for (let i = 0; i < n; i += 1) {
    const displayed = view.heatFlow[i];
    const raw = rawAligned[i];
    if (Number.isFinite(displayed) && Number.isFinite(raw) && displayed !== 0 && raw !== 0) {
      return Math.sign(displayed) === Math.sign(raw) ? 1 : -1;
    }
  }
  return fallback;
}

/**
 * Conversion factor from the units `run.analysis.view.heatFlow` is already
 * in (whatever `DscParams.normMode` the workspace is currently analyzing
 * with) to the figure's own `yAxis` choice. A no-op (1) when they already
 * agree. `W/g -> mW` multiplies by the exact mass divisor `computeDscAnalysis`
 * used (`normDivisorMg`, only ever set when that mass was valid); `mW -> W/g`
 * divides by the run's resolved mass, falling back to 1 (no conversion, same
 * as `toWattsPerGram`'s own fallback) when no valid mass is available.
 */
function heatFlowScale(run: DscRunAnalyzed, yAxis: DscYAxis): number {
  const normIsWattsPerGram = run.analysis.view.normMode === "wattsPerGram";
  if (normIsWattsPerGram === (yAxis === "wattsPerGram")) return 1;
  if (normIsWattsPerGram && yAxis === "milliwatts") {
    const mass = run.analysis.normDivisorMg;
    return mass != null && mass > 0 ? mass : 1;
  }
  // normMode is "raw" (mW) but the figure wants W/g.
  const mass = run.massOverrideMg ?? run.meta.sampleMassMg;
  return mass != null && Number.isFinite(mass) && mass > 0 ? 1 / mass : 1;
}

/** One segment's temperature / time / heat-flow arrays, in the SAME
 *  normalization mode + exo sign as `run.analysis.view` (but NOT yet scaled
 *  to the figure's `yAxis`, nor gained by `run.scale`/`run.offset` — the
 *  caller applies both uniformly to every segment of a run). */
interface RawSegmentCurve {
  tempC: Float64Array;
  timeMin: Float64Array;
  heatFlow: Float64Array;
}

/**
 * Build a segment's curve for the figure. The run's own active segment reuses
 * `run.analysis.view` directly (already normalized + signed by the real
 * `computeDscAnalysis` call, so markers anchored on it line up exactly); any
 * OTHER segment (only ever requested in `segmentMode: "all"`) is rebuilt from
 * the run's raw arrays using the same normalization mode and the sign
 * `runExoSign` recovered.
 */
function segmentCurve(
  run: DscRunAnalyzed,
  segment: DscSegment,
  isActive: boolean,
  sign: 1 | -1,
): RawSegmentCurve | null {
  if (isActive) {
    const view = run.analysis.view;
    if (view.tempC.length === 0) return null;
    return { tempC: view.tempC, timeMin: view.timeMin, heatFlow: view.heatFlow };
  }
  const n0 = Math.min(run.tempC.length, run.timeMin.length, run.heatFlowMw.length);
  const start = Math.max(0, Math.min(segment.start, n0));
  const end = Math.max(start, Math.min(segment.end, n0));
  if (end - start < 2) return null;
  const reversed = run.tempC[start] > run.tempC[end - 1];
  const tempC = ascendingView(run.tempC, start, end, reversed);
  const timeMin = ascendingView(run.timeMin, start, end, reversed);
  const rawMw = ascendingView(run.heatFlowMw, start, end, reversed);
  const normIsWattsPerGram = run.analysis.view.normMode === "wattsPerGram";
  const mass = run.massOverrideMg ?? run.meta.sampleMassMg;
  const useMass = normIsWattsPerGram && mass != null && Number.isFinite(mass) && mass > 0;
  const heatFlow = new Float64Array(rawMw.length);
  for (let i = 0; i < heatFlow.length; i += 1) {
    const normalized = useMass ? rawMw[i] / (mass as number) : rawMw[i];
    heatFlow[i] = sign * normalized;
  }
  return { tempC, timeMin, heatFlow };
}

/** Short temperature-axis prefix for a peak-family feature kind's callouts,
 *  mirroring the plot overlay's convention (`Tm`, `Tc`, …). */
function peakPrefix(kind: DscFeatureKind): string {
  switch (kind) {
    case "melt":
      return "Tm";
    case "crystallization":
      return "Tc";
    case "coldCrystallization":
      return "Tcc";
    case "cure":
      return "Tcure";
    default:
      return "T";
  }
}

/** Nearest index in the ascending array `xs` to `xv` (binary search). */
function nearestIndex(xs: number[], xv: number): number {
  const n = xs.length;
  if (n === 0) return -1;
  if (xv <= xs[0]) return 0;
  if (xv >= xs[n - 1]) return n - 1;
  let a = 0;
  let b = n - 1;
  while (b - a > 1) {
    const m = (a + b) >> 1;
    if (xs[m] <= xv) a = m;
    else b = m;
  }
  return xv - xs[a] <= xs[b] - xv ? a : b;
}

/** A local ±5-point least-squares tangent through the drawn curve nearest
 *  `xv` — the same local-fit idea `peakTransition`'s `tangentBaselineIntersect`
 *  uses internally, rebuilt here from the curve this module already has
 *  (compute.ts does not return the fitted tangent lines it used, only the
 *  intersection x). Returns the line plus the x-span of the points it was
 *  fit over, so the caller can draw it across exactly that span. */
function localTangent(
  xs: number[],
  ys: number[],
  xv: number,
): { line: { slope: number; intercept: number }; x0: number; x1: number } | null {
  const idx = nearestIndex(xs, xv);
  if (idx < 0) return null;
  const lo = Math.max(0, idx - 5);
  const hi = Math.min(xs.length - 1, idx + 5);
  const xw: number[] = [];
  const yw: number[] = [];
  for (let i = lo; i <= hi; i += 1) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) {
      xw.push(xs[i]);
      yw.push(ys[i]);
    }
  }
  if (xw.length < 2) return null;
  const line = polyfitDeg1(xw, yw);
  if (!Number.isFinite(line.slope)) return null;
  return { line, x0: xw[0], x1: xw[xw.length - 1] };
}

/**
 * Build the figure-engine data for the DSC publication figure: one heat-flow
 * line series per visible run·segment on the left y-axis, an optional
 * derivative or temperature-program series per run on the right y2-axis,
 * marker series (legendHidden, grouped "Analysis markers") for every
 * transition callout, and data-anchored peak labels for the ones the user
 * asked to see. Follows `buildTgaFigureData`'s structure.
 */
export function buildDscFigureData(args: BuildDscFigureArgs): FigureData {
  const { runs, xAxis, yAxis, y2, segmentMode, labelFeatures, stackRuns, markers, sourceName, maxTracePoints } =
    args;
  const maxPoints = maxTracePoints ?? DEFAULT_MAX_TRACE_POINTS;
  const onTemperature = xAxis === "temperature";

  const series: FigureSeriesData[] = [];
  const peakLabels: PeakLabelDatum[] = [];

  const stackSuffix = stackRuns ? ", offset" : "";
  const xLabel = onTemperature ? "Temperature (°C)" : "Time (min)";
  const yUnit = yAxis === "wattsPerGram" ? "W/g" : "mW";
  const yLabel = `Heat flow (${yUnit}${stackSuffix})`;

  // The derivative's units follow whatever normMode the workspace is
  // currently analyzing with (it is a straight index-domain derivative of
  // `view.heatFlow`, so it inherits that array's units exactly) — NOT the
  // figure's own `yAxis` toggle, exactly like TGA's DTG axis stays %/°C
  // regardless of the weight axis being % or mg.
  const firstVisible = runs.find((r) => r.visible);
  const derivUnit = firstVisible?.analysis.view.normMode === "raw" ? "mW" : "W/g";
  const y2Label =
    y2 === "derivative"
      ? `Deriv. heat flow (${derivUnit}/°C${stackSuffix})`
      : y2 === "program" && !onTemperature
        ? `Temperature (°C${stackSuffix})`
        : undefined;

  let stackTop = 0;
  let stackTopY2 = 0;

  for (const run of runs) {
    if (!run.visible) continue;
    const activeSegmentId = run.analysis.segmentId;
    const activeSegment = run.segments.find((s) => s.id === activeSegmentId) ?? null;
    const segmentsToDraw =
      segmentMode === "active" ? (activeSegment ? [activeSegment] : []) : run.segments;
    if (segmentsToDraw.length === 0) continue;

    const sign = runExoSign(run);
    const scale = heatFlowScale(run, yAxis);

    // Build every segment's curve (still un-gained, un-stacked) so a
    // multi-segment run's stack band spans ALL of its drawn segments, not
    // just whichever one happens to be active.
    const built: { segment: DscSegment; isActive: boolean; x: number[]; y: number[] }[] = [];
    for (const segment of segmentsToDraw) {
      const isActive = segment.id === activeSegmentId;
      const curve = segmentCurve(run, segment, isActive, sign);
      if (!curve) continue;
      const xArr = onTemperature ? curve.tempC : curve.timeMin;
      const yArr = new Float64Array(curve.heatFlow.length);
      for (let i = 0; i < yArr.length; i += 1) yArr[i] = curve.heatFlow[i] * scale;
      const ds = downsample({ x: xArr, y: yArr }, maxPoints);
      const xs = toNumbers(ds.x);
      const ys = applyGain(toNumbers(ds.y), run.scale, run.offset);
      built.push({ segment, isActive, x: xs, y: ys });
    }
    if (built.length === 0) continue;

    // Combined extent across every drawn segment of this run — the run's
    // OWN band, whether stacked or not.
    let combinedMin = Infinity;
    let combinedMax = -Infinity;
    for (const b of built) {
      const ext = finiteExtent(b.y);
      if (!ext) continue;
      if (ext.min < combinedMin) combinedMin = ext.min;
      if (ext.max > combinedMax) combinedMax = ext.max;
    }
    const hasExtent = Number.isFinite(combinedMin) && Number.isFinite(combinedMax);

    let runFloor = hasExtent ? combinedMin : 0;
    let bandBaseline: number | undefined;
    let shift = 0;
    if (stackRuns) {
      bandBaseline = stackTop;
      shift = stackTop - (hasExtent ? combinedMin : 0);
      runFloor = stackTop;
      const height = hasExtent ? combinedMax - combinedMin : 0;
      stackTop += height * (1 + STACK_GAP_FRACTION) || 1;
    }

    let activeCurve: { x: number[]; y: number[] } | null = null;
    for (const b of built) {
      const ys = stackRuns ? b.y.map((v) => v + shift) : b.y;
      const isCooling = segmentMode === "all" && b.segment.kind === "cool";
      series.push({
        id: `dsc:${run.id}:${b.segment.id}`,
        label: segmentMode === "all" ? `${run.label} · ${b.segment.label}` : run.label,
        x: b.x,
        y: ys,
        ...(bandBaseline != null ? { baseline: bandBaseline } : {}),
        group: run.label,
        styleHints: {
          kind: "line",
          lineWidth: 1.6,
          color: run.color,
          axis: "y",
          ...(isCooling ? { lineStyle: "dashed" as const } : {}),
        },
      });
      if (b.isActive) activeCurve = { x: b.x, y: ys };
    }

    // Derivative series — the active segment only (no other segment has a
    // computed derivative to draw).
    if (y2 === "derivative" && activeSegment) {
      const view = run.analysis.view;
      const deriv = run.analysis.deriv;
      if (view.tempC.length > 0 && deriv.length > 0) {
        const xFull = onTemperature ? view.tempC : view.timeMin;
        const ds = downsample({ x: xFull, y: deriv }, maxPoints);
        // The run's display gain carries into its derivative — d/dT of a
        // scaled curve is scaled by the same factor — but NOT its offset,
        // whose derivative is zero. Mirrors TGA's DTG gain note exactly.
        let ys = toNumbers(ds.y).map((v) => v * run.scale);
        let derivBaseline: number | undefined;
        if (stackRuns) {
          const ext = finiteExtent(ys);
          derivBaseline = stackTopY2;
          const shiftY2 = stackTopY2 - (ext?.min ?? 0);
          ys = ys.map((v) => v + shiftY2);
          const height = (ext?.max ?? 0) - (ext?.min ?? 0);
          stackTopY2 += height * (1 + STACK_GAP_FRACTION) || 1;
        }
        series.push({
          id: `deriv:${run.id}:${activeSegment.id}`,
          label: `${run.label} dHF/dT`,
          x: toNumbers(ds.x),
          y: ys,
          ...(derivBaseline != null ? { baseline: derivBaseline } : {}),
          group: run.label,
          legendHidden: true,
          styleHints: { kind: "line", lineWidth: 1, lineStyle: "dashed", color: run.color, axis: "y2" },
        });
      }
    }

    // Temperature-program series — the WHOLE run's temperature vs time
    // (every segment, not just the drawn ones), only meaningful in time mode.
    if (y2 === "program" && !onTemperature) {
      const ds = downsample({ x: run.timeMin, y: run.tempC }, maxPoints);
      let ys = toNumbers(ds.y);
      let progBaseline: number | undefined;
      if (stackRuns) {
        const ext = finiteExtent(ys);
        progBaseline = stackTopY2;
        const shiftY2 = stackTopY2 - (ext?.min ?? 0);
        ys = ys.map((v) => v + shiftY2);
        const height = (ext?.max ?? 0) - (ext?.min ?? 0);
        stackTopY2 += height * (1 + STACK_GAP_FRACTION) || 1;
      }
      series.push({
        id: `program:${run.id}`,
        label: `${run.label} program`,
        x: toNumbers(ds.x),
        y: ys,
        ...(progBaseline != null ? { baseline: progBaseline } : {}),
        group: run.label,
        legendHidden: true,
        styleHints: { kind: "line", lineWidth: 1, lineStyle: "dotted", color: run.color, axis: "y2" },
      });
    }

    // Markers — the active segment's features only, and only meaningful
    // against a temperature axis (every window/onset/peak/endset is a
    // temperature; against minutes they'd sit at arbitrary positions, so
    // they are withheld exactly like TGA withholds its temperature markers
    // on a time axis).
    if (onTemperature && activeSegment && activeCurve) {
      const curveSeriesId = `dsc:${run.id}:${activeSegment.id}`;
      const activeFeatures = run.features.filter((f) => f.segmentId === activeSegmentId);

      // `GlassResult`/`PeakResult` lines (preLine/postLine/inflLine/baseline)
      // are evaluated in the ANALYSIS-space heat-flow units — whatever
      // `DscParams.normMode` the workspace is analyzing with — not in the
      // figure's own drawn units. The curve itself goes through
      // `* heatFlowScale * run.scale + run.offset (+ stack shift)` to get
      // from analysis space to what's actually drawn (see the per-segment
      // loop above); every marker built by evaluating one of those lines
      // directly must go through the exact same transform, or it lands off
      // the curve the moment yAxis disagrees with normMode, or a run has a
      // display gain, or runs are stacked.
      const toDrawnY = (yAnalysis: number) => yAnalysis * scale * run.scale + run.offset + shift;

      const pushMark = (
        featureId: string,
        suffix: "onset" | "mid" | "peak" | "endset",
        xv: number | null,
        text: string,
        // The feature's own baseline evaluated at `xv` (already in DRAWN
        // units, via `toDrawnY`) — when given, the mark spans apex→baseline
        // instead of apex→run floor, matching the on-screen plot overlay's
        // fix for the same "Tm sits at the bottom of the chart" bug. `null`
        // (a glass mark, or a peak with no fitted baseline) keeps today's
        // run-floor behaviour.
        bottomY?: number,
      ) => {
        if (xv == null) return;
        const top = valueAt(activeCurve!.x, activeCurve!.y, xv);
        if (top == null) return;
        const bottom = bottomY ?? runFloor;
        series.push({
          id: `mark:${featureId}:${suffix}`,
          label: text,
          x: [xv, xv],
          y: [bottom, top],
          group: MARKER_GROUP,
          legendHidden: true,
          styleHints: { kind: "line", lineWidth: 1, lineStyle: "dotted", color: run.color, axis: "y" },
        });
        if (labelFeatures) {
          // Midway down the apex-to-baseline span for the "peak" callout
          // (Tm/Tc/…) — "midway down the slope", matching the on-screen
          // overlay's fix — not at the apex. Onset/endset callouts (and any
          // glass mark) stay curve-anchored: they mark a specific transition
          // POINT, not a peak, so there's no analogous "half of a slope"
          // reading for them.
          const labelY = suffix === "peak" && bottomY != null ? (bottom + top) / 2 : top;
          peakLabels.push({
            id: `mark:${featureId}:${suffix}:lbl`,
            x: xv,
            y: labelY,
            text,
            customText: true,
            seriesId: curveSeriesId,
            color: run.color,
          });
        }
      };

      const pushLine = (id: string, x0: number, y0: number, x1: number, y1: number) => {
        if (![x0, y0, x1, y1].every(Number.isFinite)) return;
        series.push({
          id,
          label: id,
          x: [x0, x1],
          y: [y0, y1],
          group: MARKER_GROUP,
          legendHidden: true,
          styleHints: { kind: "line", lineWidth: 1, lineStyle: "solid", color: run.color, axis: "y" },
        });
      };

      const pushGlassTangents = (featureId: string, g: GlassResult, window: [number, number]) => {
        const wLo = Math.min(window[0], window[1]);
        const wHi = Math.max(window[0], window[1]);
        const width = wHi - wLo;
        if (g.preLine) {
          const x0 = wLo;
          const x1 = wLo + 0.3 * width;
          pushLine(
            `tangent:${featureId}:pre`,
            x0,
            toDrawnY(evalLine(g.preLine, x0)),
            x1,
            toDrawnY(evalLine(g.preLine, x1)),
          );
        }
        if (g.postLine) {
          const x0 = wHi - 0.3 * width;
          const x1 = wHi;
          pushLine(
            `tangent:${featureId}:post`,
            x0,
            toDrawnY(evalLine(g.postLine, x0)),
            x1,
            toDrawnY(evalLine(g.postLine, x1)),
          );
        }
        if (g.inflLine && g.inflectionC != null) {
          const half = Math.max(0.05 * width, 1e-6);
          const x0 = Math.max(wLo, g.inflectionC - half);
          const x1 = Math.min(wHi, g.inflectionC + half);
          pushLine(
            `tangent:${featureId}:infl`,
            x0,
            toDrawnY(evalLine(g.inflLine, x0)),
            x1,
            toDrawnY(evalLine(g.inflLine, x1)),
          );
        }
      };

      const pushPeakTangents = (featureId: string, p: PeakResult) => {
        if (p.onsetC != null) {
          const t = localTangent(activeCurve!.x, activeCurve!.y, p.onsetC);
          if (t) pushLine(`tangent:${featureId}:lead`, t.x0, evalLine(t.line, t.x0), t.x1, evalLine(t.line, t.x1));
        }
        if (p.endsetC != null) {
          const t = localTangent(activeCurve!.x, activeCurve!.y, p.endsetC);
          if (t) pushLine(`tangent:${featureId}:trail`, t.x0, evalLine(t.line, t.x0), t.x1, evalLine(t.line, t.x1));
        }
      };

      for (const feature of activeFeatures) {
        const result = run.analysis.results[feature.id];
        if (!result) continue;

        // Qualify every marker/baseline/tangent/label id with `run.id`, not
        // just `feature.id`. A feature's id is derived from its segment id,
        // which is itself derived from the run's sample name rather than a
        // globally-unique run id (§WP1.3/1.4) — two runs sharing a sample
        // name (a `.tri` and `.xls` export of the same run, or replicate
        // samples) legitimately produce the SAME feature id. Left
        // unqualified, two such runs shown together would collide in the
        // shared `series`/`peakLabels` arrays the figure engine keys
        // styling off of. `run.analysis.results` below stays keyed by the
        // bare `feature.id` — that lookup is already per-run-scoped.
        const rid = `${run.id}:${feature.id}`;

        if (result.kind === "glass") {
          const g = result.glass;
          if (markers.glassOnset) pushMark(rid, "onset", g.onsetC, `Tg onset ${g.onsetC?.toFixed(1)} °C`);
          if (markers.glassMid) pushMark(rid, "mid", g.midpointC, `Tg ${g.midpointC?.toFixed(1)} °C`);
          if (markers.glassEndset)
            pushMark(rid, "endset", g.endsetC, `Tg endset ${g.endsetC?.toFixed(1)} °C`);
          if (markers.tangents) pushGlassTangents(rid, g, feature.window);
        } else if (result.kind === "oit") {
          // OIT is a time-domain (isothermal) result — none of the marker
          // toggles above describe how to draw it, and it has no
          // temperature to anchor on, so it is intentionally not drawn.
          continue;
        } else {
          const p = result.peak;
          const prefix = peakPrefix(feature.kind);
          // The feature's own baseline, evaluated at `xv` and converted to
          // drawn units — `undefined` (no fitted baseline) keeps `pushMark`'s
          // run-floor fallback.
          const baselineAt = (xv: number | null): number | undefined =>
            xv != null && p.baseline ? toDrawnY(evalLine(p.baseline, xv)) : undefined;
          if (markers.peakTemp)
            pushMark(rid, "peak", p.peakC, `${prefix} ${p.peakC?.toFixed(1)} °C`, baselineAt(p.peakC));
          if (markers.peakOnset)
            pushMark(rid, "onset", p.onsetC, `${prefix} onset ${p.onsetC?.toFixed(1)} °C`, baselineAt(p.onsetC));
          if (markers.peakEndset)
            pushMark(rid, "endset", p.endsetC, `${prefix} endset ${p.endsetC?.toFixed(1)} °C`, baselineAt(p.endsetC));
          if (markers.baselines && p.baseline) {
            const wLo = Math.min(feature.window[0], feature.window[1]);
            const wHi = Math.max(feature.window[0], feature.window[1]);
            pushLine(
              `baseline:${rid}`,
              wLo,
              toDrawnY(evalLine(p.baseline, wLo)),
              wHi,
              toDrawnY(evalLine(p.baseline, wHi)),
            );
          }
          if (markers.tangents) pushPeakTangents(rid, p);
          if (labelFeatures && markers.enthalpyLabels && p.enthalpyJPerG != null) {
            const anchorX = p.peakC ?? (feature.window[0] + feature.window[1]) / 2;
            const anchorY = valueAt(activeCurve.x, activeCurve.y, anchorX) ?? runFloor;
            peakLabels.push({
              id: `enthalpy:${rid}:lbl`,
              x: anchorX,
              y: anchorY,
              text: `ΔH ${p.enthalpyJPerG.toFixed(1)} J/g`,
              customText: true,
              seriesId: curveSeriesId,
              color: run.color,
            });
          }
        }
      }
    }
  }

  const seedX =
    firstVisible && firstVisible.analysis.view.tempC.length > 0
      ? toNumbers(onTemperature ? firstVisible.analysis.view.tempC : firstVisible.analysis.view.timeMin)
      : [];

  return {
    x: seedX,
    series,
    xLabel,
    yLabel,
    y2Label,
    sourceName: sourceName || firstVisible?.fileName.replace(/\.[^.]+$/, "") || "dsc",
    // Always supply peakLabels (possibly empty) so the maker's "Peaks &
    // labels" section always appears — the convention every adapter follows.
    peakLabels,
  };
}
