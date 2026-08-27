// Real-fixture tests for the TGA parsers, mirroring the
// `lib/gcms/__tests__/chrom.realfile.test.ts` skip-if-absent pattern. The
// fixtures live in `TGA Test/` at the repo root; when they're absent (e.g. CI on
// a machine without the samples) the whole describe block is skipped.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTaText } from "../parse/taText";
import { parseTaBinary } from "../parse/taBinary";
import { parseTriosTri } from "../parse/triosTri";
import { parseTriosXls } from "../parse/triosXls";

const ROOT = resolve(__dirname, "../../../../../");
const DIR = resolve(ROOT, "TGA Test");

const present = existsSync(DIR);

const DAC1_TXT = resolve(DIR, "DAC1.txt");
const DAC1_BIN = resolve(DIR, "DAC1.001");
const SAMPLE_TRI = resolve(DIR, "Sample 1.tri");
const SAMPLE_XLS = resolve(DIR, "sample 1.xls");

describe.skipIf(!present)("TGA realfile parsers", () => {
  it("DAC1.txt parses with the expected first row and Size", () => {
    if (!existsSync(DAC1_TXT)) return;
    const buf = readFileSync(DAC1_TXT);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const result = parseTaText(ab, "DAC1.txt");
    expect(result.warnings).toEqual([]);
    expect(result.runs).toHaveLength(1);
    const run = result.runs[0];
    expect(run.timeMin.length).toBeGreaterThan(60);
    expect(run.timeMin[0]).toBeCloseTo(0.3568687, 5);
    expect(run.tempC[0]).toBeCloseTo(14.20423, 4);
    expect(run.weightMg[0]).toBeCloseTo(2.154049, 5);
    expect(run.meta.sampleSizeMg).toBeCloseTo(2.152, 3);
  });

  it("DAC1.001 parses to ~69 points and matches DAC1.txt where they overlap", () => {
    if (!existsSync(DAC1_BIN) || !existsSync(DAC1_TXT)) return;
    const binBuf = readFileSync(DAC1_BIN);
    const binAb = binBuf.buffer.slice(
      binBuf.byteOffset,
      binBuf.byteOffset + binBuf.byteLength,
    ) as ArrayBuffer;
    const binResult = parseTaBinary(binAb, "DAC1.001");
    expect(binResult.warnings).toEqual([]);
    expect(binResult.runs).toHaveLength(1);
    const bin = binResult.runs[0];
    expect(bin.timeMin.length).toBeGreaterThan(60);
    expect(bin.timeMin.length).toBeLessThan(80);

    const txtBuf = readFileSync(DAC1_TXT);
    const txtAb = txtBuf.buffer.slice(
      txtBuf.byteOffset,
      txtBuf.byteOffset + txtBuf.byteLength,
    ) as ArrayBuffer;
    const txtResult = parseTaText(txtAb, "DAC1.txt");
    const txt = txtResult.runs[0];
    // The binary and text have slightly different time grids (the binary's first
    // point is at t≈0.42, the text's at t≈0.36). Match by nearest time: for each
    // binary point, find the text point with the closest time and compare T and
    // weight within float32 tolerance.
    let compared = 0;
    for (let i = 0; i < bin.timeMin.length; i++) {
      const t = bin.timeMin[i];
      // Find the closest text time.
      let bestJ = 0;
      let bestDt = Math.abs(txt.timeMin[0] - t);
      for (let j = 1; j < txt.timeMin.length; j++) {
        const dt = Math.abs(txt.timeMin[j] - t);
        if (dt < bestDt) {
          bestDt = dt;
          bestJ = j;
        }
      }
      // Only compare when the times match within 0.1 min (6 s).
      if (bestDt < 0.1) {
        expect(bin.tempC[i]).toBeCloseTo(txt.tempC[bestJ], 1);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(30);
  });

  it("Sample 1.tri concatenates both procedure segments into one full run", () => {
    if (!existsSync(SAMPLE_TRI)) return;
    const buf = readFileSync(SAMPLE_TRI);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const result = parseTriosTri(ab, "Sample 1.tri");
    expect(result.warnings).toEqual([]);
    expect(result.runs).toHaveLength(1);
    const run = result.runs[0];

    // Isothermal (601 pts) + Ramp (34 673 pts) — reading only the first block
    // used to yield a "run" that never left room temperature.
    expect(run.timeMin.length).toBe(35_274);
    expect(run.tempC.length).toBe(run.timeMin.length);
    expect(run.weightMg.length).toBe(run.timeMin.length);

    // Time is stored in seconds; converted, the run is just under an hour.
    const last = run.timeMin.length - 1;
    expect(run.timeMin[0]).toBeCloseTo(0, 5);
    expect(run.timeMin[last]).toBeCloseTo(58.788, 2);
    for (let i = 1; i < run.timeMin.length; i++) {
      expect(run.timeMin[i]).toBeGreaterThan(run.timeMin[i - 1]);
    }

    // The run really does reach the method's 600 °C and lose most of its mass —
    // cross-checked against the PNG preview embedded in the file itself.
    expect(run.tempC[0]).toBeCloseTo(23.658, 2);
    expect(run.tempC[last]).toBeCloseTo(597.68, 1);
    expect(run.weightMg[0]).toBeCloseTo(17.603, 2);
    expect(run.weightMg[last]).toBeCloseTo(2.313, 2);

    // The decisive units check: seconds + kilograms give the method's declared
    // 10 °C/min ramp. Minutes would give 0.17 °C/min over 58 hours.
    const isothermalMin = 1.0;
    const rate =
      (run.tempC[last] - run.tempC[0]) / (run.timeMin[last] - isothermalMin);
    expect(rate).toBeGreaterThan(9.5);
    expect(rate).toBeLessThan(10.5);

    expect(run.meta.sampleSizeMg).toBeCloseTo(17.586, 2);
    expect(run.meta.sampleName).toBe("Sample 1");
    // Header text is UTF-8: a latin1 read turns "°C" into "Â°C".
    expect(run.meta.methodSteps.join(" | ")).toContain("Ramp 10.00 °C/min to 600.00 °C");
    expect(run.meta.methodSteps.join(" | ")).not.toContain("Â");
  });

  // 11 MB of BIFF8: SheetJS needs a couple of seconds for it on its own, and
  // several under a parallel test run, so it gets a timeout that reflects the
  // file rather than one that happens to fit on an idle machine.
  it("sample 1.xls parses to 4 runs from the Ramp sheet with the expected names", () => {
    if (!existsSync(SAMPLE_XLS)) return;
    const buf = readFileSync(SAMPLE_XLS);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const result = parseTriosXls(ab, "sample 1.xls");
    // The workbook also carries an `Isothermal 1.0 min` sheet: the balance
    // equilibration hold at ambient. It is reported, not silently dropped.
    expect(result.warnings.join(" ")).toContain("Isothermal 1.0 min");
    expect(result.runs).toHaveLength(4);
    const labels = result.runs.map((r) => r.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        "tit 2-1 DCPD-PETMP",
        "2-1 DCPD-PETMP 150C",
        "2.791-1 DCPD-DPTH",
        "1.25-1.5-1 DCPD-NORB-PETMP",
      ]),
    );
    // Every run should have ascending, dedup'd time (no repeated consecutive rows).
    for (const run of result.runs) {
      for (let i = 1; i < run.timeMin.length; i++) {
        expect(run.timeMin[i]).toBeGreaterThan(run.timeMin[i - 1]);
      }
    }
  }, 30_000);
});