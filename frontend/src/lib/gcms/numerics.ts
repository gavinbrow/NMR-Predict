// Small numeric helpers for the GC/MS workspace: binary search on sorted
// Float64Arrays, Savitzky-Golay smoothing, and trapezoidal integration.
//
// These operate on the CSR flat arrays and per-scan slices of `MsRun`; they
// never mutate their inputs and never throw. They are pure utility and are
// shared by the chromatogram, spectrum, and peak-picking layers.

import savitzkyGolay from "ml-savitzky-golay";

/**
 * Index of the last element <= v in an ascending array, or -1 when empty or
 * every element is greater than v. `lo`/`hi` form a half-open `[lo, hi)`.
 */
export function lowerBound(
  arr: Float64Array,
  v: number,
  lo = 0,
  hi = arr.length,
): number {
  let a = lo;
  let b = hi;
  while (a < b) {
    const mid = (a + b) >>> 1;
    if (arr[mid] <= v) a = mid + 1;
    else b = mid;
  }
  // `a` is the first index where arr[a] > v, so the last <= v is a - 1.
  if (a === lo) return -1;
  return a - 1;
}

/**
 * Index of the first element >= v in an ascending array, or `arr.length` when
 * every element is less than v. `lo`/`hi` form a half-open `[lo, hi)`.
 */
export function upperBound(
  arr: Float64Array,
  v: number,
  lo = 0,
  hi = arr.length,
): number {
  let a = lo;
  let b = hi;
  while (a < b) {
    const mid = (a + b) >>> 1;
    if (arr[mid] < v) a = mid + 1;
    else b = mid;
  }
  return a;
}

/**
 * Index of the element closest to v in an ascending array. -1 when empty.
 * Ties go to the lower index.
 */
export function nearestIndex(arr: Float64Array, v: number): number {
  const n = arr.length;
  if (n === 0) return -1;
  if (v <= arr[0]) return 0;
  if (v >= arr[n - 1]) return n - 1;
  const up = upperBound(arr, v);
  // arr[up - 1] < v <= arr[up] (or up === 0 handled above).
  if (up === 0) return 0;
  const lo = up - 1;
  const hi = up;
  if (Math.abs(arr[lo] - v) <= Math.abs(arr[hi] - v)) return lo;
  return hi;
}

/**
 * Savitzky-Golay smooth of y. `window` is forced odd, clamped to y.length, and
 * clamped to a minimum of 5 (the library's floor). Uses the already-installed
 * `ml-savitzky-golay` dependency; when the series is too short for the window
 * (or the window is less than 5 after clamping) it returns a copy of the input.
 * `polynomial` defaults to 2.
 */
export function smoothSG(
  y: Float64Array,
  window: number,
  polynomial = 2,
): Float64Array {
  const n = y.length;
  if (n === 0) return new Float64Array(0);
  // Force odd, clamp to length and to the library's minimum of 5.
  let w = Math.floor(window);
  if (w < 5) w = 5;
  if (w > n) w = n;
  if (w % 2 === 0) w -= 1;
  if (w < 5) {
    // Series too short to smooth; return a copy.
    return Float64Array.from(y);
  }
  // ml-savitzky-golay with pad:"none" trims `step = floor(w/2)` points from
  // each end of the output. To return a same-length smoothed array aligned
  // with the input, pad the input symmetrically (replicate the endpoints) by
  // `step` on each side before smoothing.
  const step = Math.floor(w / 2);
  const padded = new Array(n + 2 * step);
  for (let i = 0; i < step; i += 1) {
    padded[i] = y[0];
    padded[n + step + i + 1] = y[n - 1];
  }
  for (let i = 0; i < n; i += 1) padded[step + i] = y[i];
  // h is the uniform sample step; our traces are treated as regularly sampled.
  const h = 1;
  try {
    const out = savitzkyGolay(padded, h, {
      windowSize: w,
      derivative: 0,
      polynomial,
      pad: "none",
      padValue: "replicate",
    });
    return Float64Array.from(out);
  } catch {
    return Float64Array.from(y);
  }
}

/**
 * Trapezoidal integral of y over x between indices [i0, i1] inclusive. Clamps
 * i0/i1 into [0, n-1] and swaps if reversed. Returns 0 when fewer than 2 valid
 * points remain.
 */
export function trapezoid(
  x: Float64Array,
  y: Float64Array,
  i0: number,
  i1: number,
): number {
  const n = Math.min(x.length, y.length);
  if (n === 0) return 0;
  let a = Math.max(0, Math.floor(i0));
  let b = Math.min(n - 1, Math.floor(i1));
  if (a > b) {
    const t = a;
    a = b;
    b = t;
  }
  if (b - a < 1) return 0;
  let area = 0;
  for (let i = a; i < b; i += 1) {
    const dx = x[i + 1] - x[i];
    area += (dx * (y[i] + y[i + 1])) / 2;
  }
  return area;
}