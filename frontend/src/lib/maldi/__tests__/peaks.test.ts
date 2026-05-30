import { describe, expect, it } from "vitest";
import { PEAK_PRESETS, pickPeaks, type PeakPickParams } from "../peaks";
import type { SpectrumData } from "../types";
import { makePegSpectrum } from "./fixtures";

function nearest(peaksMz: number[], target: number): number {
  return peaksMz.reduce((best, m) => (Math.abs(m - target) < Math.abs(best - target) ? m : best), Infinity);
}

describe("pickPeaks", () => {
  it("recovers the known synthetic PEG oligomer peaks", () => {
    const fixture = makePegSpectrum();
    const peaks = pickPeaks(fixture.spectrum, { ...PEAK_PRESETS.balanced, isotopeAware: true });
    const picked = peaks.filter((p) => p.flag !== "isotope").map((p) => p.centroid ?? p.mz);

    let matched = 0;
    for (const trueMz of fixture.truePeakMz) {
      if (Math.abs(nearest(picked, trueMz) - trueMz) <= 0.2) matched += 1;
    }
    // Recover the large majority of the 25 oligomer peaks.
    expect(matched).toBeGreaterThanOrEqual(fixture.truePeakMz.length - 3);
  });

  it("flags isotope satellites instead of treating them as new species", () => {
    const fixture = makePegSpectrum();
    const peaks = pickPeaks(fixture.spectrum, { ...PEAK_PRESETS.balanced, isotopeAware: true });
    expect(peaks.some((p) => p.flag === "isotope")).toBe(true);
  });

  it("beats a global threshold on a noise-gradient spectrum", () => {
    // Two regions: loud noise + a tall peak at low mass; quiet noise + a SMALL
    // peak at high mass. A global threshold tuned to suppress the low-mass noise
    // would also erase the high-mass peak; local S/N must recover both.
    const n = 4000;
    const mz = new Float64Array(n);
    const intensity = new Float64Array(n);
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const lowPeakIdx = 700; // mz ≈ 170
    const highPeakIdx = 3300; // mz ≈ 430
    for (let i = 0; i < n; i += 1) {
      mz[i] = 100 + i * 0.1;
      const loud = i < n / 2;
      const noiseSd = loud ? 40 : 1.5;
      intensity[i] = Math.abs(rand() - 0.5) * 2 * noiseSd;
    }
    const addPeak = (idx: number, amp: number) => {
      for (let k = -30; k <= 30; k += 1) {
        const j = idx + k;
        if (j < 0 || j >= n) continue;
        intensity[j] += amp * Math.exp(-(k * k) / (2 * 6 * 6));
      }
    };
    addPeak(lowPeakIdx, 250);
    addPeak(highPeakIdx, 28);
    const spectrum: SpectrumData = { mz, intensity };

    const params: PeakPickParams = {
      ...PEAK_PRESETS.balanced,
      minSnr: 5,
      noiseWindow: 200,
      minRelIntensity: 0,
      centroid: false,
    };
    const peaks = pickPeaks(spectrum, params);
    const pickedMz = peaks.map((p) => p.mz);

    const foundLow = Math.abs(nearest(pickedMz, mz[lowPeakIdx]) - mz[lowPeakIdx]) <= 0.5;
    const foundHigh = Math.abs(nearest(pickedMz, mz[highPeakIdx]) - mz[highPeakIdx]) <= 0.5;
    expect(foundLow).toBe(true);
    expect(foundHigh).toBe(true);

    // Demonstrate why a global threshold fails: low-mass noise rises ABOVE the
    // high-mass peak, so no single cutoff separates signal from noise globally.
    let maxLowNoise = 0;
    for (let i = 0; i < n / 2; i += 1) {
      if (Math.abs(i - lowPeakIdx) > 60) maxLowNoise = Math.max(maxLowNoise, intensity[i]);
    }
    expect(maxLowNoise).toBeGreaterThan(28);
  });
});
