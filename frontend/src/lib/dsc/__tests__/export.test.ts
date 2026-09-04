// Unit tests for the DSC export builders. Everything under test here is pure:
// the CSV row builders and the `.dscproj` round trip. The download plumbing
// and the ExcelJS/jsPDF writers are exercised by hand (and by the Excel chart
// tests next door), not here. Mirrors `lib/tga/__tests__/export.test.ts`.

import { describe, expect, it } from "vitest";
import {
  buildCurvesCsvRows,
  buildTransitionsCsvRows,
  deserializeDscProject,
  serializeDscProject,
  toCsv,
} from "../export";
import { computeDscAnalysis } from "../compute";
import { DEFAULT_PARAMS, type DscMetadata, type DscRun, type DscSegment } from "../types";
import type { DscState } from "../store-core";
import type { DscRunAnalyzed } from "../store";

/** Build a single-segment (heating) run with a small endothermic melt near
 *  150 °C, plus one pre-placed "melt" feature so `buildTransitionsCsvRows`
 *  has something real to report. `sampleMassMg` is 1, so the raw mW array
 *  numerically equals W/g — the same trick `compute.test.ts` uses to keep
 *  the arithmetic transparent. */
function makeRun(id: string, points = 41): DscRunAnalyzed {
  const rate = 10;
  const t0 = 50;
  const t1 = 250;
  const dTc = (t1 - t0) / (points - 1);
  const dtMin = dTc / rate;
  const timeMin = new Float64Array(points);
  const tempC = new Float64Array(points);
  const heatFlowMw = new Float64Array(points);
  for (let i = 0; i < points; i += 1) {
    const T = t0 + i * dTc;
    timeMin[i] = i * dtMin;
    tempC[i] = T;
    heatFlowMw[i] = 0.01 * T - 0.4 * Math.exp(-((T - 150) ** 2) / (2 * 8 ** 2));
  }
  const segment: DscSegment = {
    id: `${id}:seg0`,
    label: `Ramp ${rate} °C/min to ${t1} °C`,
    kind: "heat",
    rateCPerMin: rate,
    ordinal: 1,
    cycle: 1,
    start: 0,
    end: points,
    tStartC: tempC[0],
    tEndC: tempC[points - 1],
    timeStartMin: timeMin[0],
    timeEndMin: timeMin[points - 1],
  };
  const meta: DscMetadata = {
    instrument: "DSC25",
    operator: "Test",
    sampleName: id,
    sampleMassMg: 1,
    panMassMg: 0,
    pan: "Tzero Aluminum Hermetic",
    methodSteps: [segment.label],
    runDate: "9/2/2026",
    gases: "Nitrogen, 50 mL/min",
    cooler: "RCS 90",
    cellConstant: "-23.6 mW/°C",
    sampleInterval: "0.1 s/pt",
    exoDirection: "up",
  };
  const run: DscRun = {
    label: id,
    meta,
    segments: [segment],
    timeMin,
    tempC,
    heatFlowMw,
    id,
    fileId: `${id}:file`,
    fileName: `${id}.tri`,
    color: "#2563eb",
    scale: 1,
    offset: 0,
    visible: true,
    materialId: "m1",
    activeSegmentId: segment.id,
    massOverrideMg: null,
    polymerFraction: 1,
    referenceId: null,
    features: [
      {
        id: `${segment.id}:melt1`,
        segmentId: segment.id,
        kind: "melt",
        label: "Melt 1",
        window: [130, 170],
        baseline: null,
        baselineMode: "linear",
        auto: true,
        visible: true,
        manualMidpointC: null,
      },
    ],
  };
  // Attached only to satisfy `DscRunAnalyzed`'s type — the CSV builders under
  // test recompute everything they need straight from the raw arrays with
  // whatever `params` the caller passes them, never from this cached value.
  return { ...run, analysis: computeDscAnalysis(run, DEFAULT_PARAMS) };
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
  it("emits a five-column block per run x segment with a title, header and unit row", () => {
    const rows = buildCurvesCsvRows([makeRun("A"), makeRun("B")], DEFAULT_PARAMS);
    expect(rows[0]).toEqual([
      "A — Heat 1",
      "",
      "",
      "",
      "",
      "B — Heat 1",
      "",
      "",
      "",
      "",
    ]);
    expect(rows[1].slice(0, 5)).toEqual(["Time", "Temperature", "Heat flow", "Heat flow", "Deriv. heat flow"]);
    expect(rows[2].slice(0, 5)).toEqual(["min", "°C", "mW", "W/g", "W/g·°C"]);
  });

  it("pads the shorter run's block with blanks instead of shifting columns", () => {
    const rows = buildCurvesCsvRows([makeRun("A", 41), makeRun("B", 11)], DEFAULT_PARAMS);
    // 3 header rows + the longer run's 41 points.
    expect(rows).toHaveLength(3 + 41);
    const lastRow = rows[rows.length - 1];
    expect(lastRow[0]).not.toBe("");
    expect(lastRow.slice(5)).toEqual(["", "", "", "", ""]);
  });

  it("reads the heat-flow and derivative units off params.normMode rather than hardcoding them", () => {
    // Pins the bug the plan calls out in TGA's `buildCurvesCsvRows`, which
    // hardcodes "%/°C" and ignores `params.dtgUnit`. DSC's analogous switch
    // is `normMode`: "wattsPerGram" prints "W/g" / "W/g·°C", "raw" prints
    // "mW" / "mW/°C" for the same two columns.
    const normalized = buildCurvesCsvRows([makeRun("A")], { ...DEFAULT_PARAMS, normMode: "wattsPerGram" });
    const raw = buildCurvesCsvRows([makeRun("A")], { ...DEFAULT_PARAMS, normMode: "raw" });
    expect(normalized[2].slice(3, 5)).toEqual(["W/g", "W/g·°C"]);
    expect(raw[2].slice(3, 5)).toEqual(["mW", "mW/°C"]);
  });

  it("skips a run with no segments rather than emitting an empty block", () => {
    const empty = makeRun("A");
    empty.segments = [];
    const rows = buildCurvesCsvRows([empty], DEFAULT_PARAMS);
    expect(rows[0]).toEqual([]);
  });
});

describe("buildTransitionsCsvRows", () => {
  it("emits one row per feature, across every segment of the run", () => {
    const run = makeRun("A");
    const rows = buildTransitionsCsvRows([run], DEFAULT_PARAMS);
    expect(rows[0][0]).toBe("Run");
    expect(rows).toHaveLength(1 + run.features.length);
    const row = rows[1];
    expect(row[0]).toBe("A");
    expect(row[1]).toBe("Heat 1");
    expect(row[2]).toBe("melt");
    // The melt peak sits near 150 °C — onset/peak/endset should all land
    // inside the feature's [130, 170] window, and the endotherm's ΔH should
    // be negative (exo-up convention).
    expect(row[7]).toBeGreaterThan(130);
    expect(row[7]).toBeLessThan(170);
    expect(row[9]).toBeLessThan(0);
  });

  it("always emits a header row, even with no features at all", () => {
    const run = makeRun("A");
    run.features = [];
    const rows = buildTransitionsCsvRows([run], DEFAULT_PARAMS);
    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toBe("Run");
  });
});

describe("dscproj round trip", () => {
  const runA = makeRun("A");
  const state: DscState = {
    files: [{ id: "f1", fileName: "A.tri", runCount: 1, warnings: [] }],
    runs: [runA],
    materials: [{ id: "m1", name: "Blend", runIds: ["A"] }],
    params: { ...DEFAULT_PARAMS, smoothWindow: 31 },
    references: [],
  };

  it("restores the curves as Float64Arrays with identical values", () => {
    const restored = deserializeDscProject(serializeDscProject(state, null));
    const before = state.runs[0];
    const after = restored.state.runs[0];
    expect(after.tempC).toBeInstanceOf(Float64Array);
    expect(after.tempC.length).toBe(before.tempC.length);
    expect(after.tempC[0]).toBeCloseTo(before.tempC[0], 10);
    expect(after.heatFlowMw[10]).toBeCloseTo(before.heatFlowMw[10], 10);
  });

  it("restores the params, materials, segments and features", () => {
    const restored = deserializeDscProject(serializeDscProject(state, null));
    expect(restored.state.params.smoothWindow).toBe(31);
    expect(restored.state.materials[0].name).toBe("Blend");
    expect(restored.state.runs[0].meta.instrument).toBe("DSC25");
    expect(restored.state.runs[0].segments).toHaveLength(1);
    expect(restored.state.runs[0].features).toHaveLength(1);
  });

  it("does not carry the derived analysis into the file", () => {
    // The store hands out DscRunAnalyzed in places; serializing that
    // wholesale would double the file size with numbers that are recomputed
    // on load anyway, and `serializeRun` picks fields explicitly to avoid it.
    const text = serializeDscProject(state, null);
    expect(text).not.toContain('"analysis"');
  });

  it("preserves a hand-set Tg (manualMidpointC) through the round trip", () => {
    // `serializeRun` picks fields explicitly rather than spreading (see the
    // "does not carry the derived analysis" test above) — but `features` is
    // passed through as a whole array, so a NEW `DscFeature` field survives
    // automatically as long as the runtime object actually carries it. This
    // pins that a hand-set Tg isn't silently dropped by a `.dscproj` save/
    // load, which a field-by-field feature serializer (if one existed) could
    // easily miss.
    const runWithManualTg = makeRun("B");
    runWithManualTg.features = [
      {
        id: "B:seg0:glass1",
        segmentId: runWithManualTg.segments[0].id,
        kind: "glass",
        label: "Tg",
        window: [60, 100],
        baseline: null,
        baselineMode: "linear",
        auto: false,
        visible: true,
        manualMidpointC: 65.4,
      },
    ];
    const stateWithGlass: DscState = { ...state, runs: [runWithManualTg] };
    const restored = deserializeDscProject(serializeDscProject(stateWithGlass, null));
    expect(restored.state.runs[0].features[0].manualMidpointC).toBe(65.4);
  });

  it("rejects a file that isn't a DSC project", () => {
    expect(() => deserializeDscProject("{}")).toThrow(/not a dsc project/i);
    expect(() => deserializeDscProject("not json")).toThrow(/unreadable json/i);
  });
});
