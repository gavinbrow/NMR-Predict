import { describe, expect, it } from "vitest";
import {
  ALL_BUILTIN_ADDUCTS,
  NEGATIVE_ADDUCTS,
  ionMz,
  neutralMass,
} from "../adducts";

describe("negative-mode adducts", () => {
  it("includes deprotonation, chloride, formate and acetate", () => {
    const ids = NEGATIVE_ADDUCTS.map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(["minusH", "plusCl", "formate", "acetate"]));
    expect(NEGATIVE_ADDUCTS.every((a) => a.charge === -1)).toBe(true);
  });

  it("[M−H]− places the ion ~1.0073 below the neutral mass", () => {
    const minusH = NEGATIVE_ADDUCTS.find((a) => a.id === "minusH")!;
    const mz = ionMz(1000, minusH);
    expect(mz).toBeCloseTo(998.9927, 3);
  });

  it("[M+Cl]− adds chloride (~34.969) and round-trips back to neutral", () => {
    const cl = NEGATIVE_ADDUCTS.find((a) => a.id === "plusCl")!;
    const mz = ionMz(1000, cl);
    expect(mz).toBeCloseTo(1034.9694, 3);
    expect(neutralMass(mz, cl)).toBeCloseTo(1000, 6);
  });

  it("round-trips m/z ↔ neutral for every built-in adduct", () => {
    for (const a of ALL_BUILTIN_ADDUCTS) {
      const mz = ionMz(1500, a);
      expect(neutralMass(mz, a)).toBeCloseTo(1500, 6);
    }
  });
});
