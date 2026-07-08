// Peak picking with local signal-to-noise estimation.
//
// The defining choice here (a project guardrail) is that there is *no single
// global intensity threshold*. Noise in MALDI spectra varies enormously across
// the m/z range — chemical/matrix noise dominates the low-mass end and decays
// toward high mass — so a global cutoff either floods the low end with junk or
// misses real high-mass oligomers. Instead we estimate noise locally in blocks
// and accept peaks by *local* S/N. Isotope and (optionally) shoulder peaks are
// flagged, never silently dropped.

import type { Peak, SpectrumData } from "./types";

export type PeakPreset =
  | "conservative"
  | "balanced"
  | "sensitive"
  | "lowResLinear"
  | "highResReflectron"
  | "isotopeResolved";

export interface PeakPickParams {
  preset?: PeakPreset;
  /** Minimum local signal-to-noise to accept a peak. */
  minSnr: number;
  /** Points per local-noise estimation block. */
  noiseWindow: number;
  /** Half-width (points) of the neighborhood a point must dominate to be a max. */
  localMaxRadius: number;
  /** Lower FWHM bound in m/z (0 = no lower bound). */
  minWidth: number;
  /** Upper FWHM bound in m/z (0 = no upper bound). */
  maxWidth: number;
  /** Minimum intensity as a fraction of the base peak (0..1). */
  minRelIntensity: number;
  /** Refine each m/z by intensity-weighted centroid over the peak's FWHM region. */
  centroid: boolean;
  /** Flag likely isotope peaks (spaced ~1.0034/charge above a taller neighbor). */
  isotopeAware: boolean;
  /** Additionally detect shoulder peaks via curvature (flagged "shoulder"). */
  detectShoulders: boolean;
  /** Assumed charge state, for isotope spacing. */
  charge: number;
  /**
   * Minimum topographic prominence as a multiple of local noise — how far a peak
   * must rise above the higher of its two neighbouring valleys. This is the
   * primary reliability gate: it rejects baseline wiggles (≈0 prominence) and
   * stops a peak's noisy flank/top from being picked twice, while keeping real
   * isotopes (each rises well out of the inter-isotope valley). Optional so old
   * saved params still load; defaults to `minSnr` when absent.
   */
  minProminence?: number;
  /**
   * Merge accepted peaks closer than this in m/z, keeping the taller — collapses
   * the duplicate maxima a single noisy peak top produces. 0 = auto (derived from
   * the median peak width, clamped below the isotope spacing). Optional.
   */
  minSeparation?: number;
  /**
   * Detection-only smoothing window in points (0 = none). Peaks are *found* on the
   * smoothed trace, but intensity/width/centroid/S/N are always measured on the
   * original signal. Optional.
   */
  smoothing?: number;
  /**
   * Monoisotopic-only mode. After picking, collapse each isotope envelope to its
   * left-most (monoisotopic) peak — the ¹²C/¹H species without ¹³C or deuterium —
   * and drop the A+1, A+2… satellites. This is the peak you fit repeat units and
   * end groups against. Unlike isotope *flagging* it is intensity-independent, so
   * it stays correct for polymer envelopes where a satellite out-towers the
   * monoisotopic peak. Optional; default on.
   */
  monoisotopicOnly?: boolean;
}

/** Mass spacing between adjacent isotopologues (¹³C − ¹²C), per charge. */
export const ISOTOPE_SPACING = 1.0033548;

export const PEAK_PRESETS: Record<PeakPreset, PeakPickParams> = {
  conservative: {
    preset: "conservative",
    monoisotopicOnly: true,
    minSnr: 6,
    noiseWindow: 200,
    localMaxRadius: 3,
    minWidth: 0,
    maxWidth: 0,
    minRelIntensity: 0.02,
    centroid: true,
    isotopeAware: false,
    detectShoulders: false,
    charge: 1,
    minProminence: 5,
    minSeparation: 0,
    smoothing: 0,
  },
  balanced: {
    preset: "balanced",
    monoisotopicOnly: true,
    minSnr: 3,
    noiseWindow: 150,
    localMaxRadius: 2,
    minWidth: 0,
    maxWidth: 0,
    minRelIntensity: 0.01,
    centroid: true,
    isotopeAware: false,
    detectShoulders: false,
    charge: 1,
    minProminence: 3.5,
    minSeparation: 0,
    smoothing: 0,
  },
  sensitive: {
    preset: "sensitive",
    monoisotopicOnly: true,
    minSnr: 2,
    noiseWindow: 100,
    localMaxRadius: 2,
    minWidth: 0,
    maxWidth: 0,
    minRelIntensity: 0.002,
    centroid: true,
    isotopeAware: false,
    detectShoulders: false,
    charge: 1,
    minProminence: 2.5,
    minSeparation: 0,
    smoothing: 3,
  },
  lowResLinear: {
    preset: "lowResLinear",
    monoisotopicOnly: true,
    minSnr: 4,
    noiseWindow: 250,
    localMaxRadius: 5,
    minWidth: 0,
    maxWidth: 0,
    minRelIntensity: 0.01,
    centroid: true,
    isotopeAware: false,
    detectShoulders: false,
    charge: 1,
    minProminence: 4,
    minSeparation: 0,
    smoothing: 5,
  },
  highResReflectron: {
    preset: "highResReflectron",
    monoisotopicOnly: true,
    minSnr: 3,
    noiseWindow: 120,
    localMaxRadius: 2,
    minWidth: 0,
    maxWidth: 0,
    minRelIntensity: 0.005,
    centroid: true,
    isotopeAware: true,
    detectShoulders: true,
    charge: 1,
    minProminence: 4,
    minSeparation: 0,
    smoothing: 0,
  },
  isotopeResolved: {
    preset: "isotopeResolved",
    minSnr: 2.5,
    noiseWindow: 100,
    localMaxRadius: 1,
    minWidth: 0,
    maxWidth: 0,
    minRelIntensity: 0.003,
    centroid: true,
    isotopeAware: true,
    detectShoulders: true,
    charge: 1,
    minProminence: 3,
    minSeparation: 0,
    smoothing: 0,
  },
};

let peakCounter = 0;
function peakId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  peakCounter += 1;
  return `peak-${Date.now()}-${peakCounter}`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Robust local noise per point. We split into blocks of `noiseWindow` points and,
 * within each, estimate σ from the *successive differences* of the signal rather
 * than the spread of its values:
 *
 *   σ ≈ 1.4826 · MAD(Δy) / √2   where Δy[i] = y[i+1] − y[i]
 *
 * This is the key reliability fix. A value-based MAD balloons wherever peaks are
 * tall and densely packed (the block becomes mostly signal), so real peaks there
 * score a low S/N and get dropped — exactly the "not sensitive enough on the
 * isotopes" failure. The successive-difference estimator is immune to peak
 * amplitude *and* to smooth slopes (a constant-slope flank has near-zero Δy
 * spread), so it tracks only the high-frequency noise floor — small under tall
 * peaks and small on a quiet baseline alike.
 */
export function localNoise(intensity: Float64Array, noiseWindow: number): Float64Array {
  const n = intensity.length;
  const block = Math.max(16, Math.round(noiseWindow));
  const noise = new Float64Array(n);
  for (let start = 0; start < n; start += block) {
    const end = Math.min(n, start + block);
    const diffs: number[] = [];
    for (let i = start + 1; i < end; i += 1) diffs.push(intensity[i] - intensity[i - 1]);
    let level = 0;
    if (diffs.length >= 2) {
      const med = median(diffs);
      const deviations = diffs.map((d) => Math.abs(d - med));
      level = (median(deviations) * 1.4826) / Math.SQRT2;
    }
    // Guard against a flat/constant block (level=0): fall back to a tiny fraction
    // of the block mean so S/N stays finite.
    if (!(level > 0)) {
      let mean = 0;
      for (let i = start; i < end; i += 1) mean += intensity[i];
      mean /= end - start || 1;
      level = Math.max(mean * 1e-3, 1e-9);
    }
    for (let i = start; i < end; i += 1) noise[i] = level;
  }
  return noise;
}

function maxOf(values: Float64Array): number {
  let m = -Infinity;
  for (let i = 0; i < values.length; i += 1) if (values[i] > m) m = values[i];
  return m;
}

/** True if index i dominates its [i-r, i+r] neighborhood (no neighbor taller). */
function dominatesRadius(intensity: Float64Array, i: number, r: number): boolean {
  const n = intensity.length;
  const v = intensity[i];
  for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j += 1) {
    if (j !== i && intensity[j] > v) return false;
  }
  return true;
}

/** O(n) centered moving average (via a prefix sum). `window` ≤ 1 returns input. */
function movingAverage(y: Float64Array, window: number): Float64Array {
  const w = Math.max(1, Math.round(window));
  if (w <= 1) return y;
  const n = y.length;
  const half = w >> 1;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) prefix[i + 1] = prefix[i] + y[i];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    out[i] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
  }
  return out;
}

/**
 * Plateau-aware local maxima: indices where the trace strictly ascends into a
 * (possibly flat) top and then strictly descends. A flat top yields ONE index at
 * the plateau centre, so a noisy peak crest never produces several adjacent
 * "maxima". Each is additionally required to dominate its ±r neighbourhood.
 */
function findMaxima(y: Float64Array, r: number): number[] {
  const n = y.length;
  const out: number[] = [];
  let i = 1;
  while (i < n - 1) {
    if (y[i] > y[i - 1]) {
      // Ascending into i; walk across any flat top of equal values.
      let ahead = i + 1;
      while (ahead < n && y[ahead] === y[i]) ahead += 1;
      if (ahead < n && y[ahead] < y[i]) {
        const center = (i + ahead - 1) >> 1; // plateau is [i, ahead-1]
        if (dominatesRadius(y, center, r)) out.push(center);
      }
      i = ahead;
    } else {
      i += 1;
    }
  }
  return out;
}

/**
 * Topographic prominence of a peak: its height above the higher of the two
 * neighbouring valley floors. We descend each side to the lowest point reached
 * before encountering a taller sample (a higher peak) or the search cap, then
 * return height − max(leftFloor, rightFloor). Capped to keep this O(n·cap) rather
 * than O(n²) on long monotonic runs; the cap only needs to span the local valleys
 * (isotopes sit ~1 Da apart) for prominence to separate real peaks from wiggles.
 */
function prominence(y: Float64Array, peak: number, cap: number): number {
  const n = y.length;
  const h = y[peak];
  let leftFloor = h;
  for (let i = peak - 1, s = 0; i >= 0 && s < cap; i -= 1, s += 1) {
    if (y[i] > h) break;
    if (y[i] < leftFloor) leftFloor = y[i];
  }
  let rightFloor = h;
  for (let i = peak + 1, s = 0; i < n && s < cap; i += 1, s += 1) {
    if (y[i] > h) break;
    if (y[i] < rightFloor) rightFloor = y[i];
  }
  return h - Math.max(leftFloor, rightFloor);
}

/**
 * Local basin of a maximum: the indices of the adjacent valleys (local minima) on
 * each side, found on the (smoothed) detection trace and bounded by `cap` points
 * so a long monotonic flank can't run away. Confining width/centroid to this basin
 * is the fix for overlapping isotopes: when inter-isotope valleys sit *above* a
 * peak's half-max (a barely-resolved envelope), a half-max search would walk
 * straight across them into the neighbour, smearing every isotope's centroid onto
 * the envelope's centre of mass. The basin stops at the valley, so each isotope
 * keeps its own m/z.
 */
function basinBounds(detect: Float64Array, i: number, cap: number): { lo: number; hi: number } {
  const n = detect.length;
  let lo = i;
  for (let s = 0; lo > 0 && s < cap; s += 1) {
    if (detect[lo - 1] > detect[lo]) break; // going further left would climb → valley
    lo -= 1;
  }
  let hi = i;
  for (let s = 0; hi < n - 1 && s < cap; s += 1) {
    if (detect[hi + 1] > detect[hi]) break;
    hi += 1;
  }
  return { lo, hi };
}

/**
 * FWHM in m/z plus the basin index bounds. The half-max crossing is searched only
 * *within* the basin [lo,hi]; if a valley sits above half-max the width is clamped
 * at the valley rather than leaking into the adjacent isotope. Returns the basin
 * bounds (not the half-max bounds) so the centroid integrates over one isotope.
 */
function measureWidth(
  spectrum: SpectrumData,
  i: number,
  lo: number,
  hi: number,
): { width: number; left: number; right: number } {
  const { mz, intensity } = spectrum;
  const half = intensity[i] / 2;
  let left = i;
  while (left > lo && intensity[left] > half) left -= 1;
  let right = i;
  while (right < hi && intensity[right] > half) right += 1;

  // Interpolate the half-max crossing for a sub-sample width estimate.
  const interp = (a: number, b: number): number => {
    const ya = intensity[a];
    const yb = intensity[b];
    if (yb === ya) return mz[a];
    const t = (half - ya) / (yb - ya);
    return mz[a] + t * (mz[b] - mz[a]);
  };
  const leftMz = left < i ? interp(left, left + 1) : mz[i];
  const rightMz = right > i ? interp(right, right - 1) : mz[i];
  return { width: Math.abs(rightMz - leftMz), left: lo, right: hi };
}

/**
 * Intensity-weighted centroid m/z over the peak's basin [lo, right]. Intensities
 * are taken relative to the higher of the two valley floors (the pedestal the
 * isotope sits on), so only the part of the peak *above* its neighbours' valleys
 * contributes — this keeps the centroid on the apex instead of sliding down a
 * shared flank toward a taller neighbour.
 */
function centroidMz(spectrum: SpectrumData, left: number, right: number): number {
  const { mz, intensity } = spectrum;
  const floor = Math.max(intensity[left], intensity[right]);
  let num = 0;
  let den = 0;
  for (let i = left; i <= right; i += 1) {
    const w = intensity[i] - floor;
    if (w <= 0) continue;
    num += mz[i] * w;
    den += w;
  }
  if (den > 0) return num / den;
  // Degenerate basin (flat or single point): fall back to the apex sample.
  let apex = left;
  for (let i = left + 1; i <= right; i += 1) if (intensity[i] > intensity[apex]) apex = i;
  return mz[apex];
}

/** Map S/N to a 0..1 confidence with a soft knee around the threshold. */
function snrConfidence(snr: number, minSnr: number): number {
  const x = (snr - minSnr) / Math.max(1, minSnr);
  return 1 / (1 + Math.exp(-x));
}

/**
 * Pick peaks from a (typically processed) spectrum using local S/N. Returns peaks
 * sorted by m/z, each accepted by default and carrying snr / width / centroid /
 * confidence. Isotope and shoulder peaks are flagged when those modes are on.
 */
export function pickPeaks(spectrum: SpectrumData, params: PeakPickParams): Peak[] {
  const { mz, intensity } = spectrum;
  const n = intensity.length;
  if (n < 3) return [];

  // Backward-compatible defaults for the prominence/separation/smoothing fields
  // (older saved projects predate them).
  const minProminence = params.minProminence ?? params.minSnr;
  const smoothing = params.smoothing ?? 0;

  const noise = localNoise(intensity, params.noiseWindow);
  const basePeak = maxOf(intensity) || 1;
  const minIntensity = params.minRelIntensity * basePeak;
  const r = Math.max(1, Math.round(params.localMaxRadius));
  // Peaks are FOUND on a (optionally) smoothed trace so noise wiggles don't form
  // spurious maxima; everything is MEASURED on the original signal.
  const detect = movingAverage(intensity, smoothing);
  const promCap = Math.max(params.noiseWindow, 64);

  let peaks: Peak[] = [];
  for (const i of findMaxima(detect, r)) {
    if (intensity[i] < minIntensity) continue;
    const snr = intensity[i] / noise[i];
    if (snr < params.minSnr) continue;
    // Primary reliability gate: prominence above the local valleys, in σ units.
    const promRatio = prominence(detect, i, promCap) / noise[i];
    if (promRatio < minProminence) continue;

    // Confine width/centroid to this peak's basin (valley-to-valley) so adjacent
    // isotopes don't smear together; bounds come from the smoothed detect trace.
    const { lo, hi } = basinBounds(detect, i, promCap);
    const { width, left, right } = measureWidth(spectrum, i, lo, hi);
    if (params.minWidth > 0 && width < params.minWidth) continue;
    if (params.maxWidth > 0 && width > params.maxWidth) continue;

    const centroid = params.centroid ? centroidMz(spectrum, left, right) : undefined;
    peaks.push({
      id: peakId(),
      mz: centroid ?? mz[i],
      intensity: intensity[i],
      snr,
      width,
      centroid,
      confidence: snrConfidence(promRatio, minProminence),
      accepted: true,
    });
  }

  if (params.detectShoulders) {
    appendShoulders(spectrum, noise, peaks, params, minIntensity);
  }
  peaks.sort((a, b) => (a.centroid ?? a.mz) - (b.centroid ?? b.mz));
  peaks = mergeCloserThan(peaks, resolveSeparation(params, peaks));
  if (params.isotopeAware) flagIsotopes(peaks, params.charge);
  // Monoisotopic-only: collapse each isotope envelope to its left-most member.
  // Default on (matches the PEAK_PRESETS default + the panel toggle "?? true"),
  // so a legacy saved project without the field still picks monoisotopically.
  if (params.monoisotopicOnly ?? true) peaks = dropIsotopeSatellites(peaks, params.charge);
  return peaks;
}

/**
 * Resolve the effective minimum peak separation in m/z. An explicit value is used
 * as-is; 0 means "auto": ~0.6× the median measured peak width, but clamped well
 * under the isotope spacing so genuine isotopes are never merged.
 */
function resolveSeparation(params: PeakPickParams, peaks: Peak[]): number {
  const explicit = params.minSeparation ?? 0;
  if (explicit > 0) return explicit;
  const widths = peaks
    .map((p) => p.width)
    .filter((w): w is number => w != null && Number.isFinite(w) && w > 0);
  if (widths.length === 0) return 0;
  const isoSpacing = ISOTOPE_SPACING / Math.max(1, params.charge);
  return Math.min(0.6 * median(widths), 0.8 * isoSpacing);
}

/**
 * Collapse runs of peaks closer than `sep` (m/z) into the tallest of the run —
 * the cleanup for a single noisy peak top that yielded several near-duplicate
 * maxima. Expects `peaks` sorted ascending by display m/z.
 */
function mergeCloserThan(peaks: Peak[], sep: number): Peak[] {
  if (sep <= 0 || peaks.length < 2) return peaks;
  const kept: Peak[] = [];
  for (const p of peaks) {
    const last = kept[kept.length - 1];
    const pm = p.centroid ?? p.mz;
    if (last && pm - (last.centroid ?? last.mz) < sep) {
      if (p.intensity > last.intensity) kept[kept.length - 1] = p;
    } else {
      kept.push(p);
    }
  }
  return kept;
}

/**
 * Curvature-based shoulder detection. Hidden peaks on the flank of a larger peak
 * never form a local maximum, but they do create a local maximum of the *negative
 * second derivative* (a concavity spike). We add those that clear S/N and are not
 * already within a resolved peak's width, flagged "shoulder" for user review.
 */
function appendShoulders(
  spectrum: SpectrumData,
  noise: Float64Array,
  peaks: Peak[],
  params: PeakPickParams,
  minIntensity: number,
): void {
  const { mz, intensity } = spectrum;
  const n = intensity.length;
  const existing = peaks
    .map((p) => p.mz)
    .sort((a, b) => a - b);
  const nearExisting = (m: number, tol: number): boolean =>
    existing.some((e) => Math.abs(e - m) <= tol);

  const curvature = new Float64Array(n);
  for (let i = 1; i < n - 1; i += 1) {
    curvature[i] = -(intensity[i - 1] - 2 * intensity[i] + intensity[i + 1]);
  }
  for (let i = 2; i < n - 2; i += 1) {
    if (intensity[i] < minIntensity) continue;
    // Local maximum of concavity that is NOT already a resolved peak.
    if (curvature[i] <= curvature[i - 1] || curvature[i] < curvature[i + 1]) continue;
    if (curvature[i] <= 0) continue;
    const snr = intensity[i] / noise[i];
    if (snr < params.minSnr) continue;
    const { lo, hi } = basinBounds(intensity, i, Math.max(params.noiseWindow, 64));
    const { width } = measureWidth(spectrum, i, lo, hi);
    const tol = Math.max(width, 0.5);
    if (nearExisting(mz[i], tol)) continue;
    peaks.push({
      id: peakId(),
      mz: mz[i],
      intensity: intensity[i],
      snr,
      width,
      confidence: snrConfidence(snr, params.minSnr) * 0.7,
      accepted: true,
      flag: "shoulder",
    });
    existing.push(mz[i]);
    existing.sort((a, b) => a - b);
  }
}

/**
 * Flag isotope peaks: within an isotope envelope, peaks one ¹³C spacing above a
 * taller neighbor (and decreasing) are likely A+1, A+2…; tag them "isotope" so
 * the user can collapse to monoisotopic without ever losing data.
 */
function flagIsotopes(peaks: Peak[], charge: number): void {
  const spacing = ISOTOPE_SPACING / Math.max(1, charge);
  const tol = 0.1 / Math.max(1, charge);
  for (let i = 0; i < peaks.length; i += 1) {
    if (peaks[i].flag) continue;
    // Look back for a peak ~one spacing lower that is taller (the A-1 isotope).
    for (let j = i - 1; j >= 0; j -= 1) {
      const delta = peaks[i].mz - peaks[j].mz;
      if (delta > spacing + tol) break;
      if (Math.abs(delta - spacing) <= tol && peaks[j].intensity >= peaks[i].intensity) {
        peaks[i].flag = "isotope";
        break;
      }
    }
  }
}

/**
 * Collapse each isotope envelope to its monoisotopic (left-most) peak. Walking
 * ascending in m/z, any peak sitting ~one ¹³C spacing above its immediate
 * predecessor is treated as an isotope satellite (A+1, A+2, …) and dropped; the
 * first peak of each ~1-Da-spaced run is kept.
 *
 * This is intensity-independent, which is the whole point: isotope *flagging*
 * keys off "a taller neighbour one spacing below", but in a polymer envelope the
 * A+1 or A+2 isotopologue routinely out-towers the monoisotopic peak, so an
 * intensity rule would keep the wrong one. Spacing alone is robust. `peaks` must
 * be sorted ascending by display m/z (as it is at the call site).
 */
function dropIsotopeSatellites(peaks: Peak[], charge: number): Peak[] {
  if (peaks.length < 2) return peaks;
  const spacing = ISOTOPE_SPACING / Math.max(1, charge);
  // Generous enough to catch integer (unit-resolution) and centroided spacings
  // alike, but well under the 2-Da gap that separates a real non-isotope peak.
  const tol = 0.3 / Math.max(1, charge);
  const kept: Peak[] = [peaks[0]];
  let prevMz = peaks[0].centroid ?? peaks[0].mz;
  for (let i = 1; i < peaks.length; i += 1) {
    const mz = peaks[i].centroid ?? peaks[i].mz;
    // Within one isotope spacing of the previous peak → satellite, drop it. We
    // still advance prevMz so a run A, A+1, A+2… collapses entirely onto A.
    if (Math.abs(mz - prevMz - spacing) > tol) kept.push(peaks[i]);
    prevMz = mz;
  }
  return kept;
}

/** Construct a manually-added peak (used by the table's "add peak" action). */
export function manualPeak(mz: number, intensity: number): Peak {
  return { id: peakId(), mz, intensity, accepted: true, confidence: 1 };
}
