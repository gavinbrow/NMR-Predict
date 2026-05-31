// Kinetics measurement & fitting math (§8) — a faithful port of the Streamlit
// app. Three pieces:
//   - measurePeak: quantify a tracked peak's signal (height or area) inside a
//     wavenumber window, with an optional per-window baseline.
//   - analyze: divide by an optional reference peak, then fit the first-order
//     decay S(t) = S∞ + (S0 − S∞)·exp(−k·t) and derive k, half-life, R², and the
//     final conversion.
//   - fitOrders: linearized 0/1/2 reaction-order comparison via straight-line
//     fits of the transformed signal.
//
// All math runs in the browser; nothing here touches the DOM.

import { levenbergMarquardt } from "ml-levenberg-marquardt";
import { linspace, polyfitDeg1, trapezoid } from "./numerics";
import type {
  KineticsResult,
  MeasureMode,
  OrderFit,
  TimeUnit,
  WindowBaseline,
} from "./types";

/** Plain mean of an array (no NaN handling — callers pass finite slices). */
function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** NumPy-style max: propagates NaN (any NaN → NaN), else the maximum. */
function npMax(values: number[]): number {
  let m = -Infinity;
  for (const v of values) {
    if (Number.isNaN(v)) return NaN;
    if (v > m) m = v;
  }
  return m === -Infinity ? NaN : m;
}

/** NaN-ignoring minimum; NaN if no finite value exists. */
function nanMin(values: number[]): number {
  let m = Infinity;
  for (const v of values) if (Number.isFinite(v) && v < m) m = v;
  return m === Infinity ? NaN : m;
}

/** Coefficient of determination of `yFit` against `y` (1 − SSres/SStot). */
function rSquared(y: number[], yFit: number[]): number {
  const n = Math.min(y.length, yFit.length);
  if (n === 0) return NaN;
  const m = mean(y.slice(0, n));
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    ssRes += (y[i] - yFit[i]) ** 2;
    ssTot += (y[i] - m) ** 2;
  }
  return ssTot === 0 ? NaN : 1 - ssRes / ssTot;
}

// ---------------------------------------------------------------------------
// Peak measurement
// ---------------------------------------------------------------------------

/**
 * Measure a tracked peak's signal inside the window `center ± halfwidth` (cm⁻¹).
 *
 * Per-window baseline: "none" (or < 2 points) → zeros; "linear" → a straight
 * line through the means of the first/last `k = max(1, floor(len/10))` points
 * (constant at `y0` when the two anchors share an x). The corrected signal is
 * `windowAbs − baseline`; `area` integrates `clip(corrected, 0, ∞)` over the
 * window wavenumbers (trapezoid), `height` is `max(corrected)`. An empty window
 * returns NaN.
 */
export function measurePeak(
  wavenumber: number[],
  absorbance: number[],
  center: number,
  halfwidth: number,
  mode: MeasureMode,
  baseline: WindowBaseline,
): number {
  const lo = center - halfwidth;
  const hi = center + halfwidth;
  const wWin: number[] = [];
  const aWin: number[] = [];
  for (let i = 0; i < wavenumber.length; i += 1) {
    const w = wavenumber[i];
    if (w >= lo && w <= hi) {
      wWin.push(w);
      aWin.push(absorbance[i]);
    }
  }
  const len = wWin.length;
  if (len === 0) return NaN;

  let base: number[];
  if (baseline === "none" || len < 2) {
    base = new Array<number>(len).fill(0);
  } else {
    const k = Math.max(1, Math.floor(len / 10));
    const x0 = mean(wWin.slice(0, k));
    const x1 = mean(wWin.slice(len - k));
    const y0 = mean(aWin.slice(0, k));
    const y1 = mean(aWin.slice(len - k));
    if (x1 === x0) {
      base = new Array<number>(len).fill(y0);
    } else {
      const slope = (y1 - y0) / (x1 - x0);
      base = wWin.map((w) => y0 + slope * (w - x0));
    }
  }

  const corrected = aWin.map((a, i) => a - base[i]);
  if (mode === "area") {
    const clipped = corrected.map((v) => (v > 0 ? v : 0));
    return trapezoid(clipped, wWin);
  }
  return npMax(corrected);
}

// ---------------------------------------------------------------------------
// First-order analysis
// ---------------------------------------------------------------------------

/** First-order model S(t) = S∞ + (S0 − S∞)·exp(−k·t). */
function firstOrder(s0: number, sInf: number, k: number, t: number): number {
  return sInf + (s0 - sInf) * Math.exp(-k * t);
}

/**
 * Divide an optional reference series out of a signal, returning NaN wherever
 * the reference is zero or non-finite (those pairs are dropped downstream).
 */
function referenceDivide(signal: number[], reference?: number[] | null): number[] {
  if (!reference) return signal.slice();
  return signal.map((s, i) => {
    const r = reference[i];
    return r ? s / r : NaN;
  });
}

/** Keep only the (time, signal) pairs where both values are finite. */
function finitePairs(time: number[], signal: number[]): { t: number[]; s: number[] } {
  const t: number[] = [];
  const s: number[] = [];
  const n = Math.min(time.length, signal.length);
  for (let i = 0; i < n; i += 1) {
    if (Number.isFinite(time[i]) && Number.isFinite(signal[i])) {
      t.push(time[i]);
      s.push(signal[i]);
    }
  }
  return { t, s };
}

/**
 * Reference-divide, drop non-finite pairs, compute conversion, and (with ≥ 3
 * points) fit the first-order decay. On a failed/degenerate fit `fitOk` is false
 * but the measured points and conversion are still returned.
 */
export function analyze(
  time: number[],
  signal: number[],
  reference?: number[] | null,
): KineticsResult {
  const divided = referenceDivide(signal, reference);
  const { t, s } = finitePairs(time, divided);

  const s0 = s.length > 0 ? s[0] : NaN;
  const sMin = nanMin(s);
  const conversion = s0 === 0 ? s.map(() => 0) : s.map((v) => (s0 - v) / s0);

  const result: KineticsResult = {
    time: t,
    signal: s,
    conversion,
    s0,
    sInf: sMin,
    k: NaN,
    r2: NaN,
    halfLife: NaN,
    finalConversion: NaN,
    fitOk: false,
  };

  if (t.length < 3) return result;

  try {
    const tMax = npMax(t);
    const tMin = nanMin(t);
    const p0 = [s0, sMin, 1 / Math.max(tMax, 1e-9)];
    const fit = levenbergMarquardt(
      { x: t, y: s },
      ([fS0, fSInf, fK]) => (x: number) => firstOrder(fS0, fSInf, fK, x),
      {
        initialValues: p0,
        damping: 1e-3,
        gradientDifference: 1e-4,
        centralDifference: true,
        maxIterations: 400,
        errorTolerance: 1e-12,
      },
    );
    const [fS0, fSInf, fK] = fit.parameterValues;
    const model = t.map((x) => firstOrder(fS0, fSInf, fK, x));

    result.sInf = fSInf;
    result.k = fK;
    result.r2 = rSquared(s, model);
    result.halfLife = fK > 0 ? Math.LN2 / fK : NaN;
    result.finalConversion = fS0 !== 0 ? (fS0 - fSInf) / fS0 : NaN;
    result.fitOk = Number.isFinite(fK) && fK > 0;

    if (result.fitOk) {
      const tFit = linspace(tMin, tMax, 200);
      result.tFit = tFit;
      result.sFit = tFit.map((x) => firstOrder(fS0, fSInf, fK, x));
    }
  } catch {
    result.fitOk = false;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Reaction-order comparison (0 / 1 / 2)
// ---------------------------------------------------------------------------

interface OrderSpec {
  order: 0 | 1 | 2;
  transform: string;
  /** Whether the signal value admits the transform (e.g. S > 0 for ln). */
  valid: (s: number) => boolean;
  /** The linearizing transform applied to the signal. */
  y: (s: number) => number;
  /** Rate constant from the fitted line's slope. */
  kFromSlope: (slope: number) => number;
  /** Units string for k, given the signal & time unit labels. */
  kUnits: (signalUnit: string, timeUnit: string) => string;
}

const ORDER_SPECS: OrderSpec[] = [
  {
    order: 0,
    transform: "S",
    valid: () => true,
    y: (s) => s,
    kFromSlope: (m) => -m,
    kUnits: (su, tu) => `${su}/${tu}`,
  },
  {
    order: 1,
    transform: "ln(S)",
    valid: (s) => s > 0,
    y: (s) => Math.log(s),
    kFromSlope: (m) => -m,
    kUnits: (_su, tu) => `1/${tu}`,
  },
  {
    order: 2,
    transform: "1/S",
    valid: (s) => s !== 0,
    y: (s) => 1 / s,
    kFromSlope: (m) => m,
    kUnits: (su, tu) => `1/(${su}·${tu})`,
  },
];

/**
 * Linearized 0/1/2 reaction-order fits. Reference-normalizes and drops
 * non-finite pairs, then for each order keeps the points whose transform is
 * valid & finite, and (with ≥ 3 of them) does a degree-1 least-squares fit,
 * recording R², k, and the transformed points. Orders with < 3 usable points
 * come back with `ok: false`.
 */
export function fitOrders(
  time: number[],
  signal: number[],
  reference: number[] | null | undefined,
  timeUnit: TimeUnit | string,
  signalUnit: string,
): OrderFit[] {
  const divided = referenceDivide(signal, reference);
  const { t: tAll, s: sAll } = finitePairs(time, divided);

  return ORDER_SPECS.map((spec) => {
    const kUnits = spec.kUnits(signalUnit, String(timeUnit));
    const label = `${spec.transform} vs t`;
    const t: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < tAll.length; i += 1) {
      const sv = sAll[i];
      if (!spec.valid(sv)) continue;
      const yv = spec.y(sv);
      if (!Number.isFinite(yv)) continue;
      t.push(tAll[i]);
      y.push(yv);
    }

    if (t.length < 3) {
      return {
        order: spec.order,
        transform: spec.transform,
        label,
        k: NaN,
        kUnits,
        r2: NaN,
        ok: false,
        t,
        y,
        yFit: [],
        n: t.length,
      };
    }

    const { slope, intercept } = polyfitDeg1(t, y);
    const yFit = t.map((x) => slope * x + intercept);
    return {
      order: spec.order,
      transform: spec.transform,
      label,
      k: spec.kFromSlope(slope),
      kUnits,
      r2: rSquared(y, yFit),
      ok: true,
      t,
      y,
      yFit,
      n: t.length,
    };
  });
}
