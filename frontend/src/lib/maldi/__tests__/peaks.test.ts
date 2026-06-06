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

  it("does not double-pick a single peak with a noisy top", () => {
    // A single Gaussian whose crest carries small jitter — the kind of noisy peak
    // top that used to yield several adjacent "maxima" (the duplicate-label bug).
    const n = 600;
    const mz = new Float64Array(n);
    const intensity = new Float64Array(n);
    let seed = 3;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < n; i += 1) {
      mz[i] = 1000 + i * 0.02;
      const d = mz[i] - 1006;
      intensity[i] = 5000 * Math.exp(-(d * d) / (2 * 0.2 * 0.2)) + (rand() - 0.5) * 60;
    }
    const peaks = pickPeaks({ mz, intensity }, { ...PEAK_PRESETS.balanced });
    const real = peaks.filter((p) => !p.flag);
    expect(real.length).toBe(1);
    expect(Math.abs((real[0].centroid ?? real[0].mz) - 1006)).toBeLessThan(0.1);
  });

  it("rejects low-prominence baseline noise but keeps a real low peak", () => {
    // Pure random baseline (hundreds of tiny local maxima, all low-prominence) plus
    // one genuine peak. The prominence gate must keep the peak and drop the noise.
    const n = 1000;
    const mz = new Float64Array(n);
    const intensity = new Float64Array(n);
    let seed = 11;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const center = 525;
    for (let i = 0; i < n; i += 1) {
      mz[i] = 500 + i * 0.05;
      const d = mz[i] - center;
      intensity[i] = rand() * 200 + 1500 * Math.exp(-(d * d) / (2 * 0.15 * 0.15));
    }
    const peaks = pickPeaks({ mz, intensity }, { ...PEAK_PRESETS.balanced, minRelIntensity: 0 });
    const mzs = peaks.map((p) => p.centroid ?? p.mz);
    expect(mzs.some((m) => Math.abs(m - center) < 0.2)).toBe(true);
    // Far fewer than the ~250 noise maxima a naive local-max picker would return.
    expect(peaks.length).toBeLessThan(20);
  });

  it("resolves overlapping isotopes whose valleys sit above half-max", () => {
    // Three isotopes 1.0033 Da apart, broad enough (σ≈0.4) that the valleys
    // between them never fall below any peak's half-max. A FWHM-based centroid
    // walks straight across those valleys and smears all three onto the envelope's
    // centre of mass (the real-data bug: a whole "mountain" collapsing to one
    // peak). The basin-bounded centroid must keep three distinct peaks, each on
    // its own apex.
    const n = 600;
    const mz = new Float64Array(n);
    const intensity = new Float64Array(n);
    let seed = 5;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const centers = [1000.0, 1001.0033, 1002.0066];
    const amps = [9000, 8000, 7000];
    const sigma = 0.35;
    for (let i = 0; i < n; i += 1) {
      mz[i] = 996 + i * 0.02;
      let v = 200 + (rand() - 0.5) * 80; // small noisy pedestal
      for (let k = 0; k < centers.length; k += 1) {
        const d = mz[i] - centers[k];
        v += amps[k] * Math.exp(-(d * d) / (2 * sigma * sigma));
      }
      intensity[i] = v;
    }
    const peaks = pickPeaks({ mz, intensity }, { ...PEAK_PRESETS.balanced, minRelIntensity: 0 });
    const real = peaks.filter((p) => !p.flag).map((p) => p.centroid ?? p.mz).sort((a, b) => a - b);
    expect(real.length).toBe(3);
    // Each centroid sits on its own isotope, not the smeared ~1001 centre.
    for (let k = 0; k < centers.length; k += 1) {
      expect(Math.abs(real[k] - centers[k])).toBeLessThan(0.3);
    }
    // And they span the full envelope (proof they did not collapse together).
    expect(real[2] - real[0]).toBeGreaterThan(1.8);
  });

  it("merges peaks closer than the min separation, keeping the taller", () => {
    const n = 400;
    const mz = new Float64Array(n);
    const intensity = new Float64Array(n);
    for (let i = 0; i < n; i += 1) mz[i] = 800 + i * 0.01;
    const addGaussian = (c: number, a: number) => {
      for (let i = 0; i < n; i += 1) {
        const d = mz[i] - c;
        intensity[i] += a * Math.exp(-(d * d) / (2 * 0.03 * 0.03));
      }
    };
    addGaussian(801.9, 3000);
    addGaussian(802.0, 6000); // 0.1 Da apart — inside the 0.3 Da separation
    const peaks = pickPeaks(
      { mz, intensity },
      { ...PEAK_PRESETS.balanced, minSeparation: 0.3, smoothing: 0 },
    );
    const real = peaks.filter((p) => !p.flag);
    expect(real.length).toBe(1);
    expect(Math.abs((real[0].centroid ?? real[0].mz) - 802.0)).toBeLessThan(0.1);
  });

  it("monoisotopicOnly keeps the left-most peak of each isotope envelope", () => {
    // Two envelopes (1000 and 1224), each a monoisotopic peak plus two ¹³C
    // satellites ~1.0033 Da apart. The satellites are made TALLER than the
    // monoisotopic peak (the polymer case) to prove the choice is spacing-based,
    // not intensity-based.
    const n = 6000;
    const mz = new Float64Array(n);
    const intensity = new Float64Array(n);
    for (let i = 0; i < n; i += 1) mz[i] = 980 + i * 0.05;
    const addGaussian = (c: number, a: number) => {
      for (let i = 0; i < n; i += 1) {
        const d = mz[i] - c;
        intensity[i] += a * Math.exp(-(d * d) / (2 * 0.04 * 0.04));
      }
    };
    const mono = [1000.0, 1224.0];
    for (const m of mono) {
      addGaussian(m, 3000); // A   (monoisotopic — deliberately the shortest)
      addGaussian(m + 1.0033, 6000); // A+1 (taller)
      addGaussian(m + 2.0066, 4500); // A+2
    }
    const spectrum: SpectrumData = { mz, intensity };
    const params: Partial<PeakPickParams> = { ...PEAK_PRESETS.balanced, minSeparation: 0.3, smoothing: 0 };

    const all = pickPeaks(spectrum, params as PeakPickParams);
    expect(all.length).toBeGreaterThanOrEqual(6); // ~3 isotopes × 2 envelopes

    const deiso = pickPeaks(spectrum, { ...(params as PeakPickParams), monoisotopicOnly: true });
    const keptMz = deiso.map((p) => p.centroid ?? p.mz).sort((a, b) => a - b);
    // Exactly the two monoisotopic peaks survive — satellites dropped despite
    // being taller than the monoisotopic peak.
    expect(keptMz.length).toBe(2);
    expect(Math.abs(keptMz[0] - 1000.0)).toBeLessThan(0.1);
    expect(Math.abs(keptMz[1] - 1224.0)).toBeLessThan(0.1);
  });
});
