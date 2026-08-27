// Unit tests for the TGA compute engine.
//
// - Synthetic two-step curve with analytical answers.
// - Real DAC1 fixture, skipped when the local `TGA Test/` directory is absent.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { computeAnalysis, computeDtg, stepDetection, tdAt } from "../compute";
import { parseTaText } from "../parse/taText";
import { DEFAULT_PARAMS } from "../types";

const ROOT = resolve(__dirname, "../../../../../");
const DIR = resolve(ROOT, "TGA Test");
const DAC1_TXT = resolve(DIR, "DAC1.txt");
const present = existsSync(DAC1_TXT);

/** Build a synthetic two-step TGA curve: 100 % → 70 % from 100→200 °C,
 *  plateau to 300 °C, then 70 % → 30 % from 300→400 °C, plateau to 450 °C.
 *  The plateau regions are sampled more coarsely than the ramps so the SG
 *  derivative in index-space cleanly separates the two degradation steps on a
 *  non-uniform temperature grid. */
function makeTwoStepCurve(): {
  timeMin: Float64Array;
  tempC: Float64Array;
  weightMg: Float64Array;
} {
  const points: { t: number; temp: number; w: number }[] = [];
  // Ramp 1: 100 °C to 200 °C, weight 100 mg to 70 mg (101 points).
  for (let i = 0; i <= 100; i += 1) {
    points.push({ t: i * 0.1, temp: 100 + i, w: 100 - 0.3 * i });
  }
  // Plateau 1: 200 °C to 300 °C at 70 mg (50 points, 2 °C steps).
  for (let i = 1; i <= 50; i += 1) {
    points.push({ t: 10 + i * 0.2, temp: 200 + 2 * i, w: 70 });
  }
  // Ramp 2: 300 °C to 400 °C, weight 70 mg to 30 mg (101 points).
  for (let i = 1; i <= 100; i += 1) {
    points.push({ t: 20 + i * 0.1, temp: 300 + i, w: 70 - 0.4 * i });
  }
  // Plateau 2: 400 °C to 450 °C at 30 mg (50 points, 1 °C steps).
  for (let i = 1; i <= 50; i += 1) {
    points.push({ t: 30 + i * 0.1, temp: 400 + i, w: 30 });
  }
  const n = points.length;
  const timeMin = new Float64Array(n);
  const tempC = new Float64Array(n);
  const weightMg = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    timeMin[i] = points[i].t;
    tempC[i] = points[i].temp;
    weightMg[i] = points[i].w;
  }
  return { timeMin, tempC, weightMg };
}

describe("compute engine", () => {
  it("tdAt reports the correct analytical decomposition temperatures", () => {
    const { tempC, weightMg } = makeTwoStepCurve();
    const weightPct = Float64Array.from(weightMg.map((w) => w)); // 100 mg start → already %

    expect(tdAt(tempC, weightPct, 5)).toBeCloseTo(116.6667, 3);
    expect(tdAt(tempC, weightPct, 10)).toBeCloseTo(133.3333, 3);
    expect(tdAt(tempC, weightPct, 50)).toBeCloseTo(350, 3);
  });

  it("detects two steps with the correct mass losses on the synthetic curve", () => {
    const { timeMin, tempC, weightMg } = makeTwoStepCurve();
    const analysis = computeAnalysis(
      weightMg,
      tempC,
      timeMin,
      DEFAULT_PARAMS,
      { sampleSizeMg: 100 },
    );

    expect(analysis.warnings).toEqual([]);
    expect(analysis.steps.length).toBe(2);
    // The two plateaus give exact losses of 30 % and 40 % across the chosen bounds.
    expect(analysis.steps[0].lossPct).toBeCloseTo(30, 1);
    expect(analysis.steps[1].lossPct).toBeCloseTo(40, 1);
    expect(analysis.residue.pct).toBeCloseTo(30, 3);
    expect(analysis.residue.tempC).toBeCloseTo(450, 3);
  });

  it("DTG has two positive peaks near the ramp midpoints", () => {
    const { timeMin, tempC, weightMg } = makeTwoStepCurve();
    const weightPct = Float64Array.from(weightMg.map((w) => w));
    // Use the default SG window; on this synthetic curve the two ramps have
    // different slopes (0.3 and 0.4 %/°C), so the DTG peak values differ.
    // The step detector should recover two distinct degradation steps with Tmax
    // values inside each ramp.
    const { dtgPerDegC } = computeDtg(weightPct, tempC, timeMin, DEFAULT_PARAMS.dtgWindow);

    const steps = stepDetection(tempC, weightPct, weightMg, dtgPerDegC, 1);
    expect(steps.length).toBe(2);
    expect(steps[0].tMax).toBeGreaterThanOrEqual(100);
    expect(steps[0].tMax).toBeLessThanOrEqual(200);
    expect(steps[1].tMax).toBeGreaterThanOrEqual(300);
    expect(steps[1].tMax).toBeLessThanOrEqual(400);
  });

  it("residue at 450 °C is approximately 30 %", () => {
    const { timeMin, tempC, weightMg } = makeTwoStepCurve();
    const analysis = computeAnalysis(
      weightMg,
      tempC,
      timeMin,
      { ...DEFAULT_PARAMS, residueTempC: 450 },
      { sampleSizeMg: 100 },
    );

    expect(analysis.residue.pct).toBeCloseTo(30, 3);
    expect(analysis.residue.mg).toBeCloseTo(30, 3);
  });

  it("does not let an isothermal hold spike DTG", () => {
    // A hold-then-ramp procedure records thousands of points at one temperature.
    // dW/dT is undefined there, and dividing through a near-zero dT/di used to
    // produce spikes two orders of magnitude above the real peak — which then
    // swamped every relative threshold in step detection.
    const n = 400;
    const timeMin = new Float64Array(n);
    const tempC = new Float64Array(n);
    const weightMg = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      timeMin[i] = i * 0.1;
      if (i < 150) {
        // Isothermal hold at 25 °C, with a touch of balance noise.
        tempC[i] = 25 + (i % 3) * 1e-4;
        weightMg[i] = 100 - (i % 5) * 1e-3;
      } else {
        tempC[i] = 25 + (i - 150) * 2;
        weightMg[i] = 100 - 0.15 * (i - 150);
      }
    }
    const { dtgPerDegC } = computeDtg(weightMg, tempC, timeMin, DEFAULT_PARAMS.dtgWindow);
    let maxDtg = 0;
    let gaps = 0;
    for (let i = 0; i < n; i += 1) {
      if (!Number.isFinite(dtgPerDegC[i])) gaps += 1;
      else maxDtg = Math.max(maxDtg, Math.abs(dtgPerDegC[i]));
    }
    // The ramp loses 0.15 mg per 2 °C = 0.075 %/°C; the hold must not invent
    // anything larger.
    expect(maxDtg).toBeLessThan(1);
    // And the hold itself must come back as gaps, not numbers.
    expect(gaps).toBeGreaterThan(50);
  });

  it("drops a DTG peak whose real mass loss is under the step threshold", () => {
    const { timeMin, tempC, weightMg } = makeTwoStepCurve();
    // The first step loses 30 %; asking for 35 % must leave only the second.
    const analysis = computeAnalysis(
      weightMg,
      tempC,
      timeMin,
      { ...DEFAULT_PARAMS, stepMinLossPct: 35 },
      { sampleSizeMg: 100 },
    );
    expect(analysis.steps).toHaveLength(1);
    expect(analysis.steps[0].lossPct).toBeCloseTo(40, 1);
    // Surviving steps are renumbered so `index` stays dense.
    expect(analysis.steps[0].index).toBe(0);
  });

  it("computes finite DTG values across the ramp region", () => {
    const { timeMin, tempC, weightMg } = makeTwoStepCurve();
    const analysis = computeAnalysis(weightMg, tempC, timeMin, DEFAULT_PARAMS, { sampleSizeMg: 100 });
    // DTG should have finite values somewhere in the ramp regions.
    let finiteCount = 0;
    for (let i = 0; i < analysis.dtg.length; i++) {
      if (Number.isFinite(analysis.dtg[i])) finiteCount++;
    }
    expect(finiteCount).toBeGreaterThan(50);
  });
});

describe.skipIf(!present)("DAC1 real fixture", () => {
  it("parses and computes finite T5%, T10% and residue", () => {
    const buf = readFileSync(DAC1_TXT);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const result = parseTaText(ab, "DAC1.txt");
    expect(result.warnings).toEqual([]);
    expect(result.runs.length).toBe(1);

    const run = result.runs[0];
    const analysis = computeAnalysis(
      run.weightMg,
      run.tempC,
      run.timeMin,
      DEFAULT_PARAMS,
      { sampleSizeMg: run.meta.sampleSizeMg },
    );

    const t5 = analysis.td[5];
    const t10 = analysis.td[10];
    expect(t5).not.toBeNull();
    expect(t10).not.toBeNull();
    expect(t5).toBeGreaterThanOrEqual(100);
    expect(t5).toBeLessThanOrEqual(600);
    expect(t10).toBeGreaterThanOrEqual(100);
    expect(t10).toBeLessThanOrEqual(600);

    expect(Number.isFinite(analysis.residue.pct)).toBe(true);
    expect(analysis.residue.pct).toBeGreaterThan(0);
    expect(analysis.residue.pct).toBeLessThanOrEqual(100);

    // DTG should have at least one finite, positive peak.
    let hasPositivePeak = false;
    for (let i = 2; i < analysis.dtg.length - 2; i += 1) {
      if (
        Number.isFinite(analysis.dtg[i]) &&
        analysis.dtg[i] > 0 &&
        analysis.dtg[i] > analysis.dtg[i - 1] &&
        analysis.dtg[i] >= analysis.dtg[i + 1]
      ) {
        hasPositivePeak = true;
        break;
      }
    }
    expect(hasPositivePeak).toBe(true);
  });
});
