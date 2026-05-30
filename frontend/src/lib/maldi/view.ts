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
