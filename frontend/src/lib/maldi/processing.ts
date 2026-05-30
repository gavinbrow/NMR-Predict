// Spectrum processing: baseline correction, smoothing, normalization, cropping,
// calibration, and view downsampling.
//
// Every function is pure and returns *new* arrays — the raw spectrum is never
// mutated, so processed data is always re-derivable from the raw spectrum plus
// the ordered step list (the project's source of truth). `applyProcessing` is the
// pipeline runner the worker calls; the individual functions are exported so they
// can be unit-tested and previewed in isolation.

import savitzkyGolay from "ml-savitzky-golay";
import { PolynomialRegression } from "ml-regression-polynomial";
import type { ProcessingStep, SpectrumData } from "./types";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clone(spectrum: SpectrumData): SpectrumData {
  return {
    mz: Float64Array.from(spectrum.mz),
    intensity: Float64Array.from(spectrum.intensity),
  };
}

function maxOf(values: Float64Array): number {
  let m = -Infinity;
  for (let i = 0; i < values.length; i += 1) if (values[i] > m) m = values[i];
  return m;
}

function sumOf(values: Float64Array): number {
  let s = 0;
  for (let i = 0; i < values.length; i += 1) s += values[i];
  return s;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Baseline correction
// ---------------------------------------------------------------------------

export type BaselineMethod = "snip" | "rollingBall" | "als";

export interface BaselineParams {
  method: BaselineMethod;
  /** SNIP: number of clipping iterations (≈ half-width of the widest peak in points). */
  iterations?: number;
  /** Rolling-ball/top-hat: structuring-element half-width in points. */
  windowPoints?: number;
  /** ALS smoothness (λ). Larger = stiffer baseline. */
  lambda?: number;
  /** ALS asymmetry (p), 0<p<1. Smaller = baseline hugs the underside. */
  p?: number;
}

/** Log-log-square-root transform used by SNIP for dynamic-range stability. */
function lls(value: number): number {
  return Math.log(Math.log(Math.sqrt(Math.max(value, 0) + 1) + 1) + 1);
}
function invLls(value: number): number {
  const a = Math.exp(Math.exp(value) - 1) - 1;
  return a * a - 1;
}

/** SNIP baseline estimate (returns the baseline, not the corrected signal). */
export function snipBaseline(intensity: Float64Array, iterations: number): Float64Array {
  const n = intensity.length;
  const v = new Float64Array(n);
  for (let i = 0; i < n; i += 1) v[i] = lls(intensity[i]);
  const next = new Float64Array(n);
  for (let p = 1; p <= iterations; p += 1) {
    for (let i = 0; i < n; i += 1) {
      if (i >= p && i < n - p) {
        const avg = (v[i - p] + v[i + p]) / 2;
        next[i] = Math.min(v[i], avg);
      } else {
        next[i] = v[i];
      }
    }
    v.set(next);
  }
  const baseline = new Float64Array(n);
  for (let i = 0; i < n; i += 1) baseline[i] = invLls(v[i]);
  return baseline;
}

/** 1-D minimum filter over a centered window of half-width `r`. */
function minFilter(y: Float64Array, r: number): Float64Array {
  const n = y.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let m = Infinity;
    const lo = Math.max(0, i - r);
    const hi = Math.min(n - 1, i + r);
    for (let j = lo; j <= hi; j += 1) if (y[j] < m) m = y[j];
    out[i] = m;
  }
  return out;
}

/** 1-D maximum filter over a centered window of half-width `r`. */
function maxFilter(y: Float64Array, r: number): Float64Array {
  const n = y.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let m = -Infinity;
    const lo = Math.max(0, i - r);
    const hi = Math.min(n - 1, i + r);
    for (let j = lo; j <= hi; j += 1) if (y[j] > m) m = y[j];
    out[i] = m;
  }
  return out;
}

/**
 * Rolling-ball / top-hat baseline: a morphological opening (erosion then
 * dilation) estimates the slowly-varying background under the peaks.
 */
export function rollingBallBaseline(intensity: Float64Array, windowPoints: number): Float64Array {
  const r = Math.max(1, Math.round(windowPoints));
  return maxFilter(minFilter(intensity, r), r);
}

/**
 * Solve a symmetric positive-definite pentadiagonal system A·x = b in O(n) via a
 * banded Cholesky factorization. `ad` is the main diagonal, `a1` the first
 * off-diagonal (length n-1), `a2` the second (length n-2). Used by ALS.
 */
function solvePentadiagonal(
  ad: Float64Array,
  a1: Float64Array,
  a2: Float64Array,
  b: Float64Array,
): Float64Array {
  const n = ad.length;
  const ld = new Float64Array(n);
  const l1 = new Float64Array(Math.max(0, n - 1));
  const l2 = new Float64Array(Math.max(0, n - 2));

  for (let i = 0; i < n; i += 1) {
    let d = ad[i];
    if (i >= 1) d -= l1[i - 1] * l1[i - 1];
    if (i >= 2) d -= l2[i - 2] * l2[i - 2];
    ld[i] = Math.sqrt(Math.max(d, 1e-12));
    if (i <= n - 2) {
      let off = a1[i];
      if (i >= 1) off -= l2[i - 1] * l1[i - 1];
      l1[i] = off / ld[i];
    }
    if (i <= n - 3) {
      l2[i] = a2[i] / ld[i];
    }
  }

  // Forward solve L·y = b.
  const y = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let s = b[i];
    if (i >= 1) s -= l1[i - 1] * y[i - 1];
    if (i >= 2) s -= l2[i - 2] * y[i - 2];
    y[i] = s / ld[i];
  }
  // Backward solve Lᵀ·x = y.
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i -= 1) {
    let s = y[i];
    if (i <= n - 2) s -= l1[i] * x[i + 1];
    if (i <= n - 3) s -= l2[i] * x[i + 2];
    x[i] = s / ld[i];
  }
  return x;
}

/**
 * Asymmetric Least Squares (Eilers & Boelens) baseline. Iteratively solves
 * (W + λ·DᵀD)·z = W·y, re-weighting points above the current estimate down so
 * the baseline settles under the peaks. DᵀD is pentadiagonal, so each iteration
 * is O(n).
 */
export function alsBaseline(
  intensity: Float64Array,
  lambda: number,
  p: number,
  iterations = 10,
): Float64Array {
  const n = intensity.length;
  if (n < 3) return Float64Array.from(intensity);

  // Constant part of the system: λ·DᵀD for a 2nd-order difference penalty.
  // Diagonals of DᵀD: main [1,5,6,…,6,5,1], off1 [-2,-4,…,-4,-2], off2 [1,…,1].
  const cDiag = new Float64Array(n);
  const cOff1 = new Float64Array(n - 1);
  const cOff2 = new Float64Array(n - 2);
  for (let i = 0; i < n; i += 1) {
    if (i === 0 || i === n - 1) cDiag[i] = 1;
    else if (i === 1 || i === n - 2) cDiag[i] = 5;
    else cDiag[i] = 6;
  }
  for (let i = 0; i < n - 1; i += 1) cOff1[i] = i === 0 || i === n - 2 ? -2 : -4;
  for (let i = 0; i < n - 2; i += 1) cOff2[i] = 1;

  let z = Float64Array.from(intensity);
  const w = new Float64Array(n).fill(1);
  const ad = new Float64Array(n);
  const a1 = new Float64Array(n - 1);
  const a2 = new Float64Array(n - 2);
  const b = new Float64Array(n);

  for (let iter = 0; iter < iterations; iter += 1) {
    for (let i = 0; i < n; i += 1) ad[i] = w[i] + lambda * cDiag[i];
    for (let i = 0; i < n - 1; i += 1) a1[i] = lambda * cOff1[i];
    for (let i = 0; i < n - 2; i += 1) a2[i] = lambda * cOff2[i];
    for (let i = 0; i < n; i += 1) b[i] = w[i] * intensity[i];
    z = solvePentadiagonal(ad, a1, a2, b);
    for (let i = 0; i < n; i += 1) w[i] = intensity[i] > z[i] ? p : 1 - p;
  }
  return z;
}

/** Subtract a baseline and clamp negatives to zero. */
function subtractBaseline(intensity: Float64Array, baseline: Float64Array): Float64Array {
  const out = new Float64Array(intensity.length);
  for (let i = 0; i < intensity.length; i += 1) out[i] = Math.max(0, intensity[i] - baseline[i]);
  return out;
}

export function applyBaseline(spectrum: SpectrumData, params: BaselineParams): SpectrumData {
  let baseline: Float64Array;
  if (params.method === "snip") {
    baseline = snipBaseline(spectrum.intensity, Math.max(1, Math.round(num(params.iterations, 40))));
  } else if (params.method === "rollingBall") {
    baseline = rollingBallBaseline(spectrum.intensity, num(params.windowPoints, 50));
  } else {
    baseline = alsBaseline(spectrum.intensity, num(params.lambda, 1e5), num(params.p, 0.01));
  }
  return { mz: Float64Array.from(spectrum.mz), intensity: subtractBaseline(spectrum.intensity, baseline) };
}

// ---------------------------------------------------------------------------
// Smoothing
// ---------------------------------------------------------------------------

export type SmoothMethod = "savitzkyGolay" | "gaussian" | "movingAverage";

export interface SmoothParams {
  method: SmoothMethod;
  /** Window size in points (forced odd where required). */
  windowSize?: number;
  /** SG polynomial order. */
  polynomial?: number;
  /** Gaussian standard deviation in points. */
  sigma?: number;
}

function ensureOdd(value: number): number {
  const w = Math.max(3, Math.round(value));
  return w % 2 === 0 ? w + 1 : w;
}

/** SG via ml-savitzky-golay, re-centered and edge-replicated to keep length n. */
function savitzkyGolaySmooth(y: Float64Array, windowSize: number, polynomial: number): Float64Array {
  const n = y.length;
  const w = Math.min(ensureOdd(windowSize), n % 2 === 0 ? n - 1 : n);
  if (w < 3) return Float64Array.from(y);
  const half = (w - 1) / 2;
  const smoothed = savitzkyGolay(Array.from(y), 1, {
    windowSize: w,
    polynomial: Math.min(polynomial, w - 1),
    derivative: 0,
    pad: "none",
  });
  // SG with no padding returns indices [half, n-1-half]; place and replicate edges.
  const out = new Float64Array(n);
  for (let i = 0; i < smoothed.length; i += 1) out[half + i] = smoothed[i];
  for (let i = 0; i < half; i += 1) out[i] = out[half];
  for (let i = n - half; i < n; i += 1) out[i] = out[n - half - 1];
  return out;
}

function gaussianSmooth(y: Float64Array, sigma: number): Float64Array {
  const n = y.length;
  const s = Math.max(0.5, sigma);
  const radius = Math.max(1, Math.ceil(s * 3));
  const kernel = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let k = -radius; k <= radius; k += 1) {
    const v = Math.exp(-(k * k) / (2 * s * s));
    kernel[k + radius] = v;
    sum += v;
  }
  for (let k = 0; k < kernel.length; k += 1) kernel[k] /= sum;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let acc = 0;
    let wsum = 0;
    for (let k = -radius; k <= radius; k += 1) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      acc += y[j] * kernel[k + radius];
      wsum += kernel[k + radius];
    }
    out[i] = acc / wsum;
  }
  return out;
}

function movingAverageSmooth(y: Float64Array, windowSize: number): Float64Array {
  const n = y.length;
  const r = Math.max(1, Math.floor(Math.max(3, windowSize) / 2));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const lo = Math.max(0, i - r);
    const hi = Math.min(n - 1, i + r);
    let acc = 0;
    for (let j = lo; j <= hi; j += 1) acc += y[j];
    out[i] = acc / (hi - lo + 1);
  }
  return out;
}

export function applySmooth(spectrum: SpectrumData, params: SmoothParams): SpectrumData {
  let intensity: Float64Array;
  if (params.method === "savitzkyGolay") {
    intensity = savitzkyGolaySmooth(
      spectrum.intensity,
      num(params.windowSize, 9),
      Math.round(num(params.polynomial, 3)),
    );
  } else if (params.method === "gaussian") {
    intensity = gaussianSmooth(spectrum.intensity, num(params.sigma, 2));
  } else {
    intensity = movingAverageSmooth(spectrum.intensity, num(params.windowSize, 5));
  }
  return { mz: Float64Array.from(spectrum.mz), intensity };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export type NormalizeMethod = "basePeak" | "tic" | "max";

export interface NormalizeParams {
  method: NormalizeMethod;
  /** Target value for the base/max peak (default 100 for base peak, 1 for max). */
  target?: number;
}

export function applyNormalize(spectrum: SpectrumData, params: NormalizeParams): SpectrumData {
  const { intensity } = spectrum;
  let divisor: number;
  let scale: number;
  if (params.method === "tic") {
    divisor = sumOf(intensity) || 1;
    scale = num(params.target, 1);
  } else if (params.method === "max") {
    divisor = maxOf(intensity) || 1;
    scale = num(params.target, 1);
  } else {
    divisor = maxOf(intensity) || 1;
    scale = num(params.target, 100);
  }
  const out = new Float64Array(intensity.length);
  for (let i = 0; i < intensity.length; i += 1) out[i] = (intensity[i] / divisor) * scale;
  return { mz: Float64Array.from(spectrum.mz), intensity: out };
}

// ---------------------------------------------------------------------------
// Cropping
// ---------------------------------------------------------------------------

export interface CropParams {
  min: number;
  max: number;
}

export function applyCrop(spectrum: SpectrumData, params: CropParams): SpectrumData {
  const lo = Math.min(params.min, params.max);
  const hi = Math.max(params.min, params.max);
  const mz: number[] = [];
  const intensity: number[] = [];
  for (let i = 0; i < spectrum.mz.length; i += 1) {
    if (spectrum.mz[i] >= lo && spectrum.mz[i] <= hi) {
      mz.push(spectrum.mz[i]);
      intensity.push(spectrum.intensity[i]);
    }
  }
  return { mz: Float64Array.from(mz), intensity: Float64Array.from(intensity) };
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

export interface CalibrationPoint {
  /** Observed (measured) m/z of a calibrant peak. */
  measured: number;
  /** Known reference m/z it should be. */
  reference: number;
}

export interface CalibrateParams {
  /** Calibrant pairs, JSON-encoded so they fit the scalar ProcessingStep param bag. */
  pointsJson: string;
  /** 1 = linear, ≥2 = polynomial. */
  degree?: number;
}

export function parseCalibrationPoints(pointsJson: string): CalibrationPoint[] {
  try {
    const parsed = JSON.parse(pointsJson) as CalibrationPoint[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (pt) => Number.isFinite(pt?.measured) && Number.isFinite(pt?.reference),
    );
  } catch {
    return [];
  }
}

/**
 * Build a calibration transform m/z → corrected m/z from calibrant pairs. With a
 * single pair it applies a constant offset; with two it is linear; with more it
 * fits a polynomial of the requested degree (capped at points-1).
 */
export function buildCalibration(points: CalibrationPoint[], degree: number): (mz: number) => number {
  if (points.length === 0) return (mz) => mz;
  if (points.length === 1) {
    const shift = points[0].reference - points[0].measured;
    return (mz) => mz + shift;
  }
  const safeDegree = Math.max(1, Math.min(Math.round(degree), points.length - 1));
  const x = points.map((pt) => pt.measured);
  const y = points.map((pt) => pt.reference);
  const reg = new PolynomialRegression(x, y, safeDegree);
  return (mz) => reg.predict(mz);
}

export function applyCalibrate(spectrum: SpectrumData, params: CalibrateParams): SpectrumData {
  const points = parseCalibrationPoints(params.pointsJson);
  const transform = buildCalibration(points, num(params.degree, 1));
  const mz = new Float64Array(spectrum.mz.length);
  for (let i = 0; i < spectrum.mz.length; i += 1) mz[i] = transform(spectrum.mz[i]);
  return { mz, intensity: Float64Array.from(spectrum.intensity) };
}

// ---------------------------------------------------------------------------
// Pipeline runner
// ---------------------------------------------------------------------------

/**
 * Apply an ordered list of processing steps to the raw spectrum, returning a new
 * processed spectrum. Disabled steps are skipped. The raw spectrum is never
 * mutated, so this is fully re-derivable from `(raw, steps)`.
 */
export function applyProcessing(raw: SpectrumData, steps: ProcessingStep[]): SpectrumData {
  let current = clone(raw);
  for (const step of steps) {
    if (!step.enabled) continue;
    switch (step.kind) {
      case "baseline":
        current = applyBaseline(current, step.params as unknown as BaselineParams);
        break;
      case "smooth":
        current = applySmooth(current, step.params as unknown as SmoothParams);
        break;
      case "normalize":
        current = applyNormalize(current, step.params as unknown as NormalizeParams);
        break;
      case "crop":
        current = applyCrop(current, step.params as unknown as CropParams);
        break;
      case "calibrate":
        current = applyCalibrate(current, step.params as unknown as CalibrateParams);
        break;
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// Downsampling for the full-spectrum view
// ---------------------------------------------------------------------------

// The view helpers (downsample, sliceRange) live in a dependency-free module so
// the main-thread plot can use them without pulling the heavy numeric libraries
// above into its bundle. Re-exported here for callers (and tests) that already
// work with the processing module.
export { downsample, sliceRange } from "./view";
