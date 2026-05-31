import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBdb } from "../bdb";
import { recordsToSpectrum } from "../spectrum";

// Smoke test against a real Shimadzu .ispd, if one is present in the repo root.
// Validates the parser → spectrum chain end-to-end on genuine instrument bytes.
// Skips automatically when the fixture isn't there (so the suite stays green
// once the local test file is removed).
const FIXTURE = resolve(
  __dirname,
  "../../../../../1.5_1_1_DCPD_NORB_PETMP_3-18-26_150C_Very_Yellow1.ispd",
);
const present = existsSync(FIXTURE);

describe.skipIf(!present)("real .ispd file", () => {
  it("parses into an ascending wavenumber spectrum with A and %T", () => {
    const buf = readFileSync(FIXTURE);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const db = parseBdb(ab);
    expect(db.records.size).toBeGreaterThan(0);

    const spec = recordsToSpectrum(db.records, "fixture");
    expect(spec.wavenumber.length).toBeGreaterThan(100);
    expect(spec.wavenumber.length).toBe(spec.absorbance.length);
    expect(spec.wavenumber.length).toBe(spec.transmittance.length);
    for (let i = 1; i < spec.wavenumber.length; i += 1) {
      expect(spec.wavenumber[i]).toBeGreaterThan(spec.wavenumber[i - 1]);
    }
    expect(spec.meta.xmin).toBeGreaterThan(20);
    expect(spec.meta.xmax).toBeLessThan(9000);
    expect(spec.absorbance.every((v) => Number.isFinite(v))).toBe(true);
    expect(spec.transmittance.every((v) => Number.isFinite(v))).toBe(true);
  });
});
