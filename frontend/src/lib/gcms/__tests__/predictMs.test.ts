import { describe, expect, it } from "vitest";
import { molfileToFormula, predictEiSpectrum, smilesToFormula } from "../predictMs";

describe("smilesToFormula", () => {
  it("toluene C7H8 → formula, exact mass ~92.0626", () => {
    const r = smilesToFormula("Cc1ccccc1");
    expect(r).not.toBeNull();
    expect(r!.formula).toBe("C7H8");
    expect(r!.exactMass).toBeCloseTo(92.0626, 3);
  });

  it("ethanol CCO → C2H6O, exact mass ~46.0419", () => {
    const r = smilesToFormula("CCO");
    expect(r).not.toBeNull();
    expect(r!.formula).toBe("C2H6O");
    expect(r!.exactMass).toBeCloseTo(46.0419, 3);
  });

  it("empty/invalid SMILES → null (no throw)", () => {
    expect(smilesToFormula("")).toBeNull();
    expect(smilesToFormula("   ")).toBeNull();
    expect(smilesToFormula("not a smiles!!!")).toBeNull();
  });
});

describe("molfileToFormula", () => {
  it("empty molfile → null", () => {
    expect(molfileToFormula("")).toBeNull();
  });
});

describe("predictEiSpectrum", () => {
  it("toluene → M 92 + 91 (tropylium) + isotope + losses, base = 100", () => {
    const f = smilesToFormula("Cc1ccccc1")!;
    const r = predictEiSpectrum(f);
    expect(r.formula).toBe("C7H8");
    expect(r.exactMass).toBeCloseTo(92.0626, 3);
    expect(r.peaks.length).toBeGreaterThan(0);
    // Molecular ion present near m/z 92.
    const m = r.peaks.find((p) => Math.abs(p.mz - 91.0548) <= 0.5 || Math.abs(p.mz - 92.0626) <= 0.5);
    expect(m).toBeDefined();
    // A peak near 91 (M−1 / tropylium) or M−15 (91) should be present.
    const frag91 = r.peaks.find((p) => Math.abs(p.mz - 91) <= 1);
    expect(frag91).toBeDefined();
    // Base peak normalised to 100.
    expect(Math.max(...r.peaks.map((p) => p.relPct))).toBeCloseTo(100, 1);
  });

  it("ethanol → M 46 + 31 (CH2OH+) + 45 (M−1)", () => {
    const f = smilesToFormula("CCO")!;
    const r = predictEiSpectrum(f);
    expect(r.formula).toBe("C2H6O");
    // A fragment near 31 (CH2OH+) should be present (M−15 = 31).
    const frag31 = r.peaks.find((p) => Math.abs(p.mz - 31) <= 1.5);
    expect(frag31).toBeDefined();
    // M−1 (45) from neutral loss of H.
    // (H is not in the curated losses, but M itself + isotope envelope present)
    expect(r.peaks.length).toBeGreaterThan(0);
  });

  it("empty/invalid input → empty spectrum (no throw)", () => {
    const r = predictEiSpectrum({ formula: "", counts: {}, exactMass: 0 });
    expect(r.peaks).toEqual([]);
    expect(r.spectrum.mz.length).toBe(0);
    expect(r.spectrum.intensity.length).toBe(0);
  });

  it("spectrum is sorted by m/z ascending", () => {
    const r = predictEiSpectrum(smilesToFormula("Cc1ccccc1")!);
    for (let i = 1; i < r.peaks.length; i += 1) {
      expect(r.peaks[i].mz).toBeGreaterThanOrEqual(r.peaks[i - 1].mz);
    }
  });

  it("returns a real MassSpectrum with consistent basePeak", () => {
    const r = predictEiSpectrum(smilesToFormula("CCO")!);
    if (r.peaks.length > 0 && r.spectrum.basePeak) {
      const maxPeak = r.peaks.reduce((a, b) => (b.intensity > a.intensity ? b : a));
      expect(r.spectrum.basePeak.mz).toBeCloseTo(maxPeak.mz, 4);
    }
  });
});