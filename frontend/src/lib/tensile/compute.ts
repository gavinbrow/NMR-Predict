// Tensile property compute engine — a TypeScript port of the math half of
// `tensile_analyze.py` (`_clean`, `_linfit`, `youngs_modulus`, `offset_yield`,
// `yield_point`, `extract_run`, and the pooled statistics).
//
// Everything here is pure: given a raw curve and the analysis parameters it
// returns the computed properties, so it is trivially unit-testable and can be
// re-run on every parameter change (Phase 6) without side effects. Strain is
// handled in percent internally; stresses/moduli are MPa.
//
// `NaN` is used for "not available" exactly where the Python uses `np.nan` — the
// UI is responsible for rendering `NaN` as "N/A".

import type { AnalysisParams, MachineResults, PropertyKey, PropertyStats, RunProps } from "./types";

// --------------------------------------------------------------------------- //
// CONFIG defaults (mirror the Python CONFIG block)                            //
// --------------------------------------------------------------------------- //

/** Default analysis parameters — identical to the Python defaults. */
export const DEFAULT_PARAMS: AnalysisParams = {
  eLo: 0.05, // E_LO  (%)
  eHi: 0.25, // E_HI  (%)
  offsetPct: 0.2, // OFFSET_PCT
  peakDropFrac: 0.02, // PEAK_DROP_FRAC
  breakDefinition: { mode: "last" },
  strainUnitOverride: "auto",
};

/** The numeric property keys, in the Python `PROPERTIES` order, with labels. */
export const PROPERTY_META: {
  key: PropertyKey;
  label: string;
  /** Decimal places for display. */
  decimals: number;
  /** Short unit suffix for axis/column headers. */
  unit: string;
}[] = [
  { key: "E_MPa", label: "Young's modulus", decimals: 1, unit: "MPa" },
  { key: "E_GPa", label: "Young's modulus", decimals: 3, unit: "GPa" },
  { key: "uts_MPa", label: "Tensile strength / UTS", decimals: 2, unit: "MPa" },
  { key: "strain_at_uts", label: "Strain at UTS", decimals: 2, unit: "%" },
  { key: "yield_pk_MPa", label: "Yield strength", decimals: 2, unit: "MPa" },
  { key: "yield_pk_pct", label: "Yield strain", decimals: 2, unit: "%" },
  { key: "yield_off_MPa", label: "0.2% offset yield", decimals: 2, unit: "MPa" },
  { key: "yield_off_pct", label: "0.2% offset strain", decimals: 2, unit: "%" },
  { key: "break_MPa", label: "Stress at break", decimals: 2, unit: "MPa" },
  { key: "elong_break", label: "Elongation at break", decimals: 2, unit: "%" },
  { key: "toughness", label: "Toughness", decimals: 2, unit: "MJ/m³" },
];

/**
 * Map computed property keys → the instrument's `Results`-sheet column headers
 * (Phase 8), a port of the Python `MACHINE_MAP`. Used to line the machine's own
 * numbers up against the computed ones, for reference only.
 */
export const MACHINE_MAP: { prop: PropertyKey; machine: keyof MachineResults }[] = [
  { prop: "E_MPa", machine: "Et" },
  { prop: "uts_MPa", machine: "sM" },
  { prop: "strain_at_uts", machine: "eM" },
  { prop: "break_MPa", machine: "sB" },
  { prop: "elong_break", machine: "eB" },
];

// --------------------------------------------------------------------------- //
// Numeric helpers (np.argsort / np.interp / np.searchsorted / np.trapezoid)   //
// --------------------------------------------------------------------------- //

/** A cleaned curve: strain in %, stress in MPa, both strictly ascending in strain. */
export interface CleanCurve {
  /** Strain in percent, strictly increasing. */
  s: number[];
  /** Stress in MPa, aligned to `s`. */
  st: number[];
}

/**
 * Port of `_clean`: drop non-finite pairs, convert strain → % when needed, sort
 * by strain ascending, then trim leading preload by keeping only strictly
 * increasing strain (drops duplicate/decreasing points).
 */
export function cleanCurve(
  strain: number[],
  stress: number[],
  strainIsPercent: boolean,
): CleanCurve {
  const n = Math.min(strain.length, stress.length);
  const pairs: [number, number][] = [];
  for (let i = 0; i < n; i += 1) {
    const sRaw = strainIsPercent ? strain[i] : strain[i] * 100;
    const st = stress[i];
    if (Number.isFinite(sRaw) && Number.isFinite(st)) pairs.push([sRaw, st]);
  }
  // Stable ascending sort by strain (np.argsort is stable for ties).
  pairs.sort((a, b) => a[0] - b[0]);

  const s: number[] = [];
  const st: number[] = [];
  for (const [sv, stv] of pairs) {
    if (s.length === 0 || sv > s[s.length - 1] + 1e-12) {
      s.push(sv);
      st.push(stv);
    }
  }
  return { s, st };
}

/** Least-squares line fit (port of `_linfit`): slope, intercept, R². */
export function linfit(x: number[], y: number[]): { slope: number; intercept: number; r2: number } {
  const n = x.length;
  if (n < 2) return { slope: NaN, intercept: NaN, r2: NaN };
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += x[i];
    sy += y[i];
    sxx += x[i] * x[i];
    sxy += x[i] * y[i];
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: NaN, intercept: NaN, r2: NaN };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const meanY = sy / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    const yhat = slope * x[i] + intercept;
    ssRes += (y[i] - yhat) ** 2;
    ssTot += (y[i] - meanY) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : NaN;
  return { slope, intercept, r2 };
}

/**
 * Linear interpolation with end-clamping, matching `np.interp`. `xs` must be
 * ascending. Returns `ys[0]` below the range and `ys[ys.length-1]` above it.
 */
export function interp(x: number, xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n === 0) return NaN;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  // Binary search for the bracketing interval.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

/** Leftmost insertion index keeping `xs` (ascending) sorted — `np.searchsorted` side="left". */
export function searchSortedLeft(xs: number[], v: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Trapezoidal integral ∫ y dx over paired samples (port of `np.trapezoid`). */
export function trapezoid(y: number[], x: number[]): number {
  let area = 0;
  for (let i = 1; i < y.length; i += 1) {
    area += ((x[i] - x[i - 1]) * (y[i] + y[i - 1])) / 2;
  }
  return area;
}

/** First index of the maximum value (matches `np.argmax`). */
function argmax(arr: number[]): number {
  let best = 0;
  for (let i = 1; i < arr.length; i += 1) {
    if (arr[i] > arr[best]) best = i;
  }
  return best;
}

// --------------------------------------------------------------------------- //
// Property calculations                                                       //
// --------------------------------------------------------------------------- //

interface ModulusFit {
  /** Young's modulus (MPa). */
  E: number;
  /** Slope of the elastic line, MPa per % strain. */
  slopePct: number;
  /** Intercept of the elastic line (MPa). */
  intercept: number;
  /** Human-readable window/method string. */
  method: string;
}

function fmtG(v: number): string {
  // Mimic Python "%g": trim trailing zeros.
  return Number.parseFloat(v.toPrecision(6)).toString();
}

/**
 * Port of `youngs_modulus`: regression over [eLo, eHi] % when ≥3 points fall in
 * the window, else a chord via interpolation at the two bounds. `E = slope×100`.
 */
export function youngsModulus(s: number[], st: number[], params: AnalysisParams): ModulusFit {
  const { eLo, eHi } = params;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] >= eLo && s[i] <= eHi) {
      xs.push(s[i]);
      ys.push(st[i]);
    }
  }
  const n = xs.length;
  let slope: number;
  let intercept: number;
  let method: string;
  if (n >= 3) {
    const fit = linfit(xs, ys);
    slope = fit.slope;
    intercept = fit.intercept;
    method = `${fmtG(eLo)}–${fmtG(eHi)}% regr (n=${n}, R²=${fit.r2.toFixed(3)})`;
  } else {
    const s1 = interp(eLo, s, st);
    const s2 = interp(eHi, s, st);
    slope = (s2 - s1) / (eHi - eLo);
    intercept = s1 - slope * eLo;
    method = `${fmtG(eLo)}–${fmtG(eHi)}% chord (n=${n})`;
  }
  return { E: slope * 100, slopePct: slope, intercept, method };
}

/**
 * Port of `offset_yield`: first downward crossing of the curve with the elastic
 * line shifted +offsetPct along the strain axis. Returns `[NaN, NaN]` if the
 * slope is non-positive or the curve never crosses.
 */
export function offsetYield(
  s: number[],
  st: number[],
  slopePct: number,
  intercept: number,
  params: AnalysisParams,
): { sig: number; eps: number } {
  if (!Number.isFinite(slopePct) || slopePct <= 0) return { sig: NaN, eps: NaN };
  const off = params.offsetPct;
  const start = Math.max(searchSortedLeft(s, off), 1);
  let prevDiff = st[start - 1] - (slopePct * (s[start - 1] - off) + intercept);
  for (let i = start; i < s.length; i += 1) {
    const diff = st[i] - (slopePct * (s[i] - off) + intercept);
    if (prevDiff >= 0 && diff < 0) {
      const t = prevDiff / (prevDiff - diff);
      const eps = s[i - 1] + t * (s[i] - s[i - 1]);
      const sig = st[i - 1] + t * (st[i] - st[i - 1]);
      return { sig, eps };
    }
    prevDiff = diff;
  }
  return { sig: NaN, eps: NaN };
}

/**
 * Port of `yield_point`: yield = first stress maximum (ASTM D638). A distinct
 * intermediate yield (a local max that then drops by ≥ peakDropFrac × UTS and is
 * below UTS) is returned if present; otherwise yield coincides with the UTS.
 */
export function yieldPoint(
  s: number[],
  st: number[],
  uts: number,
  iUts: number,
  params: AnalysisParams,
): { sig: number; eps: number } {
  const drop = params.peakDropFrac * uts;
  for (let i = 1; i < iUts; i += 1) {
    if (st[i] >= st[i - 1] && st[i] >= st[i + 1]) {
      let minAfter = Infinity;
      for (let j = i + 1; j <= iUts; j += 1) minAfter = Math.min(minAfter, st[j]);
      if (Number.isFinite(minAfter) && st[i] - minAfter >= drop && st[i] < uts) {
        return { sig: st[i], eps: s[i] };
      }
    }
  }
  return { sig: uts, eps: s[iUts] };
}

/**
 * Locate the break index per the break definition. Returns the last index for
 * "last" (Python default) or the first post-UTS point that falls to/below the
 * configured drop fraction or force threshold.
 */
function breakIndex(st: number[], iUts: number, params: AnalysisParams): number {
  const def = params.breakDefinition;
  const last = st.length - 1;
  if (def.mode === "last") return last;
  const target =
    def.mode === "dropFromPeak" ? (1 - def.dropFrac) * st[iUts] : def.threshold;
  for (let i = iUts + 1; i < st.length; i += 1) {
    if (st[i] <= target) return i;
  }
  return last;
}

/**
 * Port of `extract_run`: clean the curve, then compute UTS, modulus, both
 * yields, break point (per the break definition), and toughness (trapezoid of
 * stress vs strain-as-fraction up to break). All-NaN-ish curves yield NaNs.
 */
export function extractRun(
  strain: number[],
  stress: number[],
  strainIsPercent: boolean = true,
  params: AnalysisParams = DEFAULT_PARAMS,
): RunProps {
  const { s, st } = cleanCurve(strain, stress, strainIsPercent);
  if (s.length === 0) {
    return {
      E_MPa: NaN,
      E_GPa: NaN,
      E_method: "no data",
      uts_MPa: NaN,
      strain_at_uts: NaN,
      yield_pk_MPa: NaN,
      yield_pk_pct: NaN,
      yield_off_MPa: NaN,
      yield_off_pct: NaN,
      break_MPa: NaN,
      elong_break: NaN,
      toughness: NaN,
    };
  }

  const iUts = argmax(st);
  const uts = st[iUts];
  const { E, slopePct, intercept, method } = youngsModulus(s, st, params);
  const off = offsetYield(s, st, slopePct, intercept, params);
  const pk = yieldPoint(s, st, uts, iUts, params);

  const iBreak = breakIndex(st, iUts, params);
  const toughness =
    iBreak > 0
      ? trapezoid(
          st.slice(0, iBreak + 1),
          s.slice(0, iBreak + 1).map((v) => v / 100),
        )
      : NaN;

  return {
    E_MPa: E,
    E_GPa: Number.isFinite(E) ? E / 1000 : NaN,
    E_method: method,
    uts_MPa: uts,
    strain_at_uts: s[iUts],
    yield_pk_MPa: pk.sig,
    yield_pk_pct: pk.eps,
    yield_off_MPa: off.sig,
    yield_off_pct: off.eps,
    break_MPa: st[iBreak],
    elong_break: s[iBreak],
    toughness,
  };
}

// --------------------------------------------------------------------------- //
// Pooled statistics                                                           //
// --------------------------------------------------------------------------- //

/**
 * Pooled statistics over a set of values: mean, sample SD (ddof = 1), CV%, n,
 * min, max. Non-finite values are dropped first (matching the Python `_values`).
 * Returns all-NaN with n = 0 when nothing finite remains.
 */
export function summarize(values: number[]): PropertyStats {
  const finite = values.filter((v) => Number.isFinite(v));
  const n = finite.length;
  if (n === 0) return { mean: NaN, sd: NaN, cv: NaN, n: 0, min: NaN, max: NaN };
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of finite) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / n;
  let sd = 0;
  if (n > 1) {
    let ss = 0;
    for (const v of finite) ss += (v - mean) ** 2;
    sd = Math.sqrt(ss / (n - 1));
  }
  const cv = mean !== 0 ? (sd / mean) * 100 : NaN;
  return { mean, sd, cv, n, min, max };
}
