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

/** Fraction of a segment's points, at EITHER end, whose apex a candidate is
 *  rejected for landing inside. Pins a real bug seen on actual `.tri`
 *  files: a DSC ramp's first ~30 s (and, symmetrically, its last) is
 *  instrument thermal lag settling into the new rate, not a transition —
 *  the global baseline fit (also endpoint-averaged over this same 2 %,
 *  above) reacts to it as a sharp deviation, `detectPeakCandidates` picks
 *  it up as a strong local extremum, and it gets auto-classified as a
 *  bogus "cold crystallization" a fraction of a degree into the ramp. */
const EDGE_REJECT_FRACTION = 0.02;

/** §3.6 steps 1-3: global baseline, local-extrema candidates, enthalpy gate,
 *  minimum separation, cap at 6. Greedily picks the strongest remaining
 *  local extremum of either sign — via `localMaximumIndex`/
 *  `localMinimumIndex` over whatever unclaimed index ranges remain — so a
 *  weak/rejected candidate can't be re-picked forever. */
function detectPeakCandidates(view: SegmentView, params: DscParams): { d: Float64Array; candidates: PeakCandidate[] } {
  const n = Math.min(view.tempC.length, view.heatFlow.length);
  const d = new Float64Array(n);
  if (n === 0) return { d, candidates: [] };

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
    const enthalpy = integrateAgainstTime(view, d.subarray(lo, hi + 1), lo);
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

    if (enthalpy != null && Math.abs(enthalpy) >= params.minPeakEnthalpy) {
      candidates.push({ peakIdx: bestIdx, lo, hi, enthalpy });
    }
  }

  candidates.sort((a, b) => a.peakIdx - b.peakIdx);
  return { d, candidates };
}

/** §3.6.5 / §3.4.7: at most one glass-transition candidate, found after the
 *  peaks — the largest step in `hf` outside every peak window. A "step" is a
 *  jump where `|postLine - preLine|` at the midpoint exceeds 0.005 W/g while
 *  the baseline-subtracted area over the same span stays below 0.3 J/g (a
 *  real peak fails that area test; a pure baseline step passes it). The
 *  window half-width is `max(10 °C, 6 × the step's 10-90 % rise width)`. */
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

  let best: { height: number; windowC: [number, number] } | null = null;

  for (let idx = margin; idx < n - margin; idx += 1) {
    if (!Number.isFinite(deriv[idx]) || insidePeak(idx)) continue;
    const av = Math.abs(deriv[idx]);
    if (!(av >= Math.abs(deriv[idx - 1]) && av >= Math.abs(deriv[idx + 1]))) continue; // local extremum of |deriv|

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
    if (stepHeight <= 0.005) continue;

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

  const { d, candidates } = detectPeakCandidates(view, params);

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

  // §3.6.5: at most one glass feature, found AFTER the peaks.
  const glass = detectGlassCandidate(
    view,
    segment,
    params,
    candidates.map((c) => ({ lo: c.lo, hi: c.hi })),
  );
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
