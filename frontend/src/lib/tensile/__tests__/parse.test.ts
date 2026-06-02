import { describe, expect, it } from "vitest";
import { parseSheets, readMachineResults, type Row, type SheetGrid } from "../parse";

/** Build `n` rising stress–strain rows: strain ramps up, stress is a parabola. */
function curveRows(n = 12, strainScale = 0.05): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < n; i += 1) {
    const strain = +(i * strainScale).toFixed(4);
    const stress = +(i * (n - i)).toFixed(4); // up then down → a real UTS
    rows.push([strain, stress]);
  }
  return rows;
}

/** A labelled Specimen sheet: header row, units row, then data. */
function specimenSheet(name: string, strainUnit = "%"): SheetGrid {
  return {
    name,
    rows: [["Elongation", "Standard stress"], [strainUnit, "MPa"], ...curveRows()],
  };
}

describe("parseSheets — labelled header path", () => {
  it("detects a Specimen sheet and reads percent strain", () => {
    const wb = parseSheets([specimenSheet("Specimen 1")], "file.xlsx");
    expect(wb.runs).toHaveLength(1);
    expect(wb.detection).toBe("header");
    expect(wb.strainUnit).toBe("%");
    const run = wb.runs[0];
    expect(run.sheet).toBe("Specimen 1");
    expect(run.label).toBe("Specimen 1"); // single run → sheet name
    expect(run.strainIsPercent).toBe(true);
    expect(run.strain).toHaveLength(12);
    expect(run.strainCol).toBe(0);
    expect(run.stressCol).toBe(1);
    expect(run.firstRow).toBe(3); // header=1, units=2, first data=3 (1-based)
  });

  it("pairs each strain column with the nearest stress column to its right", () => {
    const grid: SheetGrid = {
      name: "Specimen 1",
      rows: [
        ["time", "Strain", "junk", "Stress"],
        ["s", "%", "", "MPa"],
        ...curveRows().map((r) => [0, r[0], "x", r[1]] as Row),
      ],
    };
    const wb = parseSheets([grid], "file.xlsx");
    expect(wb.runs).toHaveLength(1);
    expect(wb.runs[0].strainCol).toBe(1);
    expect(wb.runs[0].stressCol).toBe(3);
  });

  it("reads mm/mm units as a fraction, not percent", () => {
    const wb = parseSheets([specimenSheet("Specimen 1", "mm/mm")], "file.xlsx");
    expect(wb.runs[0].strainIsPercent).toBe(false);
    expect(wb.strainUnit).toBe("mm/mm");
  });

  it("requires at least 10 points for a run to count", () => {
    const grid: SheetGrid = {
      name: "Specimen 1",
      rows: [["Strain", "Stress"], ["%", "MPa"], ...curveRows(9)],
    };
    const wb = parseSheets([grid], "file.xlsx");
    expect(wb.runs).toHaveLength(0);
    expect(wb.detection).toBe("none");
  });
});

describe("parseSheets — skip list & multi-sheet", () => {
  it("skips instrument metadata sheets and keeps only specimen sheets", () => {
    const wb = parseSheets(
      [
        { name: "Parameters", rows: [["k", "v"]] },
        specimenSheet("Specimen 1"),
        specimenSheet("Specimen 2"),
        { name: "Results", rows: [["Specimen", "Et"]] },
        { name: "Comb. Results", rows: [["x"]] },
      ],
      "file.xlsx",
    );
    expect(wb.runs).toHaveLength(2);
    expect(wb.skippedSheets).toEqual(["Parameters", "Results", "Comb. Results"]);
    expect(wb.runs.map((r) => r.sheet)).toEqual(["Specimen 1", "Specimen 2"]);
  });

  it("reports no runs (detection none) for an all-metadata workbook", () => {
    const wb = parseSheets([{ name: "Results", rows: [["Specimen", "Et"]] }], "file.xlsx");
    expect(wb.runs).toHaveLength(0);
    expect(wb.detection).toBe("none");
    expect(wb.strainUnit).toBe("n/a");
  });
});

describe("parseSheets — legacy numeric fallback", () => {
  it("detects an unlabelled side-by-side [strain, stress] pair", () => {
    const grid: SheetGrid = { name: "Sheet1", rows: curveRows() };
    const wb = parseSheets([grid], "legacy.xlsx");
    expect(wb.detection).toBe("numeric");
    expect(wb.runs).toHaveLength(1);
    // strain (steadily increasing) is column 0, stress (rises then falls) column 1.
    expect(wb.runs[0].strainCol).toBe(0);
    expect(wb.runs[0].stressCol).toBe(1);
  });

  it("uses monotonicity to pick the strain column even when columns are swapped", () => {
    const swapped: Row[] = curveRows().map(([strain, stress]) => [stress, strain] as Row);
    const wb = parseSheets([{ name: "Sheet1", rows: swapped }], "legacy.xlsx");
    expect(wb.runs).toHaveLength(1);
    // The more monotonically-increasing column (now col 1) is identified as strain.
    expect(wb.runs[0].strainCol).toBe(1);
    expect(wb.runs[0].stressCol).toBe(0);
  });

  it("labels multiple runs on one sheet as '<sheet> – run k'", () => {
    // Two adjacent [strain, stress] pairs in one consecutive numeric group.
    const rows: Row[] = curveRows().map(([s, st]) => [s, st, s, st] as Row);
    const wb = parseSheets([{ name: "Sheet1", rows }], "legacy.xlsx");
    expect(wb.runs).toHaveLength(2);
    expect(wb.runs.map((r) => r.label)).toEqual(["Sheet1 – run 1", "Sheet1 – run 2"]);
  });
});

describe("readMachineResults — instrument Results sheet (Phase 8)", () => {
  /** A `Results` sheet: header, units row, then one row per specimen. */
  function resultsSheet(): SheetGrid {
    return {
      name: "Results",
      rows: [
        ["", "Et", "sM", "eM", "sB", "eB"],
        ["", "MPa", "MPa", "%", "MPa", "%"],
        ["Specimen 1", 300, 50, 2.1, 30, 8],
        ["Specimen 2", 280, 48, 1.9, 28, 7.5],
        ["", null, null, null, null, null], // trailing/blank rows ignored
      ],
    };
  }

  it("reads per-specimen values keyed by label", () => {
    const m = readMachineResults([resultsSheet()]);
    expect(Object.keys(m)).toEqual(["Specimen 1", "Specimen 2"]);
    expect(m["Specimen 1"]).toEqual({ Et: 300, sM: 50, eM: 2.1, sB: 30, eB: 8 });
    expect(m["Specimen 2"].Et).toBe(280);
  });

  it("returns {} when there is no Results sheet or no known columns", () => {
    expect(readMachineResults([{ name: "Specimen 1", rows: [["Elongation", "Stress"]] }])).toEqual({});
    expect(
      readMachineResults([{ name: "Results", rows: [["x", "y"], ["a", "b"], ["Specimen 1", 1]] }]),
    ).toEqual({});
  });

  it("is surfaced on the parsed workbook alongside detected runs", () => {
    const wb = parseSheets([specimenSheet("Specimen 1"), resultsSheet()], "file.xlsx");
    expect(wb.skippedSheets).toContain("Results");
    expect(wb.machine?.["Specimen 1"]?.Et).toBe(300);
  });
});
