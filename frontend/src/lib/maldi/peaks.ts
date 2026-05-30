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
}

/** Mass spacing between adjacent isotopologues (¹³C − ¹²C), per charge. */
export const ISOTOPE_SPACING = 1.0033548;

export const PEAK_PRESETS: Record<PeakPreset, PeakPickParams> = {
  conservative: {
    preset: "conservative",
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
  },
  balanced: {
    preset: "balanced",
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
  },
  sensitive: {
    preset: "sensitive",
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
  },
  lowResLinear: {
    preset: "lowResLinear",
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
  },
  highResReflectron: {
    preset: "highResReflectron",
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
 * Robust local noise per point: split into blocks of `noiseWindow` points, take
 * the MAD (median absolute deviation × 1.4826 ≈ σ) of each block, and assign it
 * to every point in the block. MAD ignores the peaks themselves, so it estimates
 * the baseline noise rather than being inflated by signal.
 */
export function localNoise(intensity: Float64Array, noiseWindow: number): Float64Array {
  const n = intensity.length;
  const block = Math.max(16, Math.round(noiseWindow));
  const noise = new Float64Array(n);
  for (let start = 0; start < n; start += block) {
    const end = Math.min(n, start + block);
    const window: number[] = [];
    for (let i = start; i < end; i += 1) window.push(intensity[i]);
    const med = median(window);
    const deviations = window.map((v) => Math.abs(v - med));
    const mad = median(deviations) * 1.4826;
    // Guard against a flat block (mad=0): fall back to a tiny fraction of the
    // block mean so S/N stays finite.
    let mean = 0;
    for (const v of window) mean += v;
    mean /= window.length || 1;
    const level = mad > 0 ? mad : Math.max(mean * 1e-3, 1e-9);
    for (let i = start; i < end; i += 1) noise[i] = level;
  }
  return noise;
}

function maxOf(values: Float64Array): number {
  let m = -Infinity;
  for (let i = 0; i < values.length; i += 1) if (values[i] > m) m = values[i];
  return m;
}

/** True if index i dominates its [i-r, i+r] neighborhood (and beats one side). */
function isLocalMax(intensity: Float64Array, i: number, r: number): boolean {
  const n = intensity.length;
  const v = intensity[i];
  let strictlyGreaterSomewhere = false;
  for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j += 1) {
    if (j === i) continue;
    if (intensity[j] > v) return false;
    if (v > intensity[j]) strictlyGreaterSomewhere = true;
  }
  return strictlyGreaterSomewhere;
}

/** FWHM in m/z plus the half-max index bounds, via linear interpolation. */
function measureWidth(
  spectrum: SpectrumData,
  i: number,
): { width: number; left: number; right: number } {
  const { mz, intensity } = spectrum;
  const n = intensity.length;
  const half = intensity[i] / 2;
  let left = i;
  while (left > 0 && intensity[left] > half) left -= 1;
  let right = i;
  while (right < n - 1 && intensity[right] > half) right += 1;

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
  return { width: Math.abs(rightMz - leftMz), left, right };
}

/** Intensity-weighted centroid m/z over the peak's [left, right] region. */
function centroidMz(spectrum: SpectrumData, left: number, right: number): number {
  const { mz, intensity } = spectrum;
  let num = 0;
  let den = 0;
  for (let i = left; i <= right; i += 1) {
    num += mz[i] * intensity[i];
    den += intensity[i];
  }
  return den > 0 ? num / den : mz[(left + right) >> 1];
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

  const noise = localNoise(intensity, params.noiseWindow);
  const basePeak = maxOf(intensity) || 1;
  const minIntensity = params.minRelIntensity * basePeak;
  const r = Math.max(1, Math.round(params.localMaxRadius));

  const peaks: Peak[] = [];
  for (let i = 1; i < n - 1; i += 1) {
    if (intensity[i] < minIntensity) continue;
    if (!isLocalMax(intensity, i, r)) continue;
    const snr = intensity[i] / noise[i];
    if (snr < params.minSnr) continue;

    const { width, left, right } = measureWidth(spectrum, i);
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
      confidence: snrConfidence(snr, params.minSnr),
      accepted: true,
    });
  }

  if (params.detectShoulders) {
    appendShoulders(spectrum, noise, peaks, params, minIntensity);
  }
  peaks.sort((a, b) => a.mz - b.mz);
  if (params.isotopeAware) flagIsotopes(peaks, params.charge);
  return peaks;
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
    const { width } = measureWidth(spectrum, i);
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

/** Construct a manually-added peak (used by the table's "add peak" action). */
export function manualPeak(mz: number, intensity: number): Peak {
  return { id: peakId(), mz, intensity, accepted: true, confidence: 1 };
}
