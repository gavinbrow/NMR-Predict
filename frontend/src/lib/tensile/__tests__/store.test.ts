import { describe, expect, it } from "vitest";
import {
  buildFromParsed,
  INITIAL_STATE,
  materialNameFromFile,
  reducer,
  type TensileState,
} from "../store-core";
import { extractRun } from "../compute";
import type { ParsedWorkbook, RawRun } from "../types";

function run(label: string, sheet: string): RawRun {
  // A monotonic-ish curve good enough to compute properties from.
  const strain: number[] = [];
  const stress: number[] = [];
  for (let i = 0; i <= 50; i += 1) {
    const e = (i / 50) * 5;
    strain.push(e);
    stress.push(40 * (e / 2) * Math.exp(1 - e / 2));
  }
  return {
    sheet,
    label,
    strainCol: 0,
    stressCol: 1,
    firstRow: 4,
    lastRow: 54,
    strain,
    stress,
    strainIsPercent: true,
  };
}

function workbook(fileName: string, labels: string[]): ParsedWorkbook {
  return {
    fileName,
    runs: labels.map((l) => run(l, l)),
    skippedSheets: ["Parameters", "Results"],
    detection: "header",
    strainUnit: "%",
  };
}

/** Apply a sequence of actions to the initial state. */
function applyAll(actions: Parameters<typeof reducer>[1][]): TensileState {
  return actions.reduce((s, a) => reducer(s, a), INITIAL_STATE);
}

function addFileActions(wb: ParsedWorkbook) {
  const { file, specimens, material } = buildFromParsed(wb);
  return { action: { type: "ADD_FILE", file, specimens, material } as const, specimens, material };
}

describe("materialNameFromFile", () => {
  it("strips the extension and a trailing date", () => {
    expect(materialNameFromFile("tit2-1_DCPD_PETMP_4-29-26.xlsx")).toBe("tit2-1_DCPD_PETMP");
    expect(materialNameFromFile("sampleA.xlsx")).toBe("sampleA");
    expect(materialNameFromFile("run_2024-01-02.xlsx")).toBe("run");
  });
});

describe("ADD_FILE / default grouping", () => {
  it("adds a file with one material holding all its runs", () => {
    const { action } = addFileActions(workbook("foo_1-2-3.xlsx", ["Specimen 1", "Specimen 2"]));
    const state = reducer(INITIAL_STATE, action);
    expect(state.files).toHaveLength(1);
    expect(state.specimens).toHaveLength(2);
    expect(state.materials).toHaveLength(1);
    expect(state.materials[0].name).toBe("foo");
    expect(state.materials[0].specimenIds).toEqual(state.specimens.map((s) => s.id));
  });

  it("adds no material for a file with zero detected runs", () => {
    const { action } = addFileActions({
      fileName: "empty.xlsx",
      runs: [],
      skippedSheets: [],
      detection: "none",
      strainUnit: "n/a",
    });
    const state = reducer(INITIAL_STATE, action);
    expect(state.files).toHaveLength(1);
    expect(state.materials).toHaveLength(0);
  });
});

describe("REMOVE_FILE", () => {
  it("removes the file, its specimens, and prunes its material", () => {
    const a = addFileActions(workbook("a.xlsx", ["s1", "s2"]));
    const b = addFileActions(workbook("b.xlsx", ["s3"]));
    let state = applyAll([a.action, b.action]);
    expect(state.materials).toHaveLength(2);

    state = reducer(state, { type: "REMOVE_FILE", fileId: a.action.file.id });
    expect(state.files).toHaveLength(1);
    expect(state.specimens).toHaveLength(1);
    expect(state.materials).toHaveLength(1); // a's now-empty material is dropped
    expect(state.materials[0].name).toBe("b");
  });
});

describe("exclude / move / merge / split", () => {
  it("SET_EXCLUDED flips the flag", () => {
    const a = addFileActions(workbook("a.xlsx", ["s1", "s2"]));
    let state = reducer(INITIAL_STATE, a.action);
    const id = state.specimens[0].id;
    state = reducer(state, { type: "SET_EXCLUDED", specimenId: id, excluded: true });
    expect(state.specimens.find((s) => s.id === id)?.excluded).toBe(true);
  });

  it("MOVE_SPECIMEN relocates a specimen and drops an emptied material", () => {
    const a = addFileActions(workbook("a.xlsx", ["s1"]));
    const b = addFileActions(workbook("b.xlsx", ["s2"]));
    let state = applyAll([a.action, b.action]);
    const matA = state.materials[0].id;
    const matB = state.materials[1].id;
    const specInA = state.materials[0].specimenIds[0];
    state = reducer(state, { type: "MOVE_SPECIMEN", specimenId: specInA, toMaterialId: matB });
    // material A is now empty → dropped; B has both.
    expect(state.materials.find((m) => m.id === matA)).toBeUndefined();
    expect(state.materials.find((m) => m.id === matB)?.specimenIds).toHaveLength(2);
  });

  it("MERGE_MATERIALS folds source into target", () => {
    const a = addFileActions(workbook("a.xlsx", ["s1", "s2"]));
    const b = addFileActions(workbook("b.xlsx", ["s3"]));
    let state = applyAll([a.action, b.action]);
    const [matA, matB] = state.materials.map((m) => m.id);
    state = reducer(state, { type: "MERGE_MATERIALS", sourceId: matB, targetId: matA });
    expect(state.materials).toHaveLength(1);
    expect(state.materials[0].specimenIds).toHaveLength(3);
  });

  it("CREATE_MATERIAL_FROM splits specimens into a new material", () => {
    const a = addFileActions(workbook("a.xlsx", ["s1", "s2", "s3"]));
    let state = reducer(INITIAL_STATE, a.action);
    const move = state.specimens.slice(0, 2).map((s) => s.id);
    state = reducer(state, { type: "CREATE_MATERIAL_FROM", specimenIds: move, name: "Split" });
    expect(state.materials).toHaveLength(2);
    const split = state.materials.find((m) => m.name === "Split");
    expect(split?.specimenIds).toEqual(move);
    // The original material keeps only the remaining specimen.
    expect(state.materials.find((m) => m.name === "a")?.specimenIds).toHaveLength(1);
  });
});

describe("selection stays consistent when materials disappear", () => {
  it("REMOVE_FILE drops a selected material backed only by the removed file", () => {
    const a = addFileActions(workbook("a.xlsx", ["s1"]));
    const b = addFileActions(workbook("b.xlsx", ["s2"]));
    let state = applyAll([a.action, b.action]);
    const matA = state.materials[0].id;
    // Select material A, then remove the file that backs it.
    state = reducer(state, { type: "TOGGLE_MATERIAL_SELECTED", id: matA });
    expect(state.selection.materialIds).toContain(matA);
    state = reducer(state, { type: "REMOVE_FILE", fileId: a.action.file.id });
    // A no longer exists, so it must not linger in the selection.
    expect(state.materials.some((m) => m.id === matA)).toBe(false);
    expect(state.selection.materialIds).not.toContain(matA);
  });

  it("DELETE_MATERIAL drops the deleted material from the selection", () => {
    const a = addFileActions(workbook("a.xlsx", ["s1", "s2"]));
    let state = reducer(INITIAL_STATE, a.action);
    const matA = state.materials[0].id;
    state = reducer(state, { type: "TOGGLE_MATERIAL_SELECTED", id: matA });
    state = reducer(state, { type: "DELETE_MATERIAL", id: matA });
    expect(state.selection.materialIds).not.toContain(matA);
  });

  it("MERGE_MATERIALS drops the merged-away source from the selection", () => {
    const a = addFileActions(workbook("a.xlsx", ["s1"]));
    const b = addFileActions(workbook("b.xlsx", ["s2"]));
    let state = applyAll([a.action, b.action]);
    const [matA, matB] = state.materials.map((m) => m.id);
    state = reducer(state, { type: "TOGGLE_MATERIAL_SELECTED", id: matB });
    state = reducer(state, { type: "MERGE_MATERIALS", sourceId: matB, targetId: matA });
    expect(state.selection.materialIds).not.toContain(matB);
  });
});

describe("derived recompute on param change", () => {
  it("changing the modulus window changes the computed modulus", () => {
    const wb = workbook("a.xlsx", ["s1"]);
    const r = wb.runs[0];
    const wide = extractRun(r.strain, r.stress, true, {
      ...INITIAL_STATE.params,
      eLo: 0.05,
      eHi: 0.25,
    });
    const narrow = extractRun(r.strain, r.stress, true, {
      ...INITIAL_STATE.params,
      eLo: 0.5,
      eHi: 1.5,
    });
    expect(Number.isFinite(wide.E_MPa)).toBe(true);
    expect(Number.isFinite(narrow.E_MPa)).toBe(true);
    expect(wide.E_MPa).not.toBeCloseTo(narrow.E_MPa, 1);
  });

  it("strain-unit override forces the interpretation", () => {
    const r = run("s1", "s1");
    // Treat the (already-percent) numbers as mm/mm → ×100 → 100× larger strains.
    const asFraction = extractRun(r.strain, r.stress, false, INITIAL_STATE.params);
    const asPercent = extractRun(r.strain, r.stress, true, INITIAL_STATE.params);
    expect(asFraction.elong_break).toBeCloseTo(asPercent.elong_break * 100, 3);
  });
});
