// Synthetic PEG MALDI spectrum fixture, shared across the compute tests.
//
// Models a poly(ethylene glycol) sample: H-(O-CH2-CH2)n-OH ionized as [M+Na]+,
// giving peaks at m/z = endGroup(H2O) + n·repeat(C2H4O) + Na. We add ¹³C isotope
// satellites, an exponential matrix baseline, and — importantly — a noise
// *gradient* (heavy chemical noise at low mass decaying toward high mass) so the
// local-S/N picker can be tested against a naive global threshold.

import { PEAK_PRESETS, pickPeaks } from "../peaks";
import { applyProcessing } from "../processing";
import type { Peak, ProcessingStep, SpectrumData } from "../types";

export const PEG_REPEAT = 44.026215; // C2H4O, monoisotopic
export const PEG_END_GROUP = 18.010565; // H2O (H / OH termini)
export const NA_SHIFT = 22.989218; // Na+ (Na − electron)
export const ISOTOPE_STEP = 1.0033548;

export interface PegFixtureOptions {
  nLo?: number;
  nHi?: number;
  step?: number;
  sigma?: number;
  baseNoise?: number;
  noiseGradient?: number;
  baselineAmp?: number;
  seed?: number;
}

export interface PegFixture {
  spectrum: SpectrumData;
  truePeakMz: number[];
  repeat: number;
  endGroup: number;
  adductShift: number;
  nLo: number;
  nHi: number;
}

/** Deterministic PRNG (mulberry32) so fixtures are reproducible across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard-normal sample from two uniforms (Box–Muller). */
function gaussianSample(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function makePegSpectrum(options: PegFixtureOptions = {}): PegFixture {
  const nLo = options.nLo ?? 6;
  const nHi = options.nHi ?? 30;
  const step = options.step ?? 0.05;
  const sigma = options.sigma ?? 0.18;
  const baseNoise = options.baseNoise ?? 1.5;
  const noiseGradient = options.noiseGradient ?? 14;
  const baselineAmp = options.baselineAmp ?? 40;
  const rng = mulberry32(options.seed ?? 12345);

  const truePeakMz: number[] = [];
  for (let n = nLo; n <= nHi; n += 1) {
    truePeakMz.push(PEG_END_GROUP + n * PEG_REPEAT + NA_SHIFT);
  }

  const mzMin = truePeakMz[0] - 8;
  const mzMax = truePeakMz[truePeakMz.length - 1] + 8;
  const count = Math.round((mzMax - mzMin) / step) + 1;

  const mz = new Float64Array(count);
  const intensity = new Float64Array(count);
  for (let i = 0; i < count; i += 1) mz[i] = mzMin + i * step;

  const nCenter = (nLo + nHi) / 2;
  const nSpread = (nHi - nLo) / 3;
  const addGaussian = (center: number, amp: number) => {
    const lo = Math.max(0, Math.floor((center - 6 * sigma - mzMin) / step));
    const hi = Math.min(count - 1, Math.ceil((center + 6 * sigma - mzMin) / step));
    for (let i = lo; i <= hi; i += 1) {
      const d = mz[i] - center;
      intensity[i] += amp * Math.exp(-(d * d) / (2 * sigma * sigma));
    }
  };

  for (let k = 0; k < truePeakMz.length; k += 1) {
    const n = nLo + k;
    // Oligomer-distribution envelope (Gaussian in n).
    const envelope = Math.exp(-((n - nCenter) ** 2) / (2 * nSpread * nSpread));
    const amp = 1000 * envelope + 30;
    addGaussian(truePeakMz[k], amp);
    // ¹³C isotope satellites: PEG n-mer has 2n carbons → A+1 ≈ 2n·1.07%.
    const carbons = 2 * n;
    const a1 = amp * carbons * 0.0107;
    addGaussian(truePeakMz[k] + ISOTOPE_STEP, a1);
    const a2 = a1 * (carbons * 0.0107) * 0.5;
    if (a2 > 1) addGaussian(truePeakMz[k] + 2 * ISOTOPE_STEP, a2);
  }

  // Exponential baseline (matrix), plus gradient noise: noisier at low mass.
  for (let i = 0; i < count; i += 1) {
    const frac = (mzMax - mz[i]) / (mzMax - mzMin); // 1 at low mass, 0 at high
    const baseline = baselineAmp * Math.exp(-(mz[i] - mzMin) / 400);
    const localNoiseSd = baseNoise + noiseGradient * frac;
    const noise = Math.abs(gaussianSample(rng)) * localNoiseSd;
    intensity[i] += baseline + noise;
  }

  return {
    spectrum: { mz, intensity },
    truePeakMz,
    repeat: PEG_REPEAT,
    endGroup: PEG_END_GROUP,
    adductShift: NA_SHIFT,
    nLo,
    nHi,
  };
}

/**
 * Run the realistic interpretation pipeline on a fresh fixture: baseline-correct,
 * smooth, then pick peaks with isotope flagging. This mirrors how the workspace
 * feeds peaks into repeat-unit / series / end-group detection, so those tests
 * operate on clean monoisotopic peaks rather than the raw noisy spectrum.
 */
export function pickPegPeaks(options: PegFixtureOptions = {}): {
  fixture: PegFixture;
  peaks: Peak[];
} {
  const fixture = makePegSpectrum(options);
  const steps: ProcessingStep[] = [
    { id: "b", kind: "baseline", enabled: true, params: { method: "snip", iterations: 30 } },
    { id: "s", kind: "smooth", enabled: true, params: { method: "savitzkyGolay", windowSize: 9, polynomial: 3 } },
  ];
  const processed = applyProcessing(fixture.spectrum, steps);
  const peaks = pickPeaks(processed, { ...PEAK_PRESETS.conservative, isotopeAware: true });
  return { fixture, peaks };
}
