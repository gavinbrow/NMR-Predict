import { describe, expect, it } from "vitest";
import {
  exactMass,
  formatFormula,
  formulaMass,
  generateFormulaCandidates,
  isotopePattern,
  nominalMass,
  parseFormula,
  rdbe,
} from "../formula";

describe("parseFormula", () => {
  it("parses a simple formula", () => {
    expect(parseFormula("C2H4O")).toEqual({ C: 2, H: 4, O: 1 });
  });

  it("expands nested groups with multipliers", () => {
    expect(parseFormula("CH3(CH2)4CH3")).toEqual({ C: 6, H: 14 });
  });

  it("handles bracket groups and trailing atoms", () => {
    expect(parseFormula("(C2H4O)10H2O")).toEqual({ C: 20, H: 42, O: 11 });
  });

  it("throws on an unsupported element", () => {
    expect(() => parseFormula("Xe2")).toThrow(/Unsupported element/);
  });
});

describe("masses", () => {
  it("computes the exact mass of water", () => {
    expect(exactMass({ H: 2, O: 1 })).toBeCloseTo(18.010565, 4);
  });

  it("computes the exact and nominal mass of glucose", () => {
    const m = formulaMass("C6H12O6");
    expect(m.exact).toBeCloseTo(180.063388, 4);
    expect(m.nominal).toBe(180);
    expect(m.formula).toBe("C6H12O6");
  });

  it("computes nominal mass independent of isotope decimals", () => {
    expect(nominalMass({ C: 1, O: 2 })).toBe(44); // CO2
  });

  it("computes RDBE for benzene", () => {
    expect(rdbe({ C: 6, H: 6 })).toBe(4);
  });
});

describe("formatFormula", () => {
  it("orders by Hill system", () => {
    expect(formatFormula({ O: 2, C: 3, H: 8 })).toBe("C3H8O2");
  });
});

describe("isotopePattern", () => {
  it("reproduces the chlorine A/A+2 ratio (~3:1)", () => {
    const peaks = isotopePattern({ Cl: 1 });
    expect(peaks).toHaveLength(2);
    expect(peaks[0].mass).toBeCloseTo(34.9689, 2);
    expect(peaks[1].mass).toBeCloseTo(36.9659, 2);
    // 0.2424 / 0.7576 ≈ 0.320
    expect(peaks[1].abundance).toBeCloseTo(0.32, 2);
  });

  it("reproduces the bromine ~1:1 doublet", () => {
    const peaks = isotopePattern({ Br: 1 });
    expect(peaks).toHaveLength(2);
    expect(peaks[1].abundance).toBeCloseTo(0.973, 2);
  });

  it("shows a strong A+2 for silver", () => {
    const peaks = isotopePattern({ Ag: 1 });
    expect(peaks[1].abundance).toBeCloseTo(0.929, 2);
  });

  it("grows the A+1 carbon peak with the number of carbons", () => {
    const small = isotopePattern({ C: 10 });
    const big = isotopePattern({ C: 100 });
    const a1Small = small.find((p) => Math.round(p.mass) === 121); // 10*12 + 1
    const a1Big = big.find((p) => Math.round(p.mass) === 1201);
    expect(a1Small?.abundance).toBeGreaterThan(0);
    expect(a1Big!.abundance).toBeGreaterThan(a1Small!.abundance);
  });

  it("collapses to unit resolution when requested", () => {
    const fine = isotopePattern({ S: 1 }, { minAbundance: 1e-4 });
    const unit = isotopePattern({ S: 1 }, { minAbundance: 1e-4, unitResolution: true });
    expect(unit.length).toBeLessThanOrEqual(fine.length);
    expect(unit.every((p) => Number.isInteger(Math.round(p.mass)))).toBe(true);
  });
});

describe("generateFormulaCandidates", () => {
  it("recovers glucose for its neutral mass", () => {
    const candidates = generateFormulaCandidates(180.063388, {
      elements: ["C", "H", "N", "O"],
      toleranceDa: 0.01,
    });
    expect(candidates.some((c) => c.formula === "C6H12O6")).toBe(true);
    // Best match should be essentially exact.
    expect(Math.abs(candidates[0].errorDa)).toBeLessThan(0.01);
  });

  it("respects the RDBE window", () => {
    const candidates = generateFormulaCandidates(180.063388, {
      elements: ["C", "H", "N", "O"],
      toleranceDa: 0.02,
      rdbeMin: 0,
      rdbeMax: 2,
    });
    expect(candidates.every((c) => c.rdbe >= 0 && c.rdbe <= 2)).toBe(true);
  });

  it("returns nothing for an impossible tiny mass", () => {
    expect(generateFormulaCandidates(0.4, { elements: ["C", "H", "O"] })).toEqual([]);
  });
});
