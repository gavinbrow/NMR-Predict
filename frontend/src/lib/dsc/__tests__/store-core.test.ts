// Unit tests for the DSC store reducer: the raw state shape, action
// handling, and the parsed-file → store-record builder (§WP2 of the plan).
// New relative to TGA, which has no reducer test — these pin the invariants
// later work packages (features, materials, the .dscproj round trip) depend
// on. Plain vitest, no mocking, behavioural `it(...)` sentences.

import { describe, expect, it } from "vitest";
import { buildSegments } from "../segments";
import { buildFromParsed, INITIAL_STATE, reducer, type DscState } from "../store-core";
import { DEFAULT_PARAMS } from "../types";
import type {
  DscFeature,
  DscMetadata,
  DscReference,
  DscRun,
  ParsedDscFile,
  ParsedDscRun,
} from "../types";

function makeMeta(overrides: Partial<DscMetadata> = {}): DscMetadata {
  return {
    instrument: "DSC25",
    operator: "Josh K",
    sampleName: "DAC1",
    sampleMassMg: 4.4,
    panMassMg: 0,
    pan: "Tzero Aluminum Hermetic",
    methodSteps: [],
    runDate: "9/2/2026",
    gases: "Nitrogen, 50 mL/min",
    cooler: "RCS 90",
    cellConstant: "-23.63117 mW/°C",
    sampleInterval: "0.1 s/pt",
    exoDirection: "up",
    ...overrides,
  };
}

/** A tiny realistic heat/cool/heat/cool run (four 10-minute, 100 °C legs),
 *  built through the real `buildSegments` so `buildFromParsed`'s
 *  `activeSegmentId` resolution is exercised against the real
 *  `defaultSegmentId` path rather than a hand-picked id. */
function makeParsedRun(label = "DAC1"): ParsedDscRun {
  const tempC = Float64Array.from([0, 100, 100, 0, 0, 100, 100, 0]);
  const timeMin = Float64Array.from([0, 10, 10, 20, 20, 30, 30, 40]);
  const heatFlowMw = Float64Array.from([0, 1, 1, 0, 0, 1, 1, 0]);
  const segments = buildSegments("placeholder", tempC, timeMin, [
    { start: 0, end: 2, label: "heat1" },
    { start: 2, end: 4, label: "cool1" },
    { start: 4, end: 6, label: "heat2" },
    { start: 6, end: 8, label: "cool2" },
  ]);
  return { label, meta: makeMeta(), segments, timeMin, tempC, heatFlowMw };
}

function makeParsedFile(fileName = "DAC1.tri", runs = [makeParsedRun()]): ParsedDscFile {
  return { fileName, runs, warnings: [] };
}

/** A fully-formed `DscRun` for reducer tests that don't need to go through
 *  `buildFromParsed`. */
function makeRun(id: string, overrides: Partial<DscRun> = {}): DscRun {
  const parsed = makeParsedRun();
  return {
    ...parsed,
    id,
    fileId: `${id}-file`,
    fileName: `${id}.tri`,
    color: "#2563eb",
    scale: 1,
    offset: 0,
    visible: true,
    materialId: null,
    activeSegmentId: parsed.segments[2].id,
    massOverrideMg: null,
    polymerFraction: 1,
    referenceId: null,
    features: [],
    ...overrides,
  };
}

function makeFeature(overrides: Partial<DscFeature> = {}): DscFeature {
  return {
    id: "feat1",
    segmentId: "placeholder:seg2",
    kind: "glass",
    label: "Tg",
    window: [50, 80],
    baseline: null,
    baselineMode: "linear",
    auto: true,
    visible: true,
    manualMidpointC: null,
    ...overrides,
  };
}

function stateWith(overrides: Partial<DscState> = {}): DscState {
  return { ...INITIAL_STATE, ...overrides };
}

// --- LOAD_STATE --------------------------------------------------------

describe("reducer / LOAD_STATE", () => {
  it("re-merges saved params onto DEFAULT_PARAMS so a project saved before a new param existed still loads", () => {
    // Bug this pins: a naive `params: action.state.params` assignment would
    // leave `minPeakEnthalpy` (or any param added after the file was saved)
    // as `undefined`, breaking every downstream numeric comparison against it.
    const saved = {
      ...INITIAL_STATE,
      params: { smoothWindow: 15, exoUp: false },
    } as unknown as DscState;
    const next = reducer(INITIAL_STATE, { type: "LOAD_STATE", state: saved });
    expect(next.params.smoothWindow).toBe(15); // saved value kept
    expect(next.params.exoUp).toBe(false); // saved value kept
    expect(next.params.minPeakEnthalpy).toBe(DEFAULT_PARAMS.minPeakEnthalpy); // filled in
    expect(next.params.normMode).toBe(DEFAULT_PARAMS.normMode); // filled in
    expect(next.params.autoDetect).toBe(DEFAULT_PARAMS.autoDetect); // filled in
  });
});

// --- CLEAR_ALL -----------------------------------------------------------

describe("reducer / CLEAR_ALL", () => {
  it("wipes files, runs, and materials but keeps params and the reference library", () => {
    const refs: DscReference[] = [
      { id: "custom", name: "My polymer", enthalpy100JPerG: 100, builtIn: false },
    ];
    const run = makeRun("run1");
    const state = stateWith({
      files: [{ id: "file1", fileName: "DAC1.tri", runCount: 1, warnings: [] }],
      runs: [run],
      materials: [{ id: "mat1", name: "DAC1", runIds: ["run1"] }],
      params: { ...DEFAULT_PARAMS, exoUp: false },
      references: refs,
    });
    const next = reducer(state, { type: "CLEAR_ALL" });
    expect(next.files).toEqual([]);
    expect(next.runs).toEqual([]);
    expect(next.materials).toEqual([]);
    expect(next.params).toEqual(state.params); // preserved, not reset to DEFAULT_PARAMS
    expect(next.references).toBe(refs); // preserved, same reference library
  });
});

// --- material pruning -------------------------------------------------

describe("reducer / REMOVE_RUN", () => {
  it("drops the run from its material and removes the material once it's empty", () => {
    const run = makeRun("run1", { materialId: "mat1" });
    const state = stateWith({
      runs: [run],
      materials: [{ id: "mat1", name: "DAC1", runIds: ["run1"] }],
    });
    const next = reducer(state, { type: "REMOVE_RUN", runId: "run1" });
    expect(next.runs).toEqual([]);
    expect(next.materials).toEqual([]); // pruned, not left as an empty group
  });

  it("keeps a material that still has other runs after one of them is removed", () => {
    const run1 = makeRun("run1", { materialId: "mat1" });
    const run2 = makeRun("run2", { materialId: "mat1" });
    const state = stateWith({
      runs: [run1, run2],
      materials: [{ id: "mat1", name: "DAC", runIds: ["run1", "run2"] }],
    });
    const next = reducer(state, { type: "REMOVE_RUN", runId: "run1" });
    expect(next.runs.map((r) => r.id)).toEqual(["run2"]);
    expect(next.materials).toEqual([{ id: "mat1", name: "DAC", runIds: ["run2"] }]);
  });
});

describe("reducer / REMOVE_FILE", () => {
  it("removes every run from that file and prunes materials left empty", () => {
    const run1 = makeRun("run1", { fileId: "file1", materialId: "mat1" });
    const run2 = makeRun("run2", { fileId: "file2", materialId: "mat2" });
    const state = stateWith({
      files: [
        { id: "file1", fileName: "DAC1.tri", runCount: 1, warnings: [] },
        { id: "file2", fileName: "DAC2.tri", runCount: 1, warnings: [] },
      ],
      runs: [run1, run2],
      materials: [
        { id: "mat1", name: "DAC1", runIds: ["run1"] },
        { id: "mat2", name: "DAC2", runIds: ["run2"] },
      ],
    });
    const next = reducer(state, { type: "REMOVE_FILE", fileId: "file1" });
    expect(next.files.map((f) => f.id)).toEqual(["file2"]);
    expect(next.runs.map((r) => r.id)).toEqual(["run2"]);
    expect(next.materials).toEqual([{ id: "mat2", name: "DAC2", runIds: ["run2"] }]); // mat1 pruned
  });
});

// --- UPDATE_FEATURE ------------------------------------------------------

describe("reducer / UPDATE_FEATURE", () => {
  it("clears `auto` on the touched feature so a hand-placed window survives a later parameter change", () => {
    // Bug this pins: if UPDATE_FEATURE forgot to clear `auto`,
    // autoDetectFeatures would silently overwrite the user's dragged window
    // the next time smoothWindow/minPeakEnthalpy/etc. changed.
    const feature = makeFeature({ id: "feat1", auto: true, window: [50, 80] });
    const run = makeRun("run1", { features: [feature] });
    const state = stateWith({ runs: [run] });
    const next = reducer(state, {
      type: "UPDATE_FEATURE",
      runId: "run1",
      featureId: "feat1",
      patch: { window: [55, 85] },
    });
    const updated = next.runs[0].features[0];
    expect(updated.window).toEqual([55, 85]);
    expect(updated.auto).toBe(false);
  });

  it("forces auto false even if the caller's patch tries to keep it true", () => {
    const feature = makeFeature({ id: "feat1", auto: true });
    const run = makeRun("run1", { features: [feature] });
    const state = stateWith({ runs: [run] });
    const next = reducer(state, {
      type: "UPDATE_FEATURE",
      runId: "run1",
      featureId: "feat1",
      patch: { auto: true, label: "Tg (edited)" },
    });
    expect(next.runs[0].features[0].auto).toBe(false);
  });

  it("leaves other features and other runs untouched", () => {
    const f1 = makeFeature({ id: "feat1", auto: true });
    const f2 = makeFeature({ id: "feat2", auto: true, kind: "melt" });
    const run = makeRun("run1", { features: [f1, f2] });
    const state = stateWith({ runs: [run] });
    const next = reducer(state, {
      type: "UPDATE_FEATURE",
      runId: "run1",
      featureId: "feat1",
      patch: { label: "Tg (edited)" },
    });
    expect(next.runs[0].features[1]).toEqual(f2); // untouched, still auto
  });
});

// --- RESET_FEATURES ------------------------------------------------------

describe("reducer / RESET_FEATURES", () => {
  it("empties a run's feature list so the compute layer re-auto-detects from scratch", () => {
    const feature = makeFeature({ id: "feat1", auto: false }); // even a user-edited one is cleared
    const run = makeRun("run1", { features: [feature] });
    const state = stateWith({ runs: [run] });
    const next = reducer(state, { type: "RESET_FEATURES", runId: "run1" });
    expect(next.runs[0].features).toEqual([]);
  });

  it("leaves other runs' features alone", () => {
    const run1 = makeRun("run1", { features: [makeFeature({ id: "f1" })] });
    const run2 = makeRun("run2", { features: [makeFeature({ id: "f2" })] });
    const state = stateWith({ runs: [run1, run2] });
    const next = reducer(state, { type: "RESET_FEATURES", runId: "run1" });
    expect(next.runs[0].features).toEqual([]);
    expect(next.runs[1].features).toHaveLength(1);
  });
});

// --- buildFromParsed ------------------------------------------------------

describe("buildFromParsed", () => {
  it("sets each new run's activeSegmentId from defaultSegmentId (the 2nd heat)", () => {
    const parsed = makeParsedFile("DAC1.tri");
    const { runs } = buildFromParsed(parsed);
    expect(runs).toHaveLength(1);
    const heat2 = parsed.runs[0].segments.find((s) => s.kind === "heat" && s.ordinal === 2);
    expect(heat2).toBeDefined();
    expect(runs[0].activeSegmentId).toBe(heat2!.id);
  });

  it("groups every run from one file into a single material, named from the file name", () => {
    // Bug this pins: one material PER RUN would split a multi-sample import
    // (e.g. a TRIOS Excel export with several sheets) into several
    // single-run materials, defeating the "merge DAC1/2/3 into one replicate
    // group" workflow the plan calls for — grouping must be per FILE.
    const parsed = makeParsedFile("DAC1.tri", [makeParsedRun("DAC1a"), makeParsedRun("DAC1b")]);
    const { runs, material } = buildFromParsed(parsed);
    expect(runs).toHaveLength(2);
    expect(material).not.toBeNull();
    expect(material!.runIds).toEqual(runs.map((r) => r.id));
    expect(runs.every((r) => r.materialId === material!.id)).toBe(true);
    expect(material!.name).toBe("DAC1");
  });

  it("gives every new run default display/analysis-input state", () => {
    const parsed = makeParsedFile();
    const { runs } = buildFromParsed(parsed);
    const run = runs[0];
    expect(run.scale).toBe(1);
    expect(run.offset).toBe(0);
    expect(run.visible).toBe(true);
    expect(run.massOverrideMg).toBeNull();
    expect(run.polymerFraction).toBe(1);
    expect(run.referenceId).toBeNull();
    expect(run.features).toEqual([]);
  });

  it("returns a null material for a file that produced zero runs", () => {
    const parsed = makeParsedFile("empty.csv", []);
    const { runs, material, file } = buildFromParsed(parsed);
    expect(runs).toEqual([]);
    expect(material).toBeNull();
    expect(file.runCount).toBe(0);
  });
});
