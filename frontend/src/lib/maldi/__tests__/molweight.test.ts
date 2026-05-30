import { describe, expect, it } from "vitest";
import {
  molecularWeightStats,
  selectPeaks,
  summarizeMolWeight,
} from "../molweight";
import { BUILTIN_ADDUCTS, ionMz } from "../adducts";
import type { Peak, Series } from "../types";

function peak(id: string, mz: number, intensity: number, extra: Partial<Peak> = {}): Peak {
  return { id, mz, intensity, accepted: true, ...extra };
}

describe("molecularWeightStats", () => {
  it("computes Mn/Mw/Đ for an equal-intensity distribution", () => {
    const items = [
      { mass: 100, intensity: 1 },
      { mass: 200, intensity: 1 },
      { mass: 300, intensity: 1 },
    ];
    const stats = molecularWeightStats(items);
    expect(stats.mn).toBeCloseTo(200, 6);
    expect(stats.mw).toBeCloseTo(233.3333, 3);
    expect(stats.dispersity).toBeCloseTo(1.16667, 4);
    expect(stats.peakMaxMass).toBe(100); // first of the tied maxima
    expect(stats.count).toBe(3);
  });

  it("derives DPn/DPw from a repeat unit and end group", () => {
    const items = [
      { mass: 144, intensity: 1 }, // end 44 + 100
      { mass: 244, intensity: 1 },
      { mass: 344, intensity: 1 },
    ];
    const stats = molecularWeightStats(items, { repeatMass: 100, endGroupMass: 44 });
    expect(stats.mn).toBeCloseTo(244, 6);
    expect(stats.dpn).toBeCloseTo(2, 6);
    expect(stats.dpw).toBeGreaterThan(stats.dpn!);
  });

  it("returns zeros for an empty selection", () => {
    const stats = molecularWeightStats([]);
    expect(stats.count).toBe(0);
    expect(stats.mn).toBe(0);
  });
});

describe("selectPeaks", () => {
  const peaks: Peak[] = [
    peak("a", 100, 10),
    peak("b", 200, 100),
    peak("c", 300, 5),
    peak("iso", 201, 9, { flag: "isotope" }),
    peak("mat", 190, 50, { flag: "matrix" }),
  ];
  const series: Series[] = [
    {
      id: "s1",
      label: "test",
      repeatMass: 100,
      endGroupMass: 0,
      adductId: "H",
      members: [
        { peakId: "a", n: 1 },
        { peakId: "b", n: 2 },
      ],
      score: 1,
    },
  ];

  it("excludes isotope and background peaks for 'all'", () => {
    const sel = selectPeaks(peaks, series, "all", {});
    expect(sel.map((p) => p.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("uses only series members for 'series'", () => {
    const sel = selectPeaks(peaks, series, "series", {});
    expect(sel.map((p) => p.id).sort()).toEqual(["a", "b"]);
  });

  it("applies a relative threshold for 'threshold'", () => {
    const sel = selectPeaks(peaks, series, "threshold", { intensityThreshold: 0.1 });
    // base = 100 (peak b), cut = 10 → keeps a(10) and b(100), drops c(5).
    expect(sel.map((p) => p.id).sort()).toEqual(["a", "b"]);
  });
});

describe("summarizeMolWeight with an adduct", () => {
  it("removes the adduct shift to report neutral masses", () => {
    const na = BUILTIN_ADDUCTS.find((a) => a.id === "Na")!;
    const peaks: Peak[] = [peak("a", ionMz(1000, na), 1), peak("b", ionMz(2000, na), 1)];
    const stats = summarizeMolWeight(peaks, [], "all", { adduct: na });
    expect(stats.massBasis).toBe("neutral");
    expect(stats.mn).toBeCloseTo(1500, 3);
  });
});
