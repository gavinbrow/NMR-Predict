import { describe, expect, it } from "vitest";
import { clusterByKmd, kendrickAnalysis } from "../kendrick";
import { manualPeak } from "../peaks";
import { makePegSpectrum, PEG_REPEAT } from "./fixtures";

describe("kendrickAnalysis", () => {
  it("gives a constant Kendrick mass defect within a homologous series", () => {
    const fixture = makePegSpectrum();
    const peaks = fixture.truePeakMz.map((mz) => manualPeak(mz, 100));
    const points = kendrickAnalysis(peaks, PEG_REPEAT);
    expect(points.length).toBe(peaks.length);

    const kmds = points.map((p) => p.kmd);
    const spread = Math.max(...kmds) - Math.min(...kmds);
    // All oligomers of one series share a KMD row (tiny spread from rounding).
    expect(spread).toBeLessThan(0.02);
  });

  it("clusters one PEG series into a single KMD row", () => {
    const fixture = makePegSpectrum();
    const peaks = fixture.truePeakMz.map((mz) => manualPeak(mz, 100));
    const points = kendrickAnalysis(peaks, PEG_REPEAT);
    const clusters = clusterByKmd(points, 0.02);
    expect(clusters.length).toBe(1);
    expect(clusters[0].members.length).toBe(peaks.length);
  });
});
