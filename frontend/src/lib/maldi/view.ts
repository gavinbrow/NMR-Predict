// Lightweight, dependency-free view helpers for the spectrum plot.
//
// These run on the *main thread* (the array is already in memory and the plot
// needs them synchronously while zooming), so they deliberately live apart from
// processing.ts — importing them must not pull the heavy numeric libraries
// (ml-savitzky-golay, ml-regression-polynomial, …) into the main bundle.

import type { SpectrumData } from "./types";

/** Slice the spectrum to an [lo, hi] m/z window (ascending m/z assumed). */
export function sliceRange(spectrum: SpectrumData, lo: number, hi: number): SpectrumData {
  const min = Math.min(lo, hi);
  const max = Math.max(lo, hi);
  const mz: number[] = [];
  const intensity: number[] = [];
  for (let i = 0; i < spectrum.mz.length; i += 1) {
    if (spectrum.mz[i] >= min && spectrum.mz[i] <= max) {
      mz.push(spectrum.mz[i]);
      intensity.push(spectrum.intensity[i]);
    }
  }
  return { mz: Float64Array.from(mz), intensity: Float64Array.from(intensity) };
}

/**
 * Min/max bucketed downsample: split into `targetPoints/2` buckets and emit the
 * min and max of each, preserving the visual envelope (tall peaks are never
 * dropped) at a fraction of the points. Returns the input unchanged when already
 * small enough.
 */
export function downsample(spectrum: SpectrumData, targetPoints = 4000): SpectrumData {
  const n = spectrum.mz.length;
  if (n <= targetPoints) return spectrum;
  const buckets = Math.max(1, Math.floor(targetPoints / 2));
  const bucketSize = n / buckets;
  const mz: number[] = [];
  const intensity: number[] = [];
  for (let b = 0; b < buckets; b += 1) {
    const start = Math.floor(b * bucketSize);
    const end = Math.min(n, Math.floor((b + 1) * bucketSize));
    if (end <= start) continue;
    let minI = Infinity;
    let maxI = -Infinity;
    let minIdx = start;
    let maxIdx = start;
    for (let i = start; i < end; i += 1) {
      const v = spectrum.intensity[i];
      if (v < minI) {
        minI = v;
        minIdx = i;
      }
      if (v > maxI) {
        maxI = v;
        maxIdx = i;
      }
    }
    // Emit in ascending m/z order so the line draws correctly.
    if (minIdx <= maxIdx) {
      mz.push(spectrum.mz[minIdx], spectrum.mz[maxIdx]);
      intensity.push(minI, maxI);
    } else {
      mz.push(spectrum.mz[maxIdx], spectrum.mz[minIdx]);
      intensity.push(maxI, minI);
    }
  }
  return { mz: Float64Array.from(mz), intensity: Float64Array.from(intensity) };
}

/**
 * Linearly resample `spectrum` onto an arbitrary ascending m/z `grid`, returning
 * the interpolated intensities. Grid points outside the spectrum's range yield 0.
 * Used by the multi-spectrum compare view to put spectra with different m/z axes
 * onto one common axis (uPlot needs a single shared x array).
 */
export function resampleOnto(grid: Float64Array, spectrum: SpectrumData): Float64Array {
  const out = new Float64Array(grid.length);
  const { mz, intensity } = spectrum;
  const n = mz.length;
  if (n === 0) return out;
  let j = 0;
  for (let i = 0; i < grid.length; i += 1) {
    const x = grid[i];
    if (x <= mz[0]) {
      out[i] = x === mz[0] ? intensity[0] : 0;
      continue;
    }
    if (x >= mz[n - 1]) {
      out[i] = x === mz[n - 1] ? intensity[n - 1] : 0;
      continue;
    }
    while (j < n - 1 && mz[j + 1] < x) j += 1;
    const x0 = mz[j];
    const x1 = mz[j + 1];
    const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
    out[i] = intensity[j] + t * (intensity[j + 1] - intensity[j]);
  }
  return out;
}

/**
 * Same as {@link resampleOnto} but emits `NaN` for grid points outside the
 * spectrum's m/z range, so uPlot gaps the trace instead of drawing a false flat
 * baseline at zero. Used by the overlay-capable `MaldiSpectrumPlot` so an
 * overlay whose range is narrower than the primary's simply disappears outside
 * its own range, rather than implying the spectrum was zero there.
 */
export function resampleOntoGappy(grid: Float64Array, spectrum: SpectrumData): Float64Array {
  const out = new Float64Array(grid.length);
  const { mz, intensity } = spectrum;
  const n = mz.length;
  if (n === 0) {
    out.fill(NaN);
    return out;
  }
  let j = 0;
  for (let i = 0; i < grid.length; i += 1) {
    const x = grid[i];
    if (x < mz[0] || x > mz[n - 1]) {
      out[i] = NaN;
      continue;
    }
    if (x === mz[0]) {
      out[i] = intensity[0];
      continue;
    }
    if (x === mz[n - 1]) {
      out[i] = intensity[n - 1];
      continue;
    }
    while (j < n - 1 && mz[j + 1] < x) j += 1;
    const x0 = mz[j];
    const x1 = mz[j + 1];
    const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
    out[i] = intensity[j] + t * (intensity[j + 1] - intensity[j]);
  }
  return out;
}

/**
 * Resample onto `grid` keeping each bin's PEAK rather than an interpolated
 * sample: for every grid point, the tallest source intensity whose m/z is nearer
 * to it than to any neighbouring grid point. Grid points outside the spectrum's
 * m/z range emit `NaN` (same gapping contract as {@link resampleOntoGappy}); a
 * grid FINER than the source has bins no sample lands in, and those fall back to
 * linear interpolation, so this is a drop-in replacement at any density.
 *
 * This exists because {@link resampleOntoGappy} is only correct when the grid is
 * at least as fine as the data. The multi-trace plot resamples onto a
 * 12 000-point grid spanning the whole m/z range — ~0.3 Da per point over a
 * typical 200–4000 window — while MALDI peaks are a few hundredths of a Dalton
 * wide. Interpolating there samples the FLANKS of most peaks and misses their
 * apexes, which:
 *   - draws the ladder at a random 50–100 % of each peak's true height,
 *   - under-estimates the trace maximum, so `Normalize` divides by the wrong
 *     number, and
 *   - therefore scales the peak markers (which use the peak's TRUE intensity)
 *     far above the trace, where the plot's clip rectangle discards them —
 *     the "normalize hides my peak labels" bug.
 * Taking the bin maximum keeps every apex, exactly as `downsample`'s min/max
 * bucketing does for the single-trace path.
 *
 * Both `grid` and `spectrum.mz` must be ascending; the walk is O(grid + samples).
 */
export function envelopeOnto(grid: Float64Array, spectrum: SpectrumData): Float64Array {
  const n = grid.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const { mz, intensity } = spectrum;
  const m = mz.length;
  if (m === 0) {
    out.fill(NaN);
    return out;
  }

  // Half a grid step of slack at each end so a sample just outside the first /
  // last grid point still lands in its bin instead of being dropped.
  const step = n > 1 ? (grid[n - 1] - grid[0]) / (n - 1) : 0;
  const lo = grid[0] - step / 2;
  const hi = grid[n - 1] + step / 2;

  const filled = new Uint8Array(n);
  let g = 0;
  for (let j = 0; j < m; j += 1) {
    const x = mz[j];
    if (x < lo) continue;
    if (x > hi) break;
    const v = intensity[j];
    if (!Number.isFinite(v)) continue;
    while (g < n - 1 && grid[g + 1] <= x) g += 1;
    const idx = g < n - 1 && grid[g + 1] - x < x - grid[g] ? g + 1 : g;
    if (!filled[idx] || v > out[idx]) {
      out[idx] = v;
      filled[idx] = 1;
    }
  }

  // Bins no sample landed in (grid finer than the data): interpolate inside the
  // spectrum's range, gap outside it.
  let k = 0;
  for (let i = 0; i < n; i += 1) {
    if (filled[i]) continue;
    const x = grid[i];
    if (x < mz[0] || x > mz[m - 1]) {
      out[i] = NaN;
      continue;
    }
    while (k < m - 1 && mz[k + 1] < x) k += 1;
    if (k >= m - 1) {
      out[i] = intensity[m - 1];
      continue;
    }
    const x0 = mz[k];
    const x1 = mz[k + 1];
    const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
    out[i] = intensity[k] + t * (intensity[k + 1] - intensity[k]);
  }
  return out;
}

/**
 * Scale a trace so its max becomes 100. Returns the input unchanged when the
 * max is ≤ 0 (an all-zero or all-negative trace). Lifted out of `CompareView`
 * (and used by the overlay-capable `MaldiSpectrumPlot`) so both views share one
 * normalisation. Allocates a new array only when normalising.
 */
export function normalizeTrace(arr: Float64Array): Float64Array {
  let max = 0;
  for (const v of arr) if (Number.isFinite(v) && v > max) max = v;
  if (max <= 0) return arr;
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i += 1) out[i] = (arr[i] / max) * 100;
  return out;
}

/**
 * Multiply a trace by a constant. Returns the input unchanged when `factor` is
 * 1 (or not a usable number) so callers don't pay an allocation in the common
 * case. This is the user's per-document intensity multiplier — applied AFTER
 * any normalisation and BEFORE {@link applyOffset}, so "×2" means "draw this
 * document twice as tall wherever it currently sits".
 */
export function applyScale(arr: Float64Array, factor: number): Float64Array {
  if (!Number.isFinite(factor) || factor === 1) return arr;
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i += 1) out[i] = arr[i] * factor;
  return out;
}

/**
 * Add a constant vertical offset to a trace (stacked-style). Returns the input
 * unchanged when `offset` is 0 so callers don't pay an allocation in the common
 * case. Lifted out of `CompareView` so the overlay plot and the compare view
 * share one offset primitive.
 */
export function applyOffset(arr: Float64Array, offset: number): Float64Array {
  if (!offset) return arr;
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i += 1) out[i] = arr[i] + offset;
  return out;
}

/**
 * Build a uniform ascending m/z grid of `samples` points spanning the UNION
 * m/z range of every supplied spectrum, intersected with the optional `[lo, hi]`
 * zoom window. Used by the multi-trace plot so every visible trace resamples
 * against one common axis (uPlot needs a single shared x array) without a
 * narrower active document truncating the wider ones.
 */
export function unionGrid(spectra: SpectrumData[], lo?: number, hi?: number, samples = 12000): Float64Array {
  let min = Infinity;
  let max = -Infinity;
  for (const s of spectra) {
    if (s.mz.length === 0) continue;
    if (s.mz[0] < min) min = s.mz[0];
    if (s.mz[s.mz.length - 1] > max) max = s.mz[s.mz.length - 1];
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) return new Float64Array(0);
  if (lo != null && lo > min) min = lo;
  if (hi != null && hi < max) max = hi;
  if (!(max > min)) return new Float64Array(0);
  const step = (max - min) / (samples - 1);
  const out = new Float64Array(samples);
  for (let i = 0; i < samples; i += 1) out[i] = min + i * step;
  return out;
}

/**
 * The scale factor that took a raw-intensity peak height to the plotted 0-100
 * normalised units: `100 / max` when normalising (and `max > 0`), else `1`.
 * Multiplied by the raw `peak.intensity` and the per-trace `offset` added to
 * land a peak marker in the plot's y-space (FP3).
 */
export function peakMarkerScale(normalize: boolean, windowMax: number): number {
  return normalize && windowMax > 0 ? 100 / windowMax : 1;
}
