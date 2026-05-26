import { describe, expect, it } from "vitest";
import {
  atomChargeText,
  atomHydrogenCount,
  atomHydrogenPrefix,
  parseMolfile,
} from "./molfile";

const ETHANOL_MOLFILE = `
ethanol
  NMR Predict

  3  2  0  0  0  0            999 V2000
    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.5000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    3.0000    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0  0  0  0
  2  3  1  0  0  0  0
M  END
`.trimStart();

const AMMONIUM_MOLFILE = `
ammonium
  NMR Predict

  1  0  0  0  0  0            999 V2000
    0.0000    0.0000    0.0000 N   0  3  0  0  0  0  0  0  0  0  0  0
M  CHG  1   1   1
M  END
`.trimStart();

describe("parseMolfile", () => {
  it("parses atoms and bonds from V2000 molfile text", () => {
    const parsed = parseMolfile(ETHANOL_MOLFILE);

    expect(parsed?.atoms.map((atom) => atom.element)).toEqual(["C", "C", "O"]);
    expect(parsed?.bonds[0]).toMatchObject({ from: 0, to: 1, order: 1, stereo: 0 });
    expect(parsed?.bonds[1]).toMatchObject({ from: 1, to: 2, order: 1, stereo: 0 });
  });

  it("uses backend hydrogen counts for hetero atom labels", () => {
    const parsed = parseMolfile(ETHANOL_MOLFILE);
    expect(parsed).not.toBeNull();

    const oxygen = parsed!.atoms[2];
    expect(atomHydrogenCount(parsed!, oxygen, [3, 2, 1])).toBe(1);
    expect(atomHydrogenPrefix(parsed!, oxygen)).toBe(false);
  });

  it("parses M  CHG charge overrides", () => {
    const parsed = parseMolfile(AMMONIUM_MOLFILE);

    expect(parsed?.atoms[0].charge).toBe(1);
    expect(atomChargeText(parsed?.atoms[0].charge ?? 0)).toBe("+");
  });
});
