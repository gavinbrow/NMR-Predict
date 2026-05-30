import { describe, expect, it } from "vitest";
import { detectCopolymer } from "../polymers";
import { BUILTIN_ADDUCTS, ionMz } from "../adducts";
import type { Peak } from "../types";

const EO = 44.026215; // ethylene oxide
const PO = 58.041865; // propylene oxide
const END = 18.010565; // H2O

describe("detectCopolymer", () => {
  it("recovers a 2-D EO/PO lattice", () => {
    const na = BUILTIN_ADDUCTS.find((a) => a.id === "Na")!;
    const peaks: Peak[] = [];
    let id = 0;
    for (let a = 0; a <= 3; a += 1) {
      for (let b = 0; b <= 3; b += 1) {
        const neutral = END + a * EO + b * PO;
        peaks.push({ id: `p${id++}`, mz: ionMz(neutral, na), intensity: 100, accepted: true });
      }
    }
    const result = detectCopolymer(peaks, [na], { repeatA: EO, repeatB: PO, minMembers: 6 });
    expect(result.length).toBeGreaterThan(0);
    const best = result[0];
    expect(best.members.length).toBeGreaterThanOrEqual(12);
    // Genuine 2-D structure: both monomer indices vary.
    expect(new Set(best.members.map((m) => m.a)).size).toBeGreaterThan(1);
    expect(new Set(best.members.map((m) => m.b)).size).toBeGreaterThan(1);
    expect(best.meanErrorDa).toBeLessThan(0.1);
  });

  it("returns nothing when the two repeats are equal", () => {
    const na = BUILTIN_ADDUCTS.find((a) => a.id === "Na")!;
    const peaks: Peak[] = Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`,
      mz: 1000 + i * EO,
      intensity: 100,
      accepted: true,
    }));
    expect(detectCopolymer(peaks, [na], { repeatA: EO, repeatB: EO })).toEqual([]);
  });
});
