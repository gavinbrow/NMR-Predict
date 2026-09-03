// Real-fixture tests for the DSC parsers, mirroring
// `lib/tga/__tests__/parse.realfile.test.ts`'s skip-if-absent pattern. The
// fixtures live in `DSC Examples/` at the repo root; when they're absent the
// whole describe block is skipped. When present, this is the proof the
// binary marker walk (§2.1) and the section-aware Excel Details reader
// (§2.2) are decoding real TRIOS DSC25 files correctly, not just synthetic
// ones — assertions are checked against the plan's verified byte-level table.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTriosTri } from "../parse/triosTri";
import { parseTriosXls } from "../parse/triosXls";

const ROOT = resolve(__dirname, "../../../../../");
const DIR = resolve(ROOT, "DSC Examples");
const present = existsSync(DIR);

const DAC1 = resolve(DIR, "DAC1.tri");
const S1_TRI = resolve(DIR, "1-2 S1.tri");
const S1_XLS = resolve(DIR, "1-2 S1.xls");

function readAb(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe.skipIf(!present)("DSC realfile parsers", () => {
  it(
    "DAC1.tri: 1 run, 4 segments (heat/cool/heat/cool) all ~10 °C/min, mass 4.4 mg",
    () => {
      const result = parseTriosTri(readAb(DAC1), "DAC1.tri");
      expect(result.runs).toHaveLength(1);
      const run = result.runs[0];

      expect(run.segments).toHaveLength(4);
      expect(run.segments.map((s) => s.kind)).toEqual(["heat", "cool", "heat", "cool"]);
      for (const seg of run.segments) {
        expect(seg.rateCPerMin).not.toBeNull();
        expect(seg.rateCPerMin as number).toBeGreaterThan(9);
        expect(seg.rateCPerMin as number).toBeLessThan(11);
      }

      // mg, not kg (a ×1e6 bug would read ~4 400 000).
      expect(run.meta.sampleMassMg).toBe(4.4);

      // Segment 0 (heat 1) reaches ~278.5 °C — the trailing-zero trim shaves
      // a few tenths of a degree off the untrimmed 278.5 peak, hence "≈".
      const seg0 = run.segments[0];
      let maxT = -Infinity;
      let minHf = Infinity;
      let maxHf = -Infinity;
      for (let i = seg0.start; i < seg0.end; i++) {
        if (run.tempC[i] > maxT) maxT = run.tempC[i];
        const hf = run.heatFlowMw[i];
        if (hf < minHf) minHf = hf;
        if (hf > maxHf) maxHf = hf;
      }
      expect(maxT).toBeGreaterThan(277);
      expect(maxT).toBeLessThan(279);

      // Heat flow (mW) in segment 0 spans ≈ −5.26 → 1.71.
      expect(minHf).toBeGreaterThan(-5.6);
      expect(minHf).toBeLessThan(-4.9);
      expect(maxHf).toBeGreaterThan(1.4);
      expect(maxHf).toBeLessThan(2.0);
    },
    20_000,
  );

  it(
    "1-2 S1.tri: mass 11.69 mg, first Heat Flow (mW) / mass ≈ 0.0676 W/g",
    () => {
      const result = parseTriosTri(readAb(S1_TRI), "1-2 S1.tri");
      expect(result.runs).toHaveLength(1);
      const run = result.runs[0];
      expect(run.meta.sampleMassMg).toBe(11.69);
      // mW / mg === W/g exactly.
      expect(run.heatFlowMw[0] / run.meta.sampleMassMg!).toBeCloseTo(0.0676, 3);
    },
    20_000,
  );

  it(
    "1-2 S1.xls: 1 run, 4 segments, exo-up, mass 11.69 mg, first normalized heat flow ≈ 0.068",
    () => {
      const result = parseTriosXls(readAb(S1_XLS), "1-2 S1.xls");
      expect(result.runs).toHaveLength(1);
      const run = result.runs[0];
      expect(run.segments).toHaveLength(4);
      expect(run.meta.exoDirection).toBe("up");
      expect(run.meta.sampleMassMg).toBeCloseTo(11.69, 5);
      expect(run.heatFlowNormFile).toBeDefined();
      expect(run.heatFlowNormFile![0]).toBeCloseTo(0.068, 3);
      // Every .xls import warns once about the 3 dp rounding (§2.2).
      expect(result.warnings.some((w) => w.includes("3 decimal"))).toBe(true);

      // Regression: a Time-tie dedupe bug used to discard ~5 of every 6 real
      // rows (16801 raw → 2801 survivors) and left a blank trailing
      // Temperature cell as a NaN sample at each segment's last index,
      // which made every segment misclassify as "cool" with a NaN rate
      // instead of the true heat/cool/heat/cool alternation. Each ramp
      // sheet in this file holds 16801 raw data rows, so a healthy segment
      // should land in the high thousands, not ~2801.
      expect(run.segments.map((s) => s.kind)).toEqual(["heat", "cool", "heat", "cool"]);
      for (const seg of run.segments) {
        expect(seg.rateCPerMin).not.toBeNull();
        expect(seg.rateCPerMin as number).toBeGreaterThan(9);
        expect(seg.rateCPerMin as number).toBeLessThan(11);
        expect(seg.end - seg.start).toBeGreaterThan(16000);
      }
      for (let i = 0; i < run.tempC.length; i++) {
        expect(Number.isFinite(run.tempC[i])).toBe(true);
      }
    },
    30_000,
  );
});
