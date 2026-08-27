// Unit tests for the cross-run comparison builders: the metric list follows the
// user's Td thresholds, `metricValue` reads the right number off an analysis,
// and the material bars average only the runs a material actually holds.

import { describe, expect, it } from "vitest";
import {
  buildMaterialBars,
  buildRunBars,
  buildSummaryRows,
  metricValue,
  summarize,
  tgaMetrics,
} from "../compare";
import { computeAnalysis } from "../compute";
import { DEFAULT_PARAMS, type TgaMaterial, type TgaMetadata } from "../types";
import type { TgaRunAnalyzed } from "../store";

/** A single-step ramp from 100 % down to `endPct` % across 100→300 °C. */
function makeRun(id: string, color: string, endFraction = 0.6): TgaRunAnalyzed {
  const n = 201;
  const tempC = new Float64Array(n);
  const weightMg = new Float64Array(n);
  const timeMin = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    tempC[i] = 100 + t * 200;
    weightMg[i] = 10 * (1 - (1 - endFraction) * t);
    timeMin[i] = t * 20;
  }
  const meta: TgaMetadata = {
    instrument: "TA Q50",
    operator: "",
    sampleName: id,
    sampleSizeMg: 10,
    pan: "",
    methodSteps: [],
    runDate: "",
    gases: "",
  };
  return {
    id,
    fileId: "f1",
    fileName: `${id}.txt`,
    label: id,
    color,
    meta,
    segments: [{ label: "Ramp" }],
    timeMin,
    tempC,
    weightMg,
    scale: 1,
    offset: 0,
    visible: true,
    materialId: null,
    analysis: computeAnalysis(weightMg, tempC, timeMin, DEFAULT_PARAMS, { sampleSizeMg: 10 }),
  };
}

describe("tgaMetrics", () => {
  it("builds one Td metric per threshold, in ascending order", () => {
    const metrics = tgaMetrics([50, 5, 10]);
    expect(metrics.slice(0, 3).map((m) => m.key)).toEqual(["td:5", "td:10", "td:50"]);
    expect(metrics.slice(0, 3).map((m) => m.label)).toEqual(["T5%", "T10%", "T50%"]);
  });

  it("always ends with the fixed metrics", () => {
    const keys = tgaMetrics([]).map((m) => m.key);
    expect(keys).toEqual(["onset", "tmax", "residuePct", "residueMg", "massMg"]);
  });

  it("follows a custom threshold the user added", () => {
    expect(tgaMetrics([2, 5]).map((m) => m.key)).toContain("td:2");
  });
});

describe("metricValue", () => {
  const run = makeRun("A", "#2563eb");

  it("reads a Td threshold off the analysis", () => {
    expect(metricValue(run, "td:5")).toBeCloseTo(run.analysis.td[5] ?? NaN, 6);
  });

  it("returns NaN for a threshold that was never computed", () => {
    expect(metricValue(run, "td:99")).toBeNaN();
  });

  it("reports the residue as both percent and mg", () => {
    expect(metricValue(run, "residuePct")).toBeCloseTo(60, 3);
    expect(metricValue(run, "residueMg")).toBeCloseTo(6, 3);
  });

  it("falls back to the first recorded weight when metadata has no sample mass", () => {
    const noMeta = { ...run, meta: { ...run.meta, sampleSizeMg: null } };
    expect(metricValue(noMeta, "massMg")).toBeCloseTo(10, 6);
  });

  it("returns NaN for an unknown key rather than throwing", () => {
    expect(metricValue(run, "nonsense")).toBeNaN();
  });
});

describe("summarize", () => {
  it("returns the mean and the sample SD", () => {
    const { mean, sd, n } = summarize([1, 2, 3]);
    expect(mean).toBeCloseTo(2, 10);
    expect(sd).toBeCloseTo(1, 10);
    expect(n).toBe(3);
  });

  it("has no SD for a single value", () => {
    expect(summarize([4]).sd).toBeNaN();
  });

  it("ignores non-finite values", () => {
    expect(summarize([1, NaN, 3]).n).toBe(2);
  });
});

describe("buildSummaryRows", () => {
  it("names each run's material and fills every metric column", () => {
    const a = makeRun("A", "#2563eb");
    const b = makeRun("B", "#dc2626", 0.4);
    const materials: TgaMaterial[] = [{ id: "m1", name: "Blend 1", runIds: ["A", "B"] }];
    const metrics = tgaMetrics(DEFAULT_PARAMS.tdThresholds);
    const rows = buildSummaryRows([a, b], materials, metrics);
    expect(rows).toHaveLength(2);
    expect(rows[0].materialName).toBe("Blend 1");
    for (const m of metrics) expect(rows[0].values).toHaveProperty(m.key);
  });

  it("shows an em dash placeholder material for an ungrouped run", () => {
    const rows = buildSummaryRows([makeRun("A", "#000")], [], tgaMetrics([5]));
    expect(rows[0].materialName).toBe("—");
  });
});

describe("buildMaterialBars", () => {
  const a = makeRun("A", "#2563eb", 0.6);
  const b = makeRun("B", "#dc2626", 0.4);

  it("averages the metric over a material's member runs", () => {
    const materials: TgaMaterial[] = [{ id: "m1", name: "Blend", runIds: ["A", "B"] }];
    const bars = buildMaterialBars([a, b], materials, "residuePct");
    expect(bars).toHaveLength(1);
    expect(bars[0].n).toBe(2);
    expect(bars[0].mean).toBeCloseTo(50, 3); // (60 + 40) / 2
    expect(bars[0].sd).toBeGreaterThan(0);
    expect(bars[0].color).toBe("#2563eb"); // the first member's colour
  });

  it("drops a material whose runs are all gone", () => {
    const materials: TgaMaterial[] = [{ id: "m1", name: "Ghost", runIds: ["missing"] }];
    expect(buildMaterialBars([a], materials, "residuePct")).toEqual([]);
  });
});

describe("buildRunBars", () => {
  it("emits one zero-spread bar per run and skips runs with no value", () => {
    const a = makeRun("A", "#2563eb");
    const bars = buildRunBars([a], "residuePct");
    expect(bars).toHaveLength(1);
    expect(bars[0].sd).toBe(0);
    expect(bars[0].n).toBe(1);
    expect(buildRunBars([a], "td:99")).toEqual([]);
  });
});
