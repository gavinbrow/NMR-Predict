// Unit tests for the TGA export builders. Everything under test here is pure:
// the CSV row builders and the `.tgaproj` round trip. The download plumbing and
// the ExcelJS/jsPDF writers are exercised by hand (and by the Excel chart tests
// next door), not here.

import { describe, expect, it } from "vitest";
import {
  buildCurvesCsvRows,
  buildStepsCsvRows,
  buildSummaryCsvRows,
  deserializeTgaProject,
  serializeTgaProject,
  toCsv,
} from "../export";
import { buildSummaryRows, tgaMetrics } from "../compare";
import { computeAnalysis } from "../compute";
import { DEFAULT_PARAMS, type TgaMetadata, type TgaState } from "../types";
import type { TgaRunAnalyzed } from "../store";

function makeRun(id: string, points = 51): TgaRunAnalyzed {
  const tempC = new Float64Array(points);
  const weightMg = new Float64Array(points);
  const timeMin = new Float64Array(points);
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    tempC[i] = 100 + t * 200;
    weightMg[i] = 10 * (1 - 0.4 * t);
    timeMin[i] = t * 20;
  }
  const meta: TgaMetadata = {
    instrument: "TA Q50",
    operator: "gb",
    sampleName: id,
    sampleSizeMg: 10,
    pan: "Platinum",
    methodSteps: ["Ramp 10 °C/min to 300 °C"],
    runDate: "2026-01-01",
    gases: "N2",
  };
  return {
    id,
    fileId: "f1",
    fileName: `${id}.txt`,
    label: id,
    color: "#2563eb",
    meta,
    segments: [{ label: "Ramp" }],
    timeMin,
    tempC,
    weightMg,
    scale: 1,
    offset: 0,
    visible: true,
    materialId: "m1",
    analysis: computeAnalysis(weightMg, tempC, timeMin, DEFAULT_PARAMS, { sampleSizeMg: 10 }),
  };
}

describe("toCsv", () => {
  it("quotes cells containing a comma, quote or newline", () => {
    expect(toCsv([["a,b", 'say "hi"', "plain"]])).toBe('"a,b","say ""hi""",plain');
  });

  it("writes CRLF line endings so Excel on Windows opens it cleanly", () => {
    expect(toCsv([["a"], ["b"]])).toBe("a\r\nb");
  });

  it("renders null and undefined as empty cells", () => {
    expect(toCsv([[null, undefined, 1]])).toBe(",,1");
  });
});

describe("buildCurvesCsvRows", () => {
  it("emits a five-column block per run with a title, header and unit row", () => {
    const rows = buildCurvesCsvRows([makeRun("A"), makeRun("B")]);
    expect(rows[0]).toEqual(["A", "", "", "", "", "B", "", "", "", ""]);
    expect(rows[1].slice(0, 5)).toEqual([
      "Time",
      "Temperature",
      "Weight",
      "Weight",
      "Deriv. Weight",
    ]);
    expect(rows[2].slice(0, 5)).toEqual(["min", "°C", "mg", "%", "%/°C"]);
  });

  it("pads the shorter run's block with blanks instead of shifting columns", () => {
    const rows = buildCurvesCsvRows([makeRun("A", 51), makeRun("B", 11)]);
    // 3 header rows + the longer run's 51 points.
    expect(rows).toHaveLength(3 + 51);
    const lastRow = rows[rows.length - 1];
    expect(lastRow[0]).not.toBe("");
    expect(lastRow.slice(5)).toEqual(["", "", "", "", ""]);
  });

  it("starts weight % at 100 for the default first-point normalization", () => {
    const rows = buildCurvesCsvRows([makeRun("A")]);
    expect(rows[3][3]).toBeCloseTo(100, 4);
  });
});

describe("buildSummaryCsvRows", () => {
  it("has one column per metric, plus run/material/file and a step count", () => {
    const metrics = tgaMetrics(DEFAULT_PARAMS.tdThresholds);
    const rows = buildSummaryCsvRows(
      buildSummaryRows([makeRun("A")], [{ id: "m1", name: "Blend", runIds: ["A"] }], metrics),
      metrics,
    );
    expect(rows[0]).toHaveLength(3 + metrics.length + 1);
    expect(rows[0][0]).toBe("Run");
    expect(rows[1][1]).toBe("Blend");
  });

  it("writes a blank rather than NaN for a metric the run has no value for", () => {
    const metrics = tgaMetrics([99]);
    const rows = buildSummaryCsvRows(buildSummaryRows([makeRun("A")], [], metrics), metrics);
    expect(rows[1][3]).toBe("");
  });
});

describe("buildStepsCsvRows", () => {
  it("always emits a header row, even with no steps at all", () => {
    const rows = buildStepsCsvRows([]);
    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toBe("Run");
  });

  it("emits one row per detected step, tagged with the run's label", () => {
    const run = makeRun("A");
    const rows = buildStepsCsvRows([run]);
    expect(rows).toHaveLength(1 + run.analysis.steps.length);
    if (run.analysis.steps.length > 0) expect(rows[1][0]).toBe("A");
  });
});

describe("tgaproj round trip", () => {
  const state: TgaState = {
    files: [{ id: "f1", fileName: "A.txt", runCount: 1, warnings: [] }],
    runs: [makeRun("A")],
    materials: [{ id: "m1", name: "Blend", runIds: ["A"] }],
    params: { ...DEFAULT_PARAMS, dtgWindow: 31 },
    blankRunId: null,
  };

  it("restores the curves as Float64Arrays with identical values", () => {
    const restored = deserializeTgaProject(serializeTgaProject(state, null));
    const before = state.runs[0];
    const after = restored.state.runs[0];
    expect(after.tempC).toBeInstanceOf(Float64Array);
    expect(after.tempC.length).toBe(before.tempC.length);
    expect(after.tempC[0]).toBeCloseTo(before.tempC[0], 10);
    expect(after.weightMg[10]).toBeCloseTo(before.weightMg[10], 10);
  });

  it("restores the params, materials and metadata", () => {
    const restored = deserializeTgaProject(serializeTgaProject(state, null));
    expect(restored.state.params.dtgWindow).toBe(31);
    expect(restored.state.materials[0].name).toBe("Blend");
    expect(restored.state.runs[0].meta.instrument).toBe("TA Q50");
  });

  it("does not carry the derived analysis into the file", () => {
    // The store hands out TgaRunAnalyzed; serializing that wholesale would
    // double the file size with numbers that are recomputed on load anyway.
    const text = serializeTgaProject(state, null);
    expect(text).not.toContain('"analysis"');
  });

  it("rejects a file that isn't a TGA project", () => {
    expect(() => deserializeTgaProject("{}")).toThrow(/not a tga project/i);
    expect(() => deserializeTgaProject("not json")).toThrow(/unreadable json/i);
  });
});
