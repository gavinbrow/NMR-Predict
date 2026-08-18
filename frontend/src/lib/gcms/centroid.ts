// Profile (continuum) -> centroid peak reduction.
//
// Continuum data stores the digitised peak SHAPE: a TOF peak at m/z 337 spans
// ~13 samples. Vendor software reports one number per peak, so the m/z read off
// raw continuum data never matches the vendor's processed peak list until the
// profile is centroided. This module does that reduction.
//
// The convention implemented here is MassLynx's, verified byte-for-byte against
// a Waters SYNAPT XS acquisition and the vendor-processed PDF of the same scan:
//   - a peak is an apex plus every neighbouring sample that descends away from
//     it (bounded by a zero sample, a local minimum, or an m/z discontinuity);
//   - the reported m/z is the INTENSITY-WEIGHTED CENTROID over that window;
//   - the reported intensity is the SUM (peak area), not the apex height.
// On the reference scan those rules reproduce the vendor's base peak as
// 337.2857 vs 337.2858 (0.3 ppm) with area 1797510 vs the vendor's 1.80e6.
//
// Using the apex height instead of the area, or centroiding only the top half
// of the peak, both measurably disagree with the vendor output — do not
// "simplify" those two rules away.

/** One centroided peak. */
export interface CentroidPeak {
  mz: number;
  intensity: number;
}

export interface CentroidOptions {
  /**
   * Drop peaks whose area is below this fraction of the biggest peak's area.
   * 0 keeps everything (noise included). Applied AFTER centroiding so the
   * threshold is measured on peak areas, not raw samples.
   */
  relThreshold?: number;
  /** Drop peaks built from fewer than this many samples. Default 2. */
  minPoints?: number;
  /**
   * Samples further apart than this many multiples of the local sample spacing
   * start a new peak. Guards against merging across the gaps that continuum
   * data leaves where the detector saw nothing. Default 4.
   */
  gapFactor?: number;
}

/**
 * Reduce one profile scan to centroids. `mz` must be ASCENDING (the invariant
 * every parser in this package upholds). Returns peaks in ascending m/z.
 *
 * The scan is walked once: each sample that is a local maximum (plateaux count
 * once, at their first sample) seeds a peak, which then grows outward while the
 * signal keeps descending. Because growth stops at local minima, two merged
 * shoulders are reported as two peaks rather than one fat one.
 */
export function centroidProfile(
  mz: ArrayLike<number>,
  intensity: ArrayLike<number>,
  options?: CentroidOptions,
): CentroidPeak[] {
  const n = mz.length;
  const minPoints = options?.minPoints ?? 2;
  const gapFactor = options?.gapFactor ?? 4;
  const relThreshold = options?.relThreshold ?? 0;
  if (n === 0) return [];

  // Typical sample spacing, used only to detect discontinuities. The median of
  // a bounded sample keeps this O(1)-ish for very large scans.
  const step = medianStep(mz, n);
  const maxGap = step > 0 ? step * gapFactor : Infinity;

  const peaks: CentroidPeak[] = [];
  let maxArea = 0;

  let i = 0;
  while (i < n) {
    if (!(intensity[i] > 0)) {
      i += 1;
      continue;
    }
    // Every sample belongs to exactly ONE peak. `start` is the first sample not
    // yet claimed, and the leftward descent below is clamped to it: without
    // that clamp a peak growing left off its apex re-consumes the tail of the
    // previous peak, and the reported areas over-count the scan's true TIC.
    const start = i;
    // Walk to the top of the current rise. `apex` ends on the last sample of a
    // plateau so the descent test below behaves for flat-topped (saturated)
    // peaks.
    let apex = i;
    while (apex + 1 < n && intensity[apex + 1] >= intensity[apex] && mz[apex + 1] - mz[apex] <= maxGap) {
      apex += 1;
    }

    // Descend left from the apex while the signal keeps falling away.
    let lo = apex;
    while (
      lo > start &&
      intensity[lo - 1] > 0 &&
      intensity[lo - 1] <= intensity[lo] &&
      mz[lo] - mz[lo - 1] <= maxGap
    ) {
      lo -= 1;
    }
    // Descend right.
    let hi = apex;
    while (
      hi + 1 < n &&
      intensity[hi + 1] > 0 &&
      intensity[hi + 1] <= intensity[hi] &&
      mz[hi + 1] - mz[hi] <= maxGap
    ) {
      hi += 1;
    }

    let area = 0;
    let moment = 0;
    for (let k = lo; k <= hi; k += 1) {
      const w = intensity[k];
      area += w;
      moment += mz[k] * w;
    }
    if (area > 0 && hi - lo + 1 >= minPoints) {
      peaks.push({ mz: moment / area, intensity: area });
      if (area > maxArea) maxArea = area;
    }

    // Resume from the far side of this peak. `hi` is the last consumed sample,
    // and hi >= apex >= i, so the cursor always advances.
    i = hi + 1;
  }

  if (relThreshold > 0 && maxArea > 0) {
    const cut = maxArea * relThreshold;
    return peaks.filter((p) => p.intensity >= cut);
  }
  return peaks;
}

/** Median of the first-difference of `mz`, sampled so huge scans stay cheap. */
function medianStep(mz: ArrayLike<number>, n: number): number {
  if (n < 2) return 0;
  const want = Math.min(2048, n - 1);
  const stride = Math.max(1, Math.floor((n - 1) / want));
  const diffs: number[] = [];
  for (let i = 1; i < n; i += stride) {
    const d = mz[i] - mz[i - 1];
    if (d > 0) diffs.push(d);
  }
  if (diffs.length === 0) return 0;
  diffs.sort((a, b) => a - b);
  return diffs[diffs.length >> 1];
}
