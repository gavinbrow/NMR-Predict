// DSC compute engine — pure functions over Float64Arrays (§WP3 of the plan).
//
// Implements the ascending segment view, W/g normalization + exo/endo sign,
// the index-domain heat-flow derivative, ASTM E1356 glass transition
// (onset/midpoint/endset/Δcp), peak integration (melt/crystallization/cold
// crystallization/cure), auto-detection, % crystallinity, degree of cure and
// OIT, and the top-level `computeDscAnalysis` orchestrator. Nothing here
// mutates its inputs and nothing throws — every failure becomes a warning
// string in the returned `DscAnalysis`, exactly like `lib/tga/compute.ts`.
//
// A handful of types below (`SegmentView`, `GlassResult`, `PeakResult`,
// `DscFeatureResult`, `DscAnalysis`) are declared here rather than in
// `types.ts` — WP1 owns that file and only sketched the compute engine's
// contract in the plan's prose, not as concrete exports.

import { polyfitDeg1 } from "@/lib/ir/numerics";
import { smoothSG } from "@/lib/gcms/numerics";
import {
  argmax,
  ascendingView,
  clampWindow,
  fwhm,
  lineIntersectionX,
  localMaximumIndex,
  localMinimumIndex,
  lowerBound,
  mean,
  upperBound,
} from "./numerics";
import { allReferences, crystallinity } from "./references";
import { defaultSegmentId } from "./segments";
import {
  DEFAULT_PARAMS,
  type DscFeature,
  type DscFeatureKind,
  type DscParams,
  type DscRun,
  type DscSegment,
} from "./types";

// Re-export §3.7's crystallinity calculator so callers can get every WP3
// compute function from one module. WP1 already implemented it in
// `references.ts` alongside the ΔH°100 library it draws from — do not
// duplicate it here.
export { crystallinity };

/** A simple line, y = slope*x + intercept. */
interface Line {
  slope: number;
  intercept: number;
}

// ---------------------------------------------------------------------------
// §3.1 Segment view
// ---------------------------------------------------------------------------

/**
 * One segment's data, reshaped for analysis: ascending temperature order (a
 * cooling segment is reversed), heat flow normalized and sign-applied per
 * §3.2.
 *
 * Five fields beyond the plan's literal `{ tempC, heatFlow, timeMin,
 * reversed, rateCPerSec }` are carried here so `glassTransition`,
 * `peakTransition`, `autoDetectFeatures` and `oxidativeInductionTime` stay
 * pure functions of `(view, ...)` alone, without needing `params` or the
 * owning `DscSegment` threaded into every call:
 *  - `normMode`/`smoothWindow` — the settings this view was built with, so
 *    §3.4.6's raw-mode Δcp null-out and every internal dHF/dT still respect
 *    the caller's actual `params` instead of a hardcoded default.
 *  - `segStart`/`segEnd`/`rawTimeMin` — the raw index bounds and the
 *    UN-reversed time axis for those bounds, so §3.5.4's enthalpy
 *    integration can walk the run's ORIGINAL acquisition order even though
 *    `timeMin` above is reversed in lockstep with `tempC` for a cooling
 *    segment.
 */
export interface SegmentView {
  tempC: Float64Array; // ASCENDING (a cooling segment is reversed)
  heatFlow: Float64Array; // W/g (or mW if normMode === "raw"), sign applied
  timeMin: Float64Array; // reversed alongside tempC when the segment cools
  reversed: boolean;
  rateCPerSec: number; // |dT/dt|, least-squares fit of T vs t over the segment
  normMode: DscParams["normMode"];
  segStart: number; // raw index into the run's arrays (inclusive)
  segEnd: number; // raw index into the run's arrays (exclusive)
  rawTimeMin: Float64Array; // run.timeMin[segStart, segEnd) — NEVER reversed
  smoothWindow: number; // params.smoothWindow this view was built with
}

const EMPTY_VIEW: SegmentView = {
  tempC: new Float64Array(0),
  heatFlow: new Float64Array(0),
  timeMin: new Float64Array(0),
  reversed: false,
  rateCPerSec: 0,
  normMode: DEFAULT_PARAMS.normMode,
  segStart: 0,
  segEnd: 0,
  rawTimeMin: new Float64Array(0),
  smoothWindow: DEFAULT_PARAMS.smoothWindow,
};

/** Resolve the sample mass to normalize with: the user's override when set,
 *  else the parsed metadata value. */
function resolveSampleMassMg(run: DscRun): number | null {
  return run.massOverrideMg ?? run.meta.sampleMassMg;
}

/** Least-squares |dT/dt| (°C/s) over `run`'s raw arrays in `[start, end)`. */
function computeRampRate(timeMin: Float64Array, tempC: Float64Array, start: number, end: number): number {
  const n = end - start;
  if (n < 2) return 0;
  const tSec = new Array<number>(n);
  const temp = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    tSec[i] = timeMin[start + i] * 60;
    temp[i] = tempC[start + i];
  }
  const { slope } = polyfitDeg1(tSec, temp);
  return Number.isFinite(slope) ? Math.abs(slope) : 0;
}

/**
 * Build the ascending-temperature view of one segment: normalize heat flow
 * (§3.2) and apply the exo/endo display sign. Every downstream construction
 * (derivative, glass, peaks, auto-detect) runs on this view so one code path
 * serves heating and cooling.
 *
 * ⚠️ Enthalpy integration (§3.5.4) must NOT use this view's `timeMin` — it is
 * reversed alongside `tempC` for a cooling segment. Use `segStart`/`segEnd`/
 * `rawTimeMin` instead, which this function also populates.
 */
export function segmentView(run: DscRun, segment: DscSegment, params: DscParams): SegmentView {
  const n0 = Math.min(run.tempC.length, run.timeMin.length, run.heatFlowMw.length);
  const start = Math.max(0, Math.min(segment.start, n0));
  const end = Math.max(start, Math.min(segment.end, n0));
  if (end - start < 2) {
    return { ...EMPTY_VIEW, segStart: start, segEnd: start, normMode: params.normMode, smoothWindow: params.smoothWindow };
  }

  // Decided once, applied in lockstep to every parallel array (per
  // `ascendingView`'s contract).
  const reversed = run.tempC[start] > run.tempC[end - 1];

  const tempC = ascendingView(run.tempC, start, end, reversed);
  const timeMin = ascendingView(run.timeMin, start, end, reversed);
  const rawMw = ascendingView(run.heatFlowMw, start, end, reversed);

  const mass = resolveSampleMassMg(run);
  const normalized =
    params.normMode === "raw" ? { heatFlow: Float64Array.from(rawMw), warning: null } : toWattsPerGram(rawMw, mass);

  const sign = exoDisplaySign(run, params);
  const heatFlow = new Float64Array(normalized.heatFlow.length);
  for (let i = 0; i < heatFlow.length; i += 1) heatFlow[i] = sign * normalized.heatFlow[i];

  const rateCPerSec = computeRampRate(run.timeMin, run.tempC, start, end);

  return {
    tempC,
    heatFlow,
    timeMin,
    reversed,
    rateCPerSec,
    normMode: params.normMode,
    segStart: start,
    segEnd: end,
    rawTimeMin: run.timeMin.subarray(start, end),
    smoothWindow: params.smoothWindow,
  };
}

// ---------------------------------------------------------------------------
// §3.2 Normalization and sign
// ---------------------------------------------------------------------------

export interface NormalizedHeatFlow {
  heatFlow: Float64Array;
  divisorMg: number | null;
  warning: string | null;
}

/**
 * `W/g = mW / mg`, exact division, no scaling factor. When `sampleMassMg` is
 * null, non-finite or ≤ 0, falls back to raw mW and reports the warning the
 * UI should surface — enter a mass to normalize.
 *
 * Deviates from the plan's literal `(heatFlowMw, sampleMassMg): Float64Array`
 * signature by returning `{ heatFlow, divisorMg, warning }` — the plan's own
 * prose requires surfacing a warning on the null-mass fallback, which a bare
 * `Float64Array` return has no channel for.
 */
export function toWattsPerGram(heatFlowMw: Float64Array, sampleMassMg: number | null): NormalizedHeatFlow {
  if (sampleMassMg == null || !Number.isFinite(sampleMassMg) || sampleMassMg <= 0) {
    return {
      heatFlow: Float64Array.from(heatFlowMw),
      divisorMg: null,
      warning: "No sample mass — heat flow shown in mW; enter a mass to normalize.",
    };
  }
  const n = heatFlowMw.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) out[i] = heatFlowMw[i] / sampleMassMg;
  return { heatFlow: out, divisorMg: sampleMassMg, warning: null };
}

/**
 * Display sign for heat flow: `+1` when the user's `exoUp` display choice
 * agrees with the file's own exo convention, `−1` when it disagrees (so the
 * signal is flipped to match what the user wants to see as "up").
 */
export function exoDisplaySign(run: DscRun, params: DscParams): 1 | -1 {
  return params.exoUp === (run.meta.exoDirection === "up") ? 1 : -1;
}

// ---------------------------------------------------------------------------
// Small local helpers shared by the sections below
// ---------------------------------------------------------------------------

/** Median of |v| over the finite, non-zero entries. Mirrors
 *  `lib/tga/compute.ts`'s `medianAbs` — median rather than mean so a long
 *  isothermal hold or a few spikes can't move it. */
function medianAbs(values: Float64Array): number {
  const mags: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const v = Math.abs(values[i]);
    if (Number.isFinite(v) && v > 0) mags.push(v);
  }
  if (mags.length === 0) return 0;
  mags.sort((a, b) => a - b);
  return mags[mags.length >> 1];
}

/** Elementwise |arr|, for feeding `argmax` when the caller needs the index
 *  of the largest MAGNITUDE rather than the largest signed value. */
function absArray(arr: Float64Array): Float64Array {
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i += 1) out[i] = Math.abs(arr[i]);
  return out;
}

function evalLine(line: Line, x: number): number {
  return line.slope * x + line.intercept;
}

/** Least-squares line through `xs[lo..hi]`/`ys[lo..hi]` (inclusive), skipping
 *  non-finite pairs. `{ slope: NaN, intercept: NaN }` when fewer than 2
 *  finite points remain — mirrors `lib/tga/compute.ts`'s `polyfitWindow`. */
function fitLine(xs: Float64Array, ys: Float64Array, lo: number, hi: number): Line {
  const n = Math.min(xs.length, ys.length);
  const a = Math.max(0, Math.min(lo, n - 1));
  const b = Math.max(a, Math.min(hi, n - 1));
  const x: number[] = [];
  const y: number[] = [];
  for (let i = a; i <= b; i += 1) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) {
      x.push(xs[i]);
      y.push(ys[i]);
    }
  }
  if (x.length < 2) return { slope: NaN, intercept: NaN };
  return polyfitDeg1(x, y);
}

/** The two-point line through `(x0, y0)` and `(x1, y1)`. Degenerates to a
 *  flat line at `y0` when the x's coincide. */
function lineThrough(x0: number, y0: number, x1: number, y1: number): Line {
  if (!Number.isFinite(x0) || !Number.isFinite(x1) || Math.abs(x1 - x0) < 1e-12) {
    return { slope: 0, intercept: Number.isFinite(y0) ? y0 : NaN };
  }
  const slope = (y1 - y0) / (x1 - x0);
  return { slope, intercept: y0 - slope * x0 };
}

/** Mean of the `k` points of `ys` whose `xs` is nearest `target`. `xs` must
 *  be ascending (every caller passes a `SegmentView.tempC`). Used for
 *  peak-baseline anchors (§3.5.1), which are evaluated at the mean of the 5
 *  points nearest each anchor for noise resistance. */
function nearestMeanY(xs: Float64Array, ys: Float64Array, target: number, k: number): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n === 0) return null;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  let left = lo - 1;
  let right = lo;
  let sum = 0;
  let count = 0;
  while (count < k && (left >= 0 || right < n)) {
    const useLeft = right >= n || (left >= 0 && Math.abs(xs[left] - target) <= Math.abs(xs[right] - target));
    const i = useLeft ? left : right;
    if (useLeft) left -= 1;
    else right += 1;
    if (Number.isFinite(ys[i])) {
      sum += ys[i];
      count += 1;
    }
  }
  return count > 0 ? sum / count : null;
}

/** `NaN` → `null`, otherwise pass through. `lineIntersectionX` returns `NaN`
 *  for near-parallel lines; the UI should print "—", not a wild
 *  extrapolation (§3.4.4). */
function nanToNull(x: number): number | null {
  return Number.isFinite(x) ? x : null;
}

// ---------------------------------------------------------------------------
// §3.3 Derivative
// ---------------------------------------------------------------------------

/**
 * `dHF/dT = (dHF/di) / (dT/di)`, both from `smoothSG(arr, window, 2, 1)` —
 * the index-domain trick `lib/tga/compute.ts` uses for the same reason
 * (non-uniform T grid). The denominator is guarded by a RELATIVE floor,
 * `max(1e-12, 0.05 * medianAbs(dTdi))`; points below it are `NaN`, which the
 * renderer already draws as a gap. Also all-`NaN` when the segment's
 * temperature span is under 1 °C (isothermal — dHF/dT is not meaningful).
 */
export function computeDerivative(view: SegmentView, smoothWindow: number): Float64Array {
  const n = Math.min(view.tempC.length, view.heatFlow.length);
  const out = new Float64Array(n).fill(NaN);
  if (n === 0) return out;

  let tMin = Infinity;
  let tMax = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const t = view.tempC[i];
    if (Number.isFinite(t)) {
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
  }
  if (!(tMax - tMin >= 1)) return out; // isothermal span

  const w = clampWindow(smoothWindow, n);
  const dHFdi = smoothSG(view.heatFlow.subarray(0, n), w, 2, 1);
  const dTdi = smoothSG(view.tempC.subarray(0, n), w, 2, 1);
  const floor = Math.max(1e-12, 0.05 * medianAbs(dTdi));
  for (let i = 0; i < n; i += 1) {
    out[i] = Math.abs(dTdi[i]) < floor ? NaN : dHFdi[i] / dTdi[i];
  }
  return out;
}

/** `dHF/dt` (per MINUTE, undivided by 60) via the same index-domain trick,
 *  against the time axis rather than temperature — used only by
 *  `oxidativeInductionTime` (§3.8), where the segment is isothermal and a
 *  temperature-domain derivative would be meaningless. */
function computeTimeDerivative(view: SegmentView, smoothWindow: number): Float64Array {
  const n = Math.min(view.timeMin.length, view.heatFlow.length);
  const out = new Float64Array(n).fill(NaN);
  if (n === 0) return out;
  const w = clampWindow(smoothWindow, n);
  const dHFdi = smoothSG(view.heatFlow.subarray(0, n), w, 2, 1);
  const dtdi = smoothSG(view.timeMin.subarray(0, n), w, 2, 1);
  const floor = Math.max(1e-12, 0.05 * medianAbs(dtdi));
  for (let i = 0; i < n; i += 1) {
    out[i] = Math.abs(dtdi[i]) < floor ? NaN : dHFdi[i] / dtdi[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// §3.4 Glass transition — ASTM E1356
// ---------------------------------------------------------------------------

export interface GlassResult {
  onsetC: number | null;
  midpointC: number | null;
  endsetC: number | null;
  inflectionC: number | null;
  deltaCp: number | null; // J/(g·°C)
  preLine: Line | null;
  postLine: Line | null;
  inflLine: Line | null;
}

const NULL_GLASS: GlassResult = {
  onsetC: null,
  midpointC: null,
  endsetC: null,
  inflectionC: null,
  deltaCp: null,
  preLine: null,
  postLine: null,
  inflLine: null,
};

/**
 * ASTM E1356 glass transition. `window` is in °C. Requires ≥ 15 points in
 * the window, else returns all-null (step 1).
 */
export function glassTransition(view: SegmentView, window: [number, number]): GlassResult {
  const n = Math.min(view.tempC.length, view.heatFlow.length);
  if (n === 0) return { ...NULL_GLASS };

  // Step 1: index the window.
  const wLo = Math.min(window[0], window[1]);
  const wHi = Math.max(window[0], window[1]);
  const iStart = upperBound(view.tempC, wLo);
  const iEnd = lowerBound(view.tempC, wHi);
  if (iStart < 0 || iEnd < 0 || iEnd - iStart + 1 < 15) return { ...NULL_GLASS };
  const windowLen = iEnd - iStart + 1;

  // Step 2: pre/post lines over the first/last 30 % of the window.
  const edge = Math.max(2, Math.round(windowLen * 0.3));
  const preLine = fitLine(view.tempC, view.heatFlow, iStart, Math.min(iEnd, iStart + edge - 1));
  const postLine = fitLine(view.tempC, view.heatFlow, Math.max(iStart, iEnd - edge + 1), iEnd);
  if (!Number.isFinite(preLine.slope) || !Number.isFinite(postLine.slope)) return { ...NULL_GLASS };

  // Step 3: inflection = argmax(|dHF/dT|) restricted to the middle 40 %.
  const deriv = computeDerivative(view, view.smoothWindow);
  const margin = Math.round(windowLen * 0.3);
  const midLo = iStart + margin;
  const midHi = iEnd - margin;
  const inflIdx = midHi >= midLo ? argmax(absArray(deriv), midLo, midHi + 1) : -1;
  if (inflIdx < 0) return { ...NULL_GLASS, preLine, postLine };
  const inflectionC = view.tempC[inflIdx];

  let fitLo = Math.max(iStart, inflIdx - Math.max(2, Math.round(windowLen * 0.1)));
  let fitHi = Math.min(iEnd, inflIdx + Math.max(2, Math.round(windowLen * 0.1)));
  if (fitHi - fitLo + 1 < 5) {
    const mid = Math.round((fitLo + fitHi) / 2);
    fitLo = Math.max(iStart, mid - 2);
    fitHi = Math.min(iEnd, mid + 2);
  }
  const inflLine = fitLine(view.tempC, view.heatFlow, fitLo, fitHi);
  if (!Number.isFinite(inflLine.slope)) return { ...NULL_GLASS, preLine, postLine, inflectionC };

  // Step 4: onset/endset — intersections with the inflection tangent.
  const onsetC = nanToNull(lineIntersectionX(preLine.slope, preLine.intercept, inflLine.slope, inflLine.intercept));
  const endsetC = nanToNull(lineIntersectionX(postLine.slope, postLine.intercept, inflLine.slope, inflLine.intercept));

  // Step 5: midpoint — half-height crossing of f = (hf - pre) / (post - pre).
  let midpointC: number | null = null;
  let sawValidDenom = false;
  let prevF: number | null = null;
  let prevT: number | null = null;
  for (let i = iStart; i <= iEnd; i += 1) {
    const T = view.tempC[i];
    const denom = evalLine(postLine, T) - evalLine(preLine, T);
    if (!Number.isFinite(denom) || Math.abs(denom) <= 1e-9) {
      prevF = null;
      prevT = null;
      continue;
    }
    sawValidDenom = true;
    const f = (view.heatFlow[i] - evalLine(preLine, T)) / denom;
    if (prevF != null && prevT != null && midpointC == null && (prevF - 0.5) * (f - 0.5) <= 0 && f !== prevF) {
      const t = (0.5 - prevF) / (f - prevF);
      midpointC = prevT + t * (T - prevT);
    }
    prevF = f;
    prevT = T;
  }
  if (!sawValidDenom) midpointC = null;

  // Step 6: Δcp — null in raw mode (mW has no per-gram meaning) or when the
  // segment is effectively isothermal.
  let deltaCp: number | null = null;
  if (midpointC != null && view.normMode !== "raw" && view.rateCPerSec >= 1e-6) {
    const step = Math.abs(evalLine(postLine, midpointC) - evalLine(preLine, midpointC));
    deltaCp = step / view.rateCPerSec;
  }

  return { onsetC, midpointC, endsetC, inflectionC, deltaCp, preLine, postLine, inflLine };
}

// ---------------------------------------------------------------------------
// §3.5 Peaks — melting, crystallization, cold crystallization, cure
// ---------------------------------------------------------------------------

export interface PeakResult {
  peakC: number | null;
  onsetC: number | null;
  endsetC: number | null;
  enthalpyJPerG: number | null; // SIGNED: + exothermic, − endothermic (exo-up)
  areaMj: number | null; // |enthalpy| × sampleMassMg
  peakHeight: number | null; // W/g above the baseline
  fwhmC: number | null;
  baseline: Line | null; // T-space, for drawing
}

const NULL_PEAK: PeakResult = {
  peakC: null,
  onsetC: null,
  endsetC: null,
  enthalpyJPerG: null,
  areaMj: null,
  peakHeight: null,
  fwhmC: null,
  baseline: null,
};

/** View index → raw run index, honouring `SegmentView.reversed`. */
function mapViewIndexToRaw(view: SegmentView, viewIdx: number): number {
  return view.reversed ? view.segEnd - 1 - viewIdx : view.segStart + viewIdx;
}

/** Raw run index → view index, the inverse of `mapViewIndexToRaw`. */
function mapRawIndexToView(view: SegmentView, rawIdx: number): number {
  return view.reversed ? view.segEnd - 1 - rawIdx : rawIdx - view.segStart;
}

/**
 * §3.5.4's enthalpy integral. `d` is the baseline-subtracted heat flow
 * (W/g) for view indices `[viewIStart, viewIStart + d.length)`.
 *
 * ⚠️ Walks the run's ORIGINAL acquisition order via `view.rawTimeMin`
 * (never `view.timeMin`, which is reversed for a cooling segment) so
 * `t[k+1] - t[k]` stays positive regardless of heat/cool direction.
 */
function integrateAgainstTime(view: SegmentView, d: Float64Array, viewIStart: number): number | null {
  if (d.length < 2) return null;
  const rawA = mapViewIndexToRaw(view, viewIStart);
  const rawB = mapViewIndexToRaw(view, viewIStart + d.length - 1);
  const rawLo = Math.min(rawA, rawB);
  const rawHi = Math.max(rawA, rawB);
  let sum = 0;
  let any = false;
  for (let k = rawLo; k < rawHi; k += 1) {
    const vi0 = mapRawIndexToView(view, k);
    const vi1 = mapRawIndexToView(view, k + 1);
    const d0 = d[vi0 - viewIStart];
    const d1 = d[vi1 - viewIStart];
    const t0 = view.rawTimeMin[k - view.segStart];
    const t1 = view.rawTimeMin[k + 1 - view.segStart];
    if (!Number.isFinite(d0) || !Number.isFinite(d1) || !Number.isFinite(t0) || !Number.isFinite(t1)) continue;
    sum += 0.5 * (d0 + d1) * (t1 - t0) * 60; // minutes -> seconds; W/g * s = J/g
    any = true;
  }
  return any ? sum : null;
}

/** Steepest-point tangent (§3.5.5): `argmax|dHF/dT|` in `[lo, hi]`, a ±5
 *  point tangent fit there, intersected with `baseline`. */
function tangentBaselineIntersect(
  view: SegmentView,
  absDeriv: Float64Array,
  baseline: Line,
  lo: number,
  hi: number,
): number | null {
  if (hi < lo) return null;
  const idx = argmax(absDeriv, lo, hi + 1);
  if (idx < 0) return null;
  const tangent = fitLine(view.tempC, view.heatFlow, idx - 5, idx + 5);
  if (!Number.isFinite(tangent.slope)) return null;
  const x = lineIntersectionX(tangent.slope, tangent.intercept, baseline.slope, baseline.intercept);
  if (!Number.isFinite(x)) return null;
  // A tangent that's merely CLOSE to parallel with the baseline (common on
  // a broad, gently-sloped flank) gives a mathematically valid but
  // physically meaningless intersection far outside the flank it was fit
  // on — verified on `1-2 S1.tri`'s real broad melt peak, whose reported
  // Endset came out -6286 °C. A genuine onset/endset must fall between the
  // window edge and the peak (the exact span `[lo, hi]` was searched over);
  // treat anything outside that span as undetermined, same as the NaN case.
  const xLo = Math.min(view.tempC[lo], view.tempC[hi]);
  const xHi = Math.max(view.tempC[lo], view.tempC[hi]);
  if (x < xLo || x > xHi) return null;
  return x;
}

/**
 * Peak integration for one melt/crystallization/cold-crystallization/cure
 * window (§3.5). `window` and `anchors` are in °C.
 */
export function peakTransition(
  view: SegmentView,
  run: DscRun,
  window: [number, number],
  anchors: [number, number],
): PeakResult {
  const n = Math.min(view.tempC.length, view.heatFlow.length);
  if (n < 2) return { ...NULL_PEAK };

  const wLo = Math.min(window[0], window[1]);
  const wHi = Math.max(window[0], window[1]);
  const iStart = upperBound(view.tempC, wLo);
  const iEnd = lowerBound(view.tempC, wHi);
  if (iStart < 0 || iEnd < 0 || iEnd <= iStart || iEnd >= n) return { ...NULL_PEAK };

  // Step 1: baseline through the two anchors, each evaluated as the mean of
  // the 5 nearest points (noise resistance).
  const a0 = nearestMeanY(view.tempC, view.heatFlow, anchors[0], 5);
  const a1 = nearestMeanY(view.tempC, view.heatFlow, anchors[1], 5);
  if (a0 == null || a1 == null) return { ...NULL_PEAK };
  const baseline = lineThrough(anchors[0], a0, anchors[1], a1);

  // Step 2: baseline-subtracted deviation.
  const len = iEnd - iStart + 1;
  const d = new Float64Array(len);
  for (let i = 0; i < len; i += 1) {
    d[i] = view.heatFlow[iStart + i] - evalLine(baseline, view.tempC[iStart + i]);
  }

  // Step 3: peak.
  const localPeak = argmax(absArray(d), 0, len);
  if (localPeak < 0) return { ...NULL_PEAK, baseline };
  const peakIdx = iStart + localPeak;
  const peakC = view.tempC[peakIdx];
  const peakHeight = d[localPeak];

  // Step 4: enthalpy, integrated against TIME in ORIGINAL acquisition order.
  const enthalpyJPerG = integrateAgainstTime(view, d, iStart);
  const mass = resolveSampleMassMg(run);
  const areaMj =
    enthalpyJPerG != null && mass != null && Number.isFinite(mass) && mass > 0
      ? Math.abs(enthalpyJPerG) * mass
      : null;

  // Step 5: onset/endset via the steepest-point tangent on each flank.
  const absDeriv = absArray(computeDerivative(view, view.smoothWindow));
  const onsetC = tangentBaselineIntersect(view, absDeriv, baseline, iStart, peakIdx);
  const endsetC = tangentBaselineIntersect(view, absDeriv, baseline, peakIdx, iEnd);

  // Step 6: FWHM.
  const fwhmC = fwhm(view.tempC.subarray(iStart, iEnd + 1), d, localPeak, peakHeight / 2, 0, len);

  // Step 7: the sign of `peakHeight` (exo-up convention) is the direction —
  // `> 0` exotherm, `< 0` endotherm. Callers (e.g. §3.6's classifier) read
  // it directly rather than a redundant field here.
  return { peakC, onsetC, endsetC, enthalpyJPerG, areaMj, peakHeight, fwhmC, baseline };
}

// ---------------------------------------------------------------------------
// §3.6 Auto-detection
// ---------------------------------------------------------------------------

/** Flanking indices where `|d|` first falls below `0.1 * |d[peakIdx]|`, or
 *  the array ends (§3.6.2). */
function candidateWindow(d: Float64Array, peakIdx: number): [number, number] {
  const cutoff = 0.1 * Math.abs(d[peakIdx]);
  let lo = peakIdx;
  while (lo > 0 && Number.isFinite(d[lo - 1]) && Math.abs(d[lo - 1]) >= cutoff) lo -= 1;
  let hi = peakIdx;
  while (hi < d.length - 1 && Number.isFinite(d[hi + 1]) && Math.abs(d[hi + 1]) >= cutoff) hi += 1;
  return [lo, hi];
}

/** Same outward walk as {@link candidateWindow}, but against a caller-given
 *  absolute `floor` rather than 10 % of the candidate's own peak. Used only
 *  to size how much territory a newly-accepted candidate claims (never the
 *  reported feature window/enthalpy range) — see the call site's comment. */
function candidateWindowAtFloor(d: Float64Array, peakIdx: number, floor: number): [number, number] {
  let lo = peakIdx;
  while (lo > 0 && Number.isFinite(d[lo - 1]) && Math.abs(d[lo - 1]) >= floor) lo -= 1;
  let hi = peakIdx;
  while (hi < d.length - 1 && Number.isFinite(d[hi + 1]) && Math.abs(d[hi + 1]) >= floor) hi += 1;
  return [lo, hi];
}

interface PeakCandidate {
  peakIdx: number;
  lo: number;
  hi: number;
  enthalpy: number;
}

/** A local-extremum candidate that `classifyStepCandidate` identified as a
 *  glass-transition step rather than a peak — see that function's doc
 *  comment. Carries just enough to build the segment's glass `DscFeature`
 *  (§3.6.5) without `detectPeakCandidates` needing to know about `DscFeature`
 *  or the owning `DscSegment`. */
interface StepCandidate {
  peakIdx: number;
  windowC: [number, number];
  stepHeight: number; // signed, W/g — postLine(Tp) - preLine(Tp)
}

/** Minimum `|postLine - preLine|` at a step's center to count as a real
 *  transition rather than noise. Shared by `classifyStepCandidate` (the
 *  step-vs-peak discriminator, run on every `detectPeakCandidates` local
 *  extremum) and `detectGlassCandidate` (the outside-every-peak fallback
 *  search) so the two passes agree on what counts as "a step" at all. */
const GLASS_STEP_HEIGHT_FLOOR_W_PER_G = 0.005;

/**
 * How small the WEAKER of the two same-neighbourhood derivative lobes must
 * be, relative to the dominant one, for a candidate to be called a step
 * (§3.6.2a). The physical distinction lives in the RAW (not
 * baseline-subtracted) slope `dHF/dT` around the candidate's apex: a real
 * peak is symmetric-ish — heat flow rises into it and falls back out, so
 * `deriv` carries two comparable lobes of OPPOSITE sign flanking the apex
 * (one for the rise, one for the fall). A step has only one — heat flow
 * moves in a single direction and stays there, so `deriv` has one dominant
 * lobe and nothing of consequence on the other side.
 *
 * Verified on `DAC1.tri` segment 2, a pure Tg with no melt at all, whose
 * entire ramp was reported as a single "Melt" spanning [1.1, 253.1] °C with a
 * bogus ΔH of -207.6 J/g before this discriminator existed: near its
 * candidate apex, the dominant lobe measures |dHF/dT| ≈ 0.0089, the opposite-
 * sign lobe only ≈ 0.0011 — a ratio of ~0.13, far below `0.4`. A synthetic
 * Gaussian melt's two lobes come out within a percent of each other by
 * construction (ratio ~1), sailing through untouched.
 */
const STEP_LOBE_DOMINANCE_RATIO = 0.4;

/**
 * How much bigger `|stepHeight|` must be than `|peakAmp|` for a candidate
 * that passed the lobe-dominance test above to be treated as a step's window
 * rather than discarded outright (§3.6.2a step 3). Across a real peak, heat
 * flow returns to the SAME extrapolated baseline it left (`stepHeight -> 0`);
 * across a step, the level is PERMANENTLY displaced (`peakAmp -> 0`, since
 * the apex sits roughly midway between the two displaced levels rather than
 * bulging off either one). DAC1's real Tg measures `stepHeight ≈ -0.049 W/g`
 * against `peakAmp ≈ -0.032 W/g` — a ratio of ~1.5 — so `0.5` clears it with
 * room to spare.
 */
const STEP_HEIGHT_TO_AMP_RATIO = 0.5;

/**
 * Minimum half-width, in °C, `classifyStepCandidate` and
 * `detectGlassCandidate` both keep clear of a segment's own temperature
 * extremes — a companion to `EDGE_REJECT_FRACTION`'s INDEX-based guard
 * (below), but expressed in temperature because the two guards catch
 * different things. `EDGE_REJECT_FRACTION` rejects a candidate whose own
 * apex (`bestIdx`, the argmax of the baseline-subtracted deviation `d`)
 * lands in the segment's first/last 2 % of POINTS; a step's apex can sit far
 * from that (DAC2.tri's ramp-start artifact apex measured out at ~19 °C,
 * well past a 2 %-of-~16 800-points margin of ~5.6 °C), while the artifact's
 * actual CORE — the region `classifyStepCandidate` fits pre/post lines
 * around — sits right where the instrument is still settling into the ramp
 * rate. `STEP_EDGE_MARGIN_MIN_C` is the floor for that; see
 * `STEP_EDGE_MARGIN_FRACTION` for the other half of the rule.
 */
const STEP_EDGE_MARGIN_MIN_C = 10;

/**
 * Fraction of a segment's own temperature span kept clear of a step's core,
 * alongside the `STEP_EDGE_MARGIN_MIN_C` floor (the effective margin is
 * `max(STEP_EDGE_MARGIN_MIN_C, STEP_EDGE_MARGIN_FRACTION * span)`). Verified
 * against every real `.tri` segment 2 in the fixture set: DAC3.tri's
 * legitimate Tg core sits at ~33 °C on a 0-278 °C span — margin ≈ 13.9 °C —
 * so it clears with ~19 °C to spare, while DAC2.tri's and `1-2 S1.tri`'s
 * ramp-start artifacts (core ≈ 2-6 °C) and every cooling segment's
 * ramp-END artifact (core ≈ 277-278 °C, i.e. within the SAME margin of the
 * segment's high end since a cooling `SegmentView` is reversed to ascending
 * — acquisition starts at 280 °C) fall inside it and are rejected.
 */
const STEP_EDGE_MARGIN_FRACTION = 0.05;

/** `true` when `centerC` (a step candidate's core midpoint) sits within
 *  `max(STEP_EDGE_MARGIN_MIN_C, STEP_EDGE_MARGIN_FRACTION * span)` of either
 *  end of `[tempLo, tempHi]` — ramp start/end thermal lag settling into rate,
 *  not a transition (see the two constants' doc comments). Shared by
 *  `classifyStepCandidate` and `detectGlassCandidate` so a step artifact
 *  rejected on one path can't just resurface through the other. */
function isNearSegmentTempEdge(centerC: number, tempLo: number, tempHi: number): boolean {
  const marginC = Math.max(STEP_EDGE_MARGIN_MIN_C, STEP_EDGE_MARGIN_FRACTION * (tempHi - tempLo));
  return centerC - tempLo < marginC || tempHi - centerC < marginC;
}

/**
 * Plausible range for a glass transition's `|Δcp|`, J/(g·°C) — the last gate
 * a step candidate must clear (§3.6.2a step 5), run AFTER the window is
 * built by calling the real `glassTransition` on it and reading back its
 * `deltaCp`. Catches the OTHER real-file failure mode the lobe/height tests
 * above don't: on `DAC1.tri`'s and `DAC3.tri`'s FIRST heat (a curing epoxy,
 * carrying a cure exotherm the global baseline partly absorbs alongside its
 * own Tg), the step fit can land on the exotherm's flank instead of the
 * actual glass step, reporting Δcp of 5.97 and 2.00 J/(g·°C) respectively —
 * one to two orders of magnitude above any real polymer's heat-capacity
 * jump at Tg (their genuine 2nd-heat Tg's measure 0.39 both times). `0.005`
 * (the floor) reuses `GLASS_STEP_HEIGHT_FLOOR_W_PER_G`'s own noise floor
 * intuition; `1.0` (the ceiling) is generous headroom above every real
 * measurement in this fixture set. `deltaCp` is `null` whenever
 * `SegmentView.normMode === "raw"` (no sample mass — see `glassTransition`'s
 * §3.4 step 6) or the segment is effectively isothermal; NEITHER of those is
 * grounds for rejecting the candidate, so the caller only applies this gate
 * when `deltaCp` is non-null.
 */
const GLASS_DELTA_CP_MIN_J_PER_G_C = 0.005;
const GLASS_DELTA_CP_MAX_J_PER_G_C = 1.0;

/**
 * Step-vs-peak discriminator, run on every `detectPeakCandidates` local
 * extremum before it is accepted as a peak (§3.6.2a). Returns the step's
 * window/height when the candidate at `peakIdx` (view index, with its
 * 10 %-cutoff window `[lo, hi]` already computed by `candidateWindow`) looks
 * like a permanent baseline displacement rather than a peak that returns to
 * where it started; `null` when it doesn't (or there isn't enough runway on
 * either flank to tell), in which case the caller proceeds exactly as before.
 *
 * 1. **Lobe search, near `p` only**: find the most positive and most
 *    negative `dHF/dT` within a probe-sized neighbourhood of `p` — NOT the
 *    candidate's full `[lo, hi]`, which can span almost the entire segment
 *    for exactly the pathological candidates this function exists to catch
 *    (DAC1.tri's spans indices 147-15270 of ~15500) and whose own extreme can
 *    then be dominated by something with nothing to do with `p` at all —
 *    DAC1's true `|dHF/dT|` maximum inside that full window sits at the very
 *    first few points of the ramp (instrument thermal lag settling into
 *    rate, the same artifact `EDGE_REJECT_FRACTION` guards against
 *    elsewhere), nowhere near its Tg.
 * 2. **Dominance gate**: see `STEP_LOBE_DOMINANCE_RATIO`. Passing this means
 *    exactly one lobe matters; call its index `extremeIdx` and walk outward
 *    from it while `|dHF/dT|` stays within 50 % of its own value — the
 *    "core", `[c0, c1]` (the step's rise/fall itself, not its flatter
 *    shoulders).
 * 3. **Pre/post lines**: fit a line over a probe of points ending just before
 *    the core and another starting just after it, ~8 % of the segment wide,
 *    clamped inside the segment. These extend past `[lo, hi]` into the wider
 *    segment when the core sits near a window edge (as DAC1's does) — a
 *    step's TRUE pre/post baselines live outside the region the step itself
 *    dominates.
 * 4. **Discriminant** at the apex temperature: see `STEP_HEIGHT_TO_AMP_RATIO`.
 */
function classifyStepCandidate(
  view: SegmentView,
  deriv: Float64Array,
  n: number,
  peakIdx: number,
  lo: number,
  hi: number,
): StepCandidate | null {
  const probe = Math.max(10, Math.round(n * 0.08));
  const nearLo = Math.max(lo, peakIdx - probe);
  const nearHi = Math.min(hi, peakIdx + probe);

  let maxPos = 0;
  let maxPosIdx = -1;
  let maxNeg = 0; // stored as a positive magnitude
  let maxNegIdx = -1;
  for (let i = nearLo; i <= nearHi; i += 1) {
    const v = deriv[i];
    if (!Number.isFinite(v)) continue;
    if (v > maxPos) {
      maxPos = v;
      maxPosIdx = i;
    }
    if (-v > maxNeg) {
      maxNeg = -v;
      maxNegIdx = i;
    }
  }
  const dominant = Math.max(maxPos, maxNeg);
  const weak = Math.min(maxPos, maxNeg);
  if (!(dominant > 0)) return null;
  if (weak >= STEP_LOBE_DOMINANCE_RATIO * dominant) return null; // two comparable lobes — a real peak

  const extremeIdx = maxPos >= maxNeg ? maxPosIdx : maxNegIdx;
  const threshold = 0.5 * dominant;
  let c0 = extremeIdx;
  while (c0 > lo && Number.isFinite(deriv[c0 - 1]) && Math.abs(deriv[c0 - 1]) >= threshold) c0 -= 1;
  let c1 = extremeIdx;
  while (c1 < hi && Number.isFinite(deriv[c1 + 1]) && Math.abs(deriv[c1 + 1]) >= threshold) c1 += 1;

  // Ramp start/end thermal lag (§ `isNearSegmentTempEdge`'s doc comment)
  // rejected here, on the CORE's own center — not on `bestIdx`/`peakIdx`
  // (that's what `EDGE_REJECT_FRACTION` already checks, in index space, and
  // it isn't enough on its own: DAC2.tri's ramp-start artifact has its
  // `d`-apex out at ~19 °C, past that 2 %-of-points margin, even though the
  // artifact's actual core sits at ~2-6 °C) and not on the eventual window
  // bounds either (a legitimate step's WINDOW can legitimately start close
  // to a segment edge — DAC3.tri's real Tg window opens at 7.2 °C on a
  // 0-278 °C span — only its CORE has to clear the margin).
  const tempLo = view.tempC[0];
  const tempHi = view.tempC[n - 1];
  const rawCenterC = (view.tempC[c0] + view.tempC[c1]) / 2;
  if (isNearSegmentTempEdge(rawCenterC, tempLo, tempHi)) return null;

  const preHi = c0 - 1;
  const preLo = Math.max(0, preHi - probe + 1);
  const postLo = c1 + 1;
  const postHi = Math.min(n - 1, postLo + probe - 1);
  // Not enough runway on one flank (the core sits right at the segment's own
  // edge) to fit a trustworthy pre/post baseline — bail to the current
  // peak-candidate behaviour rather than guess.
  if (preHi - preLo + 1 < 5 || postHi - postLo + 1 < 5) return null;

  const preLine = fitLine(view.tempC, view.heatFlow, preLo, preHi);
  const postLine = fitLine(view.tempC, view.heatFlow, postLo, postHi);
  if (!Number.isFinite(preLine.slope) || !Number.isFinite(postLine.slope)) return null;

  const Tp = view.tempC[peakIdx];
  const stepHeight = evalLine(postLine, Tp) - evalLine(preLine, Tp);
  const peakAmp = view.heatFlow[peakIdx] - (evalLine(preLine, Tp) + evalLine(postLine, Tp)) / 2;
  if (Math.abs(stepHeight) < GLASS_STEP_HEIGHT_FLOOR_W_PER_G) return null;
  if (Math.abs(stepHeight) < STEP_HEIGHT_TO_AMP_RATIO * Math.abs(peakAmp)) return null;

  // Window centred on the core (the step's own rise/fall), not the apex —
  // `peakIdx` (argmax of the baseline-subtracted deviation) can sit well off
  // to one side of a step's actual midpoint, same as DAC1's apex (76.5 °C)
  // sits well above its true Tg midpoint (67.9 °C). Half-width scales with
  // how wide the rise itself is so a sharp step gets a tight window and a
  // gradual one gets enough room for `glassTransition`'s 30 %-edge pre/post
  // fit, floored at 10 °C for a razor-sharp core.
  const coreWidthC = Math.abs(view.tempC[c1] - view.tempC[c0]);
  const centerC = rawCenterC;
  const halfWidthC = Math.max(10, 3 * coreWidthC);
  const windowC: [number, number] = [
    Math.max(tempLo, centerC - halfWidthC),
    Math.min(tempHi, centerC + halfWidthC),
  ];

  // Last gate: does the window this function is ABOUT to hand back actually
  // read as a plausible glass transition, per the real ASTM E1356 machinery
  // (`glassTransition`) rather than just this function's own cheaper
  // lobe/height heuristics? Catches the 1st-heat cure-exotherm-flank failure
  // mode `GLASS_DELTA_CP_MIN_J_PER_G_C`'s doc comment describes — the lobe
  // and height tests above are satisfied there too (the exotherm's flank IS
  // a one-sided, permanently-displaced deviation), but the resulting Δcp is
  // off by 1-2 orders of magnitude from anything physical.
  const check = glassTransition(view, windowC);
  if (check.midpointC == null || !Number.isFinite(check.midpointC)) return null;
  if (
    check.deltaCp != null &&
    (!Number.isFinite(check.deltaCp) ||
      Math.abs(check.deltaCp) < GLASS_DELTA_CP_MIN_J_PER_G_C ||
      Math.abs(check.deltaCp) > GLASS_DELTA_CP_MAX_J_PER_G_C)
  ) {
    return null;
  }
  // Re-check the edge margin against `glassTransition`'s ACTUAL half-height
  // midpoint, not just `rawCenterC` (this function's cheaper core-midpoint
  // estimate, checked above before the pre/post lines were even fit) — see
  // `detectGlassCandidate`'s matching re-check for why the two can disagree
  // by more than the gap to the margin.
  if (isNearSegmentTempEdge(check.midpointC, tempLo, tempHi)) return null;

  return { peakIdx, windowC, stepHeight };
}

/** Fraction of a segment's points, at EITHER end, whose apex a candidate is
 *  rejected for landing inside. Pins a real bug seen on actual `.tri`
 *  files: a DSC ramp's first ~30 s (and, symmetrically, its last) is
 *  instrument thermal lag settling into the new rate, not a transition —
 *  the global baseline fit (also endpoint-averaged over this same 2 %,
 *  above) reacts to it as a sharp deviation, `detectPeakCandidates` picks
 *  it up as a strong local extremum, and it gets auto-classified as a
 *  bogus "cold crystallization" a fraction of a degree into the ramp. */
const EDGE_REJECT_FRACTION = 0.02;

/**
 * Maximum fraction of a segment's OWN temperature span that an auto-detected
 * peak candidate's window (`[lo, hi]` in temperature) may cover before it is
 * rejected as baseline curvature rather than a resolvable transition
 * (§3.6.2b). `detectPeakCandidates`' global baseline is a straight two-point
 * line (step 1, above); it cannot represent the gentle curve a real DSC
 * baseline actually has, so on a segment with no genuine peak or step at
 * all — just curvature — the whole ramp reads as one enormous local extremum.
 * Four real files exhibited exactly this before this gate existed: DAC2.tri
 * heat 2's bogus "melt[1,250]" on a 0-278 °C segment (≈ 90 % of the span),
 * `1-2 S1.tri` heat 2's "melt[2,236]" (≈ 99 %), DAC1.tri cool 1's
 * "crystallization[36,279]" (≈ 87 %), and DAC1.tri heat 1's "melt[6,221]"
 * (≈ 77 %) — none of them a transition; DAC2.tri heat 2 in particular is
 * monotone and essentially linear over its whole range. A resolvable DSC
 * transition, even a broad one, is a modest fraction of the ramp it sits
 * on — this fixture set's own `BROAD_NOISY_MELT` (σ = 25 °C on a 280 °C
 * segment) claims a window of ≈ 39 % of the span at its widest, comfortably
 * under this gate. `0.75` sits well above every legitimate window measured
 * here (real or synthetic) and well below every bogus one.
 */
const MAX_PEAK_SPAN_FRACTION = 0.75;

/** §3.6 steps 1-3: global baseline, local-extrema candidates, enthalpy gate,
 *  minimum separation, cap at 6. Greedily picks the strongest remaining
 *  local extremum of either sign — via `localMaximumIndex`/
 *  `localMinimumIndex` over whatever unclaimed index ranges remain — so a
 *  weak/rejected candidate can't be re-picked forever. Every candidate is run
 *  through `classifyStepCandidate` before it is accepted as a peak; one
 *  identified as a step (a glass transition the global baseline absorbed
 *  whole — see that function's doc comment) is returned separately in
 *  `steps` instead, with its territory claimed exactly like a peak's so the
 *  greedy loop doesn't rediscover it. */
function detectPeakCandidates(
  view: SegmentView,
  params: DscParams,
): { d: Float64Array; candidates: PeakCandidate[]; steps: StepCandidate[] } {
  const n = Math.min(view.tempC.length, view.heatFlow.length);
  const d = new Float64Array(n);
  if (n === 0) return { d, candidates: [], steps: [] };

  // Step 1: global linear baseline, endpoints averaged over 2 % each.
  const edgeCount = Math.max(1, Math.round(n * 0.02));
  const baseline = lineThrough(
    mean(view.tempC, 0, edgeCount),
    mean(view.heatFlow, 0, edgeCount),
    mean(view.tempC, n - edgeCount, n),
    mean(view.heatFlow, n - edgeCount, n),
  );
  for (let i = 0; i < n; i += 1) d[i] = view.heatFlow[i] - evalLine(baseline, view.tempC[i]);

  let maxAbsD = 0;
  for (let i = 0; i < n; i += 1) {
    if (Number.isFinite(d[i]) && Math.abs(d[i]) > maxAbsD) maxAbsD = Math.abs(d[i]);
  }
  const peakFloor = Math.max(0.005, 0.05 * maxAbsD);
  const minSep = Math.max(5, Math.floor(n * 0.02));
  const edgeMargin = Math.max(1, Math.round(n * EDGE_REJECT_FRACTION));

  const claimed = new Uint8Array(n);
  const candidates: PeakCandidate[] = [];
  const steps: StepCandidate[] = [];
  // Computed once up front (not lazily inside the loop) — `classifyStepCandidate`
  // needs it for every candidate, and it doesn't depend on anything the loop
  // mutates.
  const deriv = computeDerivative(view, params.smoothWindow);

  for (let iter = 0; iter < 24 && candidates.length < 6; iter += 1) {
    let bestIdx = -1;
    let bestAbs = -Infinity;
    let rangeStart = -1;
    for (let i = 0; i <= n; i += 1) {
      const free = i < n && claimed[i] === 0;
      if (free && rangeStart === -1) rangeStart = i;
      if ((!free || i === n) && rangeStart !== -1) {
        const iMax = localMaximumIndex(d, rangeStart, i);
        const iMin = localMinimumIndex(d, rangeStart, i);
        if (iMax >= 0 && Math.abs(d[iMax]) > bestAbs) {
          bestAbs = Math.abs(d[iMax]);
          bestIdx = iMax;
        }
        if (iMin >= 0 && Math.abs(d[iMin]) > bestAbs) {
          bestAbs = Math.abs(d[iMin]);
          bestIdx = iMin;
        }
        rangeStart = -1;
      }
    }
    if (bestIdx < 0 || bestAbs < peakFloor) break;

    const [lo, hi] = candidateWindow(d, bestIdx);
    // Claim out to wherever |d| drops below `peakFloor` — NOT just the
    // candidate's own `[lo, hi]` (10 % of ITS peak) or a `minSep` band.
    // `peakFloor` (5 % of the segment's global max) is a materially LOWER
    // bar than that 10 %-of-its-own-peak cutoff, so the strip of points just
    // past `[lo, hi]` still clears `peakFloor` and was being left free —
    // rediscovered next iteration as a spurious near-duplicate a few points
    // further out, whose own (smaller) peak has an even lower 10 % cutoff,
    // letting its window creep outward again. Verified against `DAC1.tri`'s
    // melt peak, which otherwise gets reported as six near-identical
    // "Melt 1..6" features instead of one.
    const [floorLo, floorHi] = candidateWindowAtFloor(d, bestIdx, peakFloor);
    const claimLo = Math.max(0, Math.min(lo, floorLo, bestIdx - minSep));
    const claimHi = Math.min(n - 1, Math.max(hi, floorHi, bestIdx + minSep));
    for (let i = claimLo; i <= claimHi; i += 1) claimed[i] = 1;

    // Reject an apex inside the edge margin (thermal-lag artifact, not a
    // transition — see `EDGE_REJECT_FRACTION`'s doc comment). Still claimed
    // above, same as any other candidate, so the outward walk doesn't leave
    // it to be "rediscovered" next iteration.
    if (bestIdx < edgeMargin || bestIdx >= n - edgeMargin) continue;

    // A step (glass transition) the global baseline absorbed whole reads as
    // one enormous, one-sided "peak" here — reclassify it before the
    // enthalpy gate below ever sees it, or DAC1.tri's entire Tg ends up
    // reported as a "Melt" with a bogus few-hundred-J/g ΔH (see
    // `classifyStepCandidate`'s doc comment).
    const step = classifyStepCandidate(view, deriv, n, bestIdx, lo, hi);
    if (step) {
      steps.push(step);
      continue;
    }

    // Full-span gate (`MAX_PEAK_SPAN_FRACTION`'s doc comment): a window this
    // wide relative to the segment's own temperature range is baseline
    // curvature the straight two-point global baseline couldn't cancel, not
    // a resolvable transition. Checked here rather than folded into the
    // enthalpy gate below because a huge bogus window also integrates to a
    // huge bogus enthalpy — it clears `minPeakEnthalpy` easily and needs its
    // own, independent rejection.
    const segSpanC = Math.abs(view.tempC[n - 1] - view.tempC[0]);
    const windowSpanC = Math.abs(view.tempC[hi] - view.tempC[lo]);
    if (segSpanC > 0 && windowSpanC > MAX_PEAK_SPAN_FRACTION * segSpanC) continue;

    const enthalpy = integrateAgainstTime(view, d.subarray(lo, hi + 1), lo);
    if (enthalpy != null && Math.abs(enthalpy) >= params.minPeakEnthalpy) {
      candidates.push({ peakIdx: bestIdx, lo, hi, enthalpy });
    }
  }

  candidates.sort((a, b) => a.peakIdx - b.peakIdx);
  return { d, candidates, steps };
}

/** §3.6.5 / §3.4.7: at most one glass-transition candidate, found after the
 *  peaks — the largest step in `hf` outside every peak window. A "step" is a
 *  jump where `|postLine - preLine|` at the midpoint exceeds 0.005 W/g while
 *  the baseline-subtracted area over the same span stays below 0.3 J/g (a
 *  real peak fails that area test; a pure baseline step passes it). The
 *  window half-width is `max(10 °C, 6 × the step's 10-90 % rise width)`.
 *  Shares two guards with `classifyStepCandidate` so a step artifact
 *  rejected on ITS path can't just resurface here instead: the
 *  `isNearSegmentTempEdge` ramp-start/end margin, and the `glassTransition`
 *  Δcp plausibility check (`GLASS_DELTA_CP_MIN_J_PER_G_C`'s doc comment). */
function detectGlassCandidate(
  view: SegmentView,
  segment: DscSegment,
  params: DscParams,
  peaks: { lo: number; hi: number }[],
): DscFeature | null {
  const n = Math.min(view.tempC.length, view.heatFlow.length);
  if (n < 15) return null;
  const deriv = computeDerivative(view, params.smoothWindow);

  const margin = Math.max(5, Math.floor(n * 0.02));
  const insidePeak = (i: number) => peaks.some((p) => i >= p.lo - margin && i <= p.hi + margin);
  const tempLo = view.tempC[0];
  const tempHi = view.tempC[n - 1];

  let best: { height: number; windowC: [number, number] } | null = null;

  for (let idx = margin; idx < n - margin; idx += 1) {
    if (!Number.isFinite(deriv[idx]) || insidePeak(idx)) continue;
    const av = Math.abs(deriv[idx]);
    if (!(av >= Math.abs(deriv[idx - 1]) && av >= Math.abs(deriv[idx + 1]))) continue; // local extremum of |deriv|
    // Ramp start/end thermal lag — same guard `classifyStepCandidate` runs
    // on its own core center, applied here to this loop's analogous anchor
    // (`idx`, the local |deriv| extremum a step's pre/post probes are built
    // around).
    if (isNearSegmentTempEdge(view.tempC[idx], tempLo, tempHi)) continue;

    const probe = Math.max(10, Math.floor(n * 0.1));
    const preLo = Math.max(0, idx - probe);
    const preHi = Math.max(preLo, idx - Math.floor(probe / 3));
    const postLo = Math.min(n - 1, idx + Math.floor(probe / 3));
    const postHi = Math.min(n - 1, idx + probe);
    if (preHi <= preLo || postHi <= postLo) continue;

    const preLine = fitLine(view.tempC, view.heatFlow, preLo, preHi);
    const postLine = fitLine(view.tempC, view.heatFlow, postLo, postHi);
    if (!Number.isFinite(preLine.slope) || !Number.isFinite(postLine.slope)) continue;

    const T = view.tempC[idx];
    const stepHeight = Math.abs(evalLine(postLine, T) - evalLine(preLine, T));
    if (stepHeight <= GLASS_STEP_HEIGHT_FLOOR_W_PER_G) continue;

    const preVal = evalLine(preLine, view.tempC[preHi]);
    const postVal = evalLine(postLine, view.tempC[postLo]);
    const rise10 = crossingIndex(view.heatFlow, idx, preVal + 0.1 * (postVal - preVal), preLo, postHi);
    const rise90 = crossingIndex(view.heatFlow, idx, preVal + 0.9 * (postVal - preVal), preLo, postHi);
    const riseWidthC = rise10 != null && rise90 != null ? Math.abs(view.tempC[rise90] - view.tempC[rise10]) : 0;
    const halfWidthC = Math.max(10, 6 * riseWidthC);

    const windowLo = Math.max(view.tempC[0], T - halfWidthC);
    const windowHi = Math.min(view.tempC[n - 1], T + halfWidthC);
    const wLo = upperBound(view.tempC, windowLo);
    const wHi = lowerBound(view.tempC, windowHi);
    if (wLo < 0 || wHi < 0 || wHi <= wLo) continue;

    const stepBaseline = lineThrough(view.tempC[wLo], view.heatFlow[wLo], view.tempC[wHi], view.heatFlow[wHi]);
    const dArea = new Float64Array(wHi - wLo + 1);
    for (let i = wLo; i <= wHi; i += 1) dArea[i - wLo] = view.heatFlow[i] - evalLine(stepBaseline, view.tempC[i]);
    const area = integrateAgainstTime(view, dArea, wLo);
    if (area == null || Math.abs(area) >= 0.3) continue; // a real peak, not a step

    // Same Δcp plausibility gate as `classifyStepCandidate` — a step-shaped
    // deviation can still sit on a cure exotherm's flank rather than a real
    // Tg (see `GLASS_DELTA_CP_MIN_J_PER_G_C`'s doc comment); `deltaCp` null
    // (raw mode / isothermal) skips the check rather than rejecting.
    const plausibility = glassTransition(view, [windowLo, windowHi]);
    if (plausibility.midpointC == null || !Number.isFinite(plausibility.midpointC)) continue;
    if (
      plausibility.deltaCp != null &&
      (!Number.isFinite(plausibility.deltaCp) ||
        Math.abs(plausibility.deltaCp) < GLASS_DELTA_CP_MIN_J_PER_G_C ||
        Math.abs(plausibility.deltaCp) > GLASS_DELTA_CP_MAX_J_PER_G_C)
    ) {
      continue;
    }
    // Re-check the edge margin against `glassTransition`'s ACTUAL half-height
    // midpoint, not just this loop's `idx` anchor above. The two can
    // disagree by more than the gap between `idx` and the margin: on
    // DAC3.tri's first heat (a curing epoxy — same cure-exotherm-adjacent
    // shape `GLASS_DELTA_CP_MIN_J_PER_G_C`'s doc comment describes), `idx`
    // cleared the margin by a few hundredths of a degree, but the real
    // tanh-crossing midpoint landed 0.5 °C further toward the edge, past it —
    // reachable at all only once the full-span gate (`MAX_PEAK_SPAN_FRACTION`)
    // stopped that whole region being swallowed inside a single rejected
    // peak candidate, which used to hide this from `detectGlassCandidate`
    // entirely.
    if (isNearSegmentTempEdge(plausibility.midpointC, tempLo, tempHi)) continue;

    if (!best || stepHeight > best.height) best = { height: stepHeight, windowC: [windowLo, windowHi] };
  }

  if (!best) return null;
  return {
    id: `${segment.id}:auto:glass:1`,
    segmentId: segment.id,
    kind: "glass",
    label: "Glass transition",
    window: best.windowC,
    baseline: null,
    baselineMode: "linear",
    auto: true,
    visible: true,
  };
}

/** Nearest index to `from`, searching left then right within `[lo, hi]`,
 *  where `y` crosses `level`. Used only to estimate a step's 10-90 % rise
 *  width for the glass auto-window heuristic — an index result is enough
 *  since the caller only needs `tempC` at that index. */
function crossingIndex(y: Float64Array, from: number, level: number, lo: number, hi: number): number | null {
  for (let i = from; i > lo; i -= 1) {
    if ((y[i] - level) * (y[i - 1] - level) <= 0) return i;
  }
  for (let i = from; i < hi; i += 1) {
    if ((y[i] - level) * (y[i + 1] - level) <= 0) return i;
  }
  return null;
}

/**
 * Auto-detect transitions on one segment (§3.6): peaks first (melt,
 * crystallization, cold crystallization, cure), then at most one glass step
 * outside every peak window. Every feature gets `auto: true`.
 */
export function autoDetectFeatures(view: SegmentView, segment: DscSegment, params: DscParams): DscFeature[] {
  const n = Math.min(view.tempC.length, view.heatFlow.length);
  if (n < 10) return [];

  const { d, candidates, steps } = detectPeakCandidates(view, params);

  // §3.6.4: classify by segment kind and sign (exo-up convention: d > 0 exo).
  const meltTemps: number[] = [];
  for (const c of candidates) {
    if (segment.kind === "heat" && d[c.peakIdx] < 0) meltTemps.push(view.tempC[c.peakIdx]);
  }
  const minMelt = meltTemps.length > 0 ? Math.min(...meltTemps) : null;

  const counts: Partial<Record<DscFeatureKind, number>> = {};
  const nextLabel = (kind: DscFeatureKind, base: string): string => {
    const c = (counts[kind] ?? 0) + 1;
    counts[kind] = c;
    return `${base} ${c}`;
  };

  const features: DscFeature[] = [];
  for (const c of candidates) {
    const exo = d[c.peakIdx] > 0;
    const peakTempC = view.tempC[c.peakIdx];
    let kind: DscFeatureKind;
    if (segment.kind === "cool" && exo) kind = "crystallization";
    else if (segment.kind === "heat" && !exo) kind = "melt";
    else if (segment.kind === "heat" && exo) kind = minMelt != null && peakTempC < minMelt ? "coldCrystallization" : "cure";
    else if (segment.kind === "isothermal" && exo) kind = "cure";
    else kind = "custom";

    const base =
      kind === "crystallization"
        ? "Crystallization"
        : kind === "melt"
          ? "Melt"
          : kind === "coldCrystallization"
            ? "Cold crystallization"
            : kind === "cure"
              ? "Cure"
              : "Feature";
    const label = nextLabel(kind, base);

    features.push({
      id: `${segment.id}:auto:${kind}:${counts[kind]}`,
      segmentId: segment.id,
      kind,
      label,
      window: [view.tempC[c.lo], view.tempC[c.hi]],
      baseline: null,
      baselineMode: "linear",
      auto: true,
      visible: true,
    });
  }

  // §3.6.5: at most one glass feature, found AFTER the peaks. Prefer the
  // strongest step the discriminator above pulled out of the peak-candidate
  // pass itself (largest |stepHeight|) — a real Tg absorbed whole by
  // `detectPeakCandidates`' global baseline never reaches
  // `detectGlassCandidate` at all, since that fallback only searches OUTSIDE
  // every peak window and the step consumed the entire segment as "inside"
  // one (DAC1.tri, DAC3.tri). Only fall back to the outside-every-peak search
  // when the discriminator found nothing — the pre-existing behaviour for
  // every segment whose Tg is small enough that it never gets picked up as a
  // `detectPeakCandidates` local extremum in the first place.
  let glass: DscFeature | null = null;
  if (steps.length > 0) {
    const strongest = steps.reduce((a, b) => (Math.abs(b.stepHeight) > Math.abs(a.stepHeight) ? b : a));
    glass = {
      id: `${segment.id}:auto:glass:1`,
      segmentId: segment.id,
      kind: "glass",
      label: "Glass transition",
      window: strongest.windowC,
      baseline: null,
      baselineMode: "linear",
      auto: true,
      visible: true,
    };
  } else {
    glass = detectGlassCandidate(
      view,
      segment,
      params,
      candidates.map((c) => ({ lo: c.lo, hi: c.hi })),
    );
  }
  if (glass) features.push(glass);

  return features;
}

// ---------------------------------------------------------------------------
// §3.8 Cure and OIT
// ---------------------------------------------------------------------------

/** `1 - residual/total`. Null when `totalJPerG` is not a positive finite
 *  number or `residualJPerG` is not finite. */
export function degreeOfCure(totalJPerG: number, residualJPerG: number): number | null {
  if (!Number.isFinite(totalJPerG) || totalJPerG <= 0 || !Number.isFinite(residualJPerG)) return null;
  return 1 - residualJPerG / totalJPerG;
}

/**
 * Oxidative induction time. Applies only to an isothermal segment (temperature
 * span < 1 °C, mirroring `segments.ts`'s `classifySegment` threshold) — a
 * ramp returns nulls. Fits a baseline over the first 20 % of the hold, finds
 * the steepest rise via the time-domain derivative, fits a ±5 point tangent
 * there, and intersects it with the baseline.
 */
export function oxidativeInductionTime(
  view: SegmentView,
  holdStartMin: number,
): { onsetMin: number | null; oitMin: number | null } {
  const NULL_RESULT = { onsetMin: null, oitMin: null };
  const n = Math.min(view.timeMin.length, view.heatFlow.length, view.tempC.length);
  if (n < 10) return NULL_RESULT;

  let tMin = Infinity;
  let tMax = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const t = view.tempC[i];
    if (Number.isFinite(t)) {
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
  }
  if (tMax - tMin >= 1) return NULL_RESULT; // not isothermal

  const baseCount = Math.max(2, Math.round(n * 0.2));
  const baseline = fitLine(view.timeMin, view.heatFlow, 0, baseCount - 1);
  if (!Number.isFinite(baseline.slope)) return NULL_RESULT;

  const dHFdt = computeTimeDerivative(view, view.smoothWindow);
  const steepIdx = argmax(absArray(dHFdt), baseCount, n);
  if (steepIdx < 0) return NULL_RESULT;

  const tangent = fitLine(view.timeMin, view.heatFlow, steepIdx - 5, steepIdx + 5);
  if (!Number.isFinite(tangent.slope)) return NULL_RESULT;

  const onset = lineIntersectionX(tangent.slope, tangent.intercept, baseline.slope, baseline.intercept);
  if (!Number.isFinite(onset)) return NULL_RESULT;

  return { onsetMin: onset, oitMin: onset - holdStartMin };
}

// ---------------------------------------------------------------------------
// §3.9 Result type
// ---------------------------------------------------------------------------

/** Per-feature analysis result, tagged by the feature's kind. */
export type DscFeatureResult =
  | { kind: "glass"; glass: GlassResult }
  | { kind: "oit"; oit: { onsetMin: number | null; oitMin: number | null } }
  | { kind: "melt" | "crystallization" | "coldCrystallization" | "cure" | "custom"; peak: PeakResult };

export interface DscAnalysis {
  segmentId: string;
  view: SegmentView; // for the plot/figure — already normalized and sign-applied
  deriv: Float64Array; // NaN = gap
  results: Record<string, DscFeatureResult>; // keyed by feature id
  glass: GlassResult | null; // the primary (first) glass feature, for the summary strip
  melt: PeakResult | null; // largest-|ΔH| melt
  crystallization: PeakResult | null;
  coldCrystallization: PeakResult | null;
  cure: PeakResult | null;
  crystallinityPct: number | null;
  normDivisorMg: number | null;
  warnings: string[];
}

function firstGlass(features: DscFeature[], results: Record<string, DscFeatureResult>): GlassResult | null {
  for (const f of features) {
    if (f.kind !== "glass") continue;
    const r = results[f.id];
    if (r && r.kind === "glass") return r.glass;
  }
  return null;
}

function largestPeakOfKind(
  features: DscFeature[],
  results: Record<string, DscFeatureResult>,
  kind: "melt" | "crystallization" | "coldCrystallization" | "cure",
): PeakResult | null {
  let best: PeakResult | null = null;
  let bestAbs = -Infinity;
  for (const f of features) {
    if (f.kind !== kind) continue;
    const r = results[f.id];
    if (!r || r.kind === "glass" || r.kind === "oit") continue;
    const absV = r.peak.enthalpyJPerG != null ? Math.abs(r.peak.enthalpyJPerG) : -Infinity;
    if (absV > bestAbs) {
      bestAbs = absV;
      best = r.peak;
    }
  }
  return best;
}

/**
 * Top-level DSC analysis of one run (§3.9). Resolves the active segment,
 * builds its view, computes the derivative, analyzes every feature on that
 * segment (auto-detecting first when `run.features` has none for it and
 * `params.autoDetect` is on), and derives the summary-strip convenience
 * fields plus % crystallinity. Never throws — degenerate input (no segments,
 * too little data, zero/missing mass, an isothermal active segment) returns
 * nulls plus a warning, never an exception.
 */
export function computeDscAnalysis(run: DscRun, params: DscParams): DscAnalysis {
  const warnings: string[] = [];
  const emptyAnalysis = (segmentId: string): DscAnalysis => ({
    segmentId,
    view: EMPTY_VIEW,
    deriv: new Float64Array(0),
    results: {},
    glass: null,
    melt: null,
    crystallization: null,
    coldCrystallization: null,
    cure: null,
    crystallinityPct: null,
    normDivisorMg: null,
    warnings,
  });

  try {
    if (!run || !Array.isArray(run.segments) || run.segments.length === 0) {
      warnings.push("This run has no segments to analyze.");
      return emptyAnalysis("");
    }

    const segmentId = run.activeSegmentId ?? defaultSegmentId(run.segments);
    const segment = run.segments.find((s) => s.id === segmentId) ?? run.segments[0];
    if (!segment || segment.end - segment.start < 2) {
      warnings.push("Selected segment has too little data to analyze.");
      return emptyAnalysis(segment?.id ?? "");
    }

    const view = segmentView(run, segment, params);
    if (view.tempC.length < 2) {
      warnings.push("Selected segment has too little data to analyze.");
      return emptyAnalysis(segment.id);
    }

    if (params.normMode === "wattsPerGram") {
      // A cheap probe (empty array) just to read the mass-validity warning
      // from the single source of truth, without redoing the full pass
      // `segmentView` already did internally.
      const probe = toWattsPerGram(new Float64Array(0), resolveSampleMassMg(run));
      if (probe.warning) warnings.push(probe.warning);
    }

    const deriv = computeDerivative(view, params.smoothWindow);

    let features = run.features.filter((f) => f.segmentId === segment.id);
    if (features.length === 0 && params.autoDetect) {
      features = autoDetectFeatures(view, segment, params);
    }

    const results: Record<string, DscFeatureResult> = {};
    for (const feature of features) {
      if (feature.kind === "glass") {
        results[feature.id] = { kind: "glass", glass: glassTransition(view, feature.window) };
      } else if (feature.kind === "oit") {
        results[feature.id] = { kind: "oit", oit: oxidativeInductionTime(view, feature.window[0]) };
      } else {
        const anchors = feature.baseline ?? feature.window;
        results[feature.id] = { kind: feature.kind, peak: peakTransition(view, run, feature.window, anchors) };
      }
    }

    const glass = firstGlass(features, results);
    const melt = largestPeakOfKind(features, results, "melt");
    const crystallization = largestPeakOfKind(features, results, "crystallization");
    const coldCrystallization = largestPeakOfKind(features, results, "coldCrystallization");
    const cure = largestPeakOfKind(features, results, "cure");

    const ref = run.referenceId ? allReferences().find((r) => r.id === run.referenceId) : undefined;
    const crystallinityPct = ref
      ? crystallinity(melt?.enthalpyJPerG ?? 0, coldCrystallization?.enthalpyJPerG ?? 0, ref.enthalpy100JPerG, run.polymerFraction)
      : null;

    const mass = resolveSampleMassMg(run);
    const normDivisorMg = params.normMode === "wattsPerGram" && mass != null && mass > 0 ? mass : null;

    return {
      segmentId: segment.id,
      view,
      deriv,
      results,
      glass,
      melt,
      crystallization,
      coldCrystallization,
      cure,
      crystallinityPct,
      normDivisorMg,
      warnings,
    };
  } catch (err) {
    warnings.push(`DSC analysis failed: ${err instanceof Error ? err.message : String(err)}`);
    return emptyAnalysis(run?.activeSegmentId ?? "");
  }
}
