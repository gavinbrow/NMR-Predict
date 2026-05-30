import { describe, expect, it } from "vitest";
import { detectLosses } from "../losses";
import type { Peak } from "../types";

function peak(id: string, mz: number, intensity = 100): Peak {
  return { id, mz, intensity, accepted: true };
}

describe("detectLosses", () => {
  it("identifies a water and a CO loss from a parent", () => {
    const peaks: Peak[] = [
      peak("frag-h2o", 1000 - 18.010565),
      peak("frag-co", 1000 - 27.994915),
      peak("parent", 1000),
    ];
    const events = detectLosses(peaks, { toleranceDa: 0.05 });
    const labels = events.map((e) => e.lossLabel);
    expect(labels).toContain("H2O");
    expect(labels).toContain("CO");
    const h2o = events.find((e) => e.lossLabel === "H2O")!;
    expect(h2o.parentPeakId).toBe("parent");
    expect(h2o.fragmentPeakId).toBe("frag-h2o");
  });

  it("ignores gaps larger than maxDelta", () => {
    const peaks: Peak[] = [peak("a", 100), peak("b", 100 + 18.010565 + 500)];
    expect(detectLosses(peaks, { maxDelta: 60 })).toEqual([]);
  });

  it("skips isotope-flagged peaks", () => {
    const peaks: Peak[] = [
      peak("a", 982),
      { ...peak("iso", 1000), flag: "isotope" },
    ];
    expect(detectLosses(peaks)).toEqual([]);
  });
});
