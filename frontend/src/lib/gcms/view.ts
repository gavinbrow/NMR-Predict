// Generic XY view helpers for the GC/MS workspace plot layer.
//
// These are the XYSeries-flavoured analogues of lib/maldi/view.ts. The MALDI and
// GC/MS workspaces are deliberately kept decoupled (different data models, no
// cross-imports), so the algorithms are re-implemented here against `XYSeries`
// rather than shared. They run on the main thread while zooming/panning, so they
// stay allocation-light and dependency-free.
//
// Purity / identity contract (load-bearing for the plot layer):
//   - `sliceRange`, `downsample`, `normalizeTrace`, `applyOffset` MAY return the
//     INPUT OBJECT itself when they are a no-op (full range, already small
//     enough, max already 100, zero offset). Callers must not mutate results.
//   - No function mutates an input array.
//   - All returned arrays are Float64Array.
//   - Empty series (length 0) are handled everywhere without throwing.

import type { XYSeries } from "./types";

/** Lower-bound binary search: first index i with arr[i] >= v. Assumes ascending. */
function lowerBound(arr: Float64Array, v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Upper-bound binary search: first index i with arr[i] > v. Assumes ascending. */
function upperBound(arr: Float64Array, v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Inclusive slice of the series to x in [lo, hi]. `s.x` MUST be ascending. Uses
 * binary search. Returns the input object unchanged when the range covers the
 * whole series (so callers pay no allocation in the common full-view case).
 */
export function sliceRange(s: XYSeries, lo: number, hi: number): XYSeries {
  const n = s.x.length;
  if (n === 0) return s;
  const min = Math.min(lo, hi);
  const max = Math.max(lo, hi);
  const start = lowerBound(s.x, min);
  const end = upperBound(s.x, max);
  if (start === 0 && end === n) return s;
  if (end <= start) {
    return { x: new Float64Array(0), y: new Float64Array(0) };
  }
  return {
    x: s.x.subarray(start, end),
    y: s.y.subarray(start, end),
  };
}

/**
 * Min/max envelope downsample to at most `maxPoints` output points. NOT stride
 * sampling: the series is split into `floor(maxPoints / 2)` buckets and, for
 * each bucket, the bucket's min and max y are emitted (in x order) so narrow
 * peaks survive. Returns the input object unchanged when `s.x.length <= maxPoints`.
 */
export function downsample(s: XYSeries, maxPoints: number): XYSeries {
  const n = s.x.length;
  if (n <= maxPoints) return s;
  const buckets = Math.max(1, Math.floor(maxPoints / 2));
  const bucketSize = n / buckets;
  const x: number[] = [];
  const y: number[] = [];
  for (let b = 0; b < buckets; b += 1) {
    const start = Math.floor(b * bucketSize);
    const end = Math.min(n, Math.floor((b + 1) * bucketSize));
    if (end <= start) continue;
    let minI = Infinity;
    let maxI = -Infinity;
    let minIdx = start;
    let maxIdx = start;
    for (let i = start; i < end; i += 1) {
      const v = s.y[i];
      if (v < minI) {
        minI = v;
        minIdx = i;
      }
      if (v > maxI) {
        maxI = v;
        maxIdx = i;
      }
    }
    // Emit in ascending x order so the line draws correctly.
    if (minIdx <= maxIdx) {
      x.push(s.x[minIdx], s.x[maxIdx]);
      y.push(minI, maxI);
    } else {
      x.push(s.x[maxIdx], s.x[minIdx]);
      y.push(maxI, minI);
    }
  }
  return { x: Float64Array.from(x), y: Float64Array.from(y) };
}

/**
 * Resample `s` onto `grid`, writing NaN wherever `grid[i]` falls outside `s.x`'s
 * range OR into a gap in `s.x` wider than `maxGap` (so uPlot breaks the line
 * instead of bridging it). Linear interpolation elsewhere. `s.x` must be
 * ascending. Returns a Float64Array of length `grid.length`.
 */
export function resampleOntoGappy(s: XYSeries, grid: Float64Array, maxGap: number): Float64Array {
  const out = new Float64Array(grid.length);
  const { x, y } = s;
  const n = x.length;
  if (n === 0) {
    out.fill(NaN);
    return out;
  }
  let j = 0;
  for (let i = 0; i < grid.length; i += 1) {
    const g = grid[i];
    if (g < x[0] || g > x[n - 1]) {
      out[i] = NaN;
      continue;
    }
    if (g === x[0]) {
      out[i] = y[0];
      continue;
    }
    if (g === x[n - 1]) {
      out[i] = y[n - 1];
      continue;
    }
    // Advance j so x[j] <= g <= x[j+1].
    while (j < n - 2 && x[j + 1] < g) j += 1;
    const x0 = x[j];
    const x1 = x[j + 1];
    if (x1 - x0 > maxGap) {
      out[i] = NaN;
      continue;
    }
    const t = x1 === x0 ? 0 : (g - x0) / (x1 - x0);
    out[i] = y[j] + t * (y[j + 1] - y[j]);
  }
  return out;
}

/**
 * Scale y so max(y) === 100. Returns the input object unchanged when the max is
 * already ~100, the series is empty, or it is all-zero/non-positive (so an
 * all-zero series does not produce NaN/Inf). NaN values are skipped when finding
 * the max and passed through unchanged.
 */
export function normalizeTrace(s: XYSeries): XYSeries {
  const n = s.y.length;
  if (n === 0) return s;
  let max = 0;
  for (let i = 0; i < n; i += 1) {
    const v = s.y[i];
    if (Number.isFinite(v) && v > max) max = v;
  }
  if (max <= 0) return s;
  if (max === 100) return s;
  const yOut = new Float64Array(n);
  const scale = 100 / max;
  for (let i = 0; i < n; i += 1) {
    const v = s.y[i];
    yOut[i] = Number.isFinite(v) ? v * scale : v;
  }
  return { x: s.x, y: yOut };
}

/**
 * Add a constant to every y. Returns the input object unchanged when
 * `offset === 0` so callers pay no allocation in the common case.
 */
export function applyOffset(s: XYSeries, offset: number): XYSeries {
  if (!offset) return s;
  const yOut = new Float64Array(s.y.length);
  for (let i = 0; i < s.y.length; i += 1) yOut[i] = s.y[i] + offset;
  return { x: s.x, y: yOut };
}

/**
 * Sorted, de-duplicated union of every series' x values. Values within
 * `tolerance` (default 1e-6) of an already-emitted grid value are merged into
 * it (the first occurrence wins). Returns an empty Float64Array when no series
 * has samples.
 */
export function unionGrid(series: XYSeries[], tolerance = 1e-6): Float64Array {
  let total = 0;
  for (const s of series) total += s.x.length;
  if (total === 0) return new Float64Array(0);
  const all = new Float64Array(total);
  let w = 0;
  for (const s of series) {
    all.set(s.x, w);
    w += s.x.length;
  }
  // Float64Array.prototype.sort is ascending numeric.
  all.sort();
  const out: number[] = [];
  let last = 0;
  let haveLast = false;
  for (let i = 0; i < all.length; i += 1) {
    const v = all[i];
    if (haveLast && Math.abs(v - last) <= tolerance) continue;
    out.push(v);
    last = v;
    haveLast = true;
  }
  return Float64Array.from(out);
}

/**
 * Sorted, de-duplicated union of every spectrum's m/z, plus one gapped column
 * per spectrum (NaN where that spectrum has no point at that m/z). EXACT — no
 * interpolation, so centroid sticks are never smeared. Default tolerance 1e-6.
 *
 * Algorithm: gather all m/z from all spectra, sort ascending, merge any two
 * adjacent values within `tolerance` into a single grid value (first wins).
 * Then for each spectrum, allocate a Float64Array of `grid.length` filled with
 * NaN and, for each of that spectrum's points, binary-search the grid for the
 * matching bucket (within `tolerance`) and write its intensity there. If two of
 * one spectrum's points land in the same bucket, their intensities are summed.
 */
export function unionMzColumns(
  spectra: XYSeries[],
  tolerance = 1e-6,
): { grid: Float64Array; columns: Float64Array[] } {
  const grid = unionGrid(spectra, tolerance);
  const columns: Float64Array[] = [];
  for (const s of spectra) {
    const col = new Float64Array(grid.length);
    col.fill(NaN);
    const { x, y } = s;
    const n = x.length;
    for (let i = 0; i < n; i += 1) {
      const mz = x[i];
      if (grid.length === 0) break;
      // Find the grid bucket whose value is within tolerance of mz. Prefer the
      // closest of the two bracketing grid entries.
      const lo = lowerBound(grid, mz);
      if (lo < grid.length && Math.abs(grid[lo] - mz) <= tolerance) {
        if (Number.isNaN(col[lo])) col[lo] = y[i];
        else col[lo] += y[i];
        continue;
      }
      if (lo > 0 && Math.abs(grid[lo - 1] - mz) <= tolerance) {
        if (Number.isNaN(col[lo - 1])) col[lo - 1] = y[i];
        else col[lo - 1] += y[i];
      }
    }
    columns.push(col);
  }
  return { grid, columns };
}