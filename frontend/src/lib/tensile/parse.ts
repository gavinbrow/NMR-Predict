// Excel parsing for tensile exports — a TypeScript port of the detection half of
// `tensile_analyze.py` (`detect_runs`, `_find_header`, `_strain_is_percent`,
// `_detect_runs_numeric`).
//
// The input contract (zwickRoell / Instron, testXpert-style):
//   * each specimen has its OWN worksheet ("Specimen 1", "Specimen 2", …),
//   * that sheet has a header row + a units row, then two data columns:
//         [ Elongation (%) , Standard force / Stress (MPa) ]
//   * helper sheets ("Parameters", "Results", "Statistics", "Comb. Results")
//     hold metadata and are skipped.
//
// It also understands the older side-by-side layout (several runs as adjacent
// [strain, stress] column pairs on one sheet) as a numeric fallback.
//
// The detection logic is written as a pure function over per-sheet cell grids
// (`parseSheets`) so it is unit-testable without binary fixtures; `parseWorkbook`
// is the thin browser entry point that reads the `.xlsx` via SheetJS first.

import * as XLSX from "xlsx";
import type {
  DetectionMethod,
  MachineResults,
  ParsedWorkbook,
  RawRun,
  StrainUnit,
} from "./types";

// --------------------------------------------------------------------------- //
// CONFIG (mirrors the Python CONFIG block, parsing-relevant subset)           //
// --------------------------------------------------------------------------- //

/** Default when a sheet's units row doesn't say (Python `STRAIN_IN_PERCENT`). */
export const STRAIN_IN_PERCENT_DEFAULT = true;

/** A column needs at least this many numbers to count as a data column. */
export const MIN_POINTS_PER_COL = 10;

/** How many rows from the top to scan for a labelled header. */
export const MAX_HEADER_SCAN = 12;

/** Worksheets never treated as raw-curve data (instrument summary tabs). */
export const SKIP_SHEETS = new Set([
  "parameters",
  "results",
  "statistics",
  "comb. results",
  "comb results",
  "combined results",
]);

/** Header-text fragments that mark the strain and stress columns. */
export const STRAIN_PATTERNS = ["elong", "strain", "extension"];
export const STRESS_PATTERNS = ["stress", "force", "load"];

// --------------------------------------------------------------------------- //
// A sheet as a grid of cells. SheetJS gives us exactly this shape.            //
// --------------------------------------------------------------------------- //

export type Cell = string | number | boolean | null | undefined;
export type Row = Cell[];

export interface SheetGrid {
  name: string;
  /** Rows of cells, row 0 = sheet row 1. Ragged rows are allowed. */
  rows: Row[];
}

// --------------------------------------------------------------------------- //
// Small helpers (Python `_txt`, `_is_num`)                                    //
// --------------------------------------------------------------------------- //

/** Normalize a cell to lowercase trimmed text ("" for null/undefined). */
function txt(v: Cell): string {
  return v != null ? String(v).trim().toLowerCase() : "";
}

/** True for a real finite number (booleans are excluded, like the Python). */
function isNum(v: Cell): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function cellAt(row: Row, col: number): Cell {
  return col < row.length ? row[col] : null;
}

// --------------------------------------------------------------------------- //
// Header detection                                                            //
// --------------------------------------------------------------------------- //

interface HeaderHit {
  /** 0-based index of the header row. */
  headerRow: number;
  /** [strainCol, stressCol] pairs, each 0-based. */
  pairs: [number, number][];
}

/**
 * Look in the first `MAX_HEADER_SCAN` rows for a labelled header. Pairs each
 * strain column with the nearest stress column to its right. Returns the first
 * row that yields at least one such pair, or null.
 */
function findHeader(rows: Row[]): HeaderHit | null {
  const scan = Math.min(rows.length, MAX_HEADER_SCAN);
  for (let r = 0; r < scan; r += 1) {
    const labels = rows[r].map(txt);
    const strainCols: number[] = [];
    const stressCols: number[] = [];
    labels.forEach((t, c) => {
      if (STRAIN_PATTERNS.some((p) => t.includes(p))) strainCols.push(c);
      if (STRESS_PATTERNS.some((p) => t.includes(p))) stressCols.push(c);
    });
    if (strainCols.length === 0 || stressCols.length === 0) continue;
    const pairs: [number, number][] = [];
    for (const sc of strainCols) {
      const right = stressCols.filter((c) => c > sc);
      if (right.length) pairs.push([sc, Math.min(...right)]);
    }
    if (pairs.length) return { headerRow: r, pairs };
  }
  return null;
}

/** Read the units row (just below the header) to decide % vs fraction. */
function strainIsPercent(rows: Row[], headerRow: number, strainCol: number): boolean {
  const unitsRow = rows[headerRow + 1];
  const u = unitsRow ? txt(cellAt(unitsRow, strainCol)) : "";
  if (u.includes("%")) return true;
  if (u.includes("mm/mm") || u.includes("ratio")) return false;
  return STRAIN_IN_PERCENT_DEFAULT;
}

// --------------------------------------------------------------------------- //
// Run detection                                                               //
// --------------------------------------------------------------------------- //

/**
 * Find every run on one sheet. Prefers a labelled header (one [strain, stress]
 * pair per Specimen sheet); falls back to numeric column-pairing for unlabelled
 * side-by-side layouts. Returns runs *without* labels — the caller assigns those
 * once it knows how many runs a sheet produced.
 */
function detectRunsInSheet(grid: SheetGrid): { runs: Omit<RawRun, "label">[]; method: DetectionMethod } {
  if (SKIP_SHEETS.has(grid.name.trim().toLowerCase())) return { runs: [], method: "none" };

  const header = findHeader(grid.rows);
  if (header) {
    const runs: Omit<RawRun, "label">[] = [];
    for (const [sc, stc] of header.pairs) {
      const strain: number[] = [];
      const stress: number[] = [];
      let firstRow = 0;
      let lastRow = 0;
      // Data starts on the row below the header; the units row is filtered out
      // automatically because its cells aren't numeric.
      for (let r = header.headerRow + 1; r < grid.rows.length; r += 1) {
        const a = cellAt(grid.rows[r], sc);
        const b = cellAt(grid.rows[r], stc);
        if (isNum(a) && isNum(b)) {
          if (firstRow === 0) firstRow = r + 1; // 1-based
          lastRow = r + 1;
          strain.push(a);
          stress.push(b);
        }
      }
      if (strain.length >= MIN_POINTS_PER_COL) {
        runs.push({
          sheet: grid.name,
          strainCol: sc,
          stressCol: stc,
          firstRow,
          lastRow,
          strain,
          stress,
          strainIsPercent: strainIsPercent(grid.rows, header.headerRow, sc),
        });
      }
    }
    if (runs.length) return { runs, method: "header" };
  }

  const numeric = detectRunsNumeric(grid);
  return { runs: numeric, method: numeric.length ? "numeric" : "none" };
}

/** Fraction of adjacent steps that are non-decreasing (Python `_frac_increasing`). */
function fracIncreasing(arr: number[]): number {
  if (arr.length < 2) return 0;
  let inc = 0;
  for (let i = 1; i < arr.length; i += 1) {
    if (arr[i] - arr[i - 1] >= -1e-9) inc += 1;
  }
  return inc / (arr.length - 1);
}

/**
 * Fallback: an unlabelled sheet with adjacent [strain, stress] column pairs.
 * Groups consecutive numeric columns, pairs them two-by-two, and uses the
 * monotonicity heuristic (strain ramps up more steadily than stress) to decide
 * which column of each pair is strain.
 */
function detectRunsNumeric(grid: SheetGrid): Omit<RawRun, "label">[] {
  // Per-column list of (1-based row, value) for every numeric cell.
  let ncol = 0;
  for (const row of grid.rows) ncol = Math.max(ncol, row.length);
  const cols: Array<Array<[number, number]>> = Array.from({ length: ncol }, () => []);
  grid.rows.forEach((row, r) => {
    for (let c = 0; c < ncol; c += 1) {
      const v = cellAt(row, c);
      if (isNum(v)) cols[c].push([r + 1, v]);
    }
  });

  const dataIdx: number[] = [];
  cols.forEach((vals, c) => {
    if (vals.length >= MIN_POINTS_PER_COL) dataIdx.push(c);
  });

  // Group runs of consecutive column indices.
  const groups: number[][] = [];
  for (const c of dataIdx) {
    const last = groups[groups.length - 1];
    if (last && c === last[last.length - 1] + 1) last.push(c);
    else groups.push([c]);
  }

  const runs: Omit<RawRun, "label">[] = [];
  for (const g of groups) {
    for (let i = 0; i + 1 < g.length; i += 2) {
      const aIdx = g[i];
      const bIdx = g[i + 1];
      const aMap = new Map(cols[aIdx]);
      const bMap = new Map(cols[bIdx]);
      const common: number[] = [];
      for (const r of aMap.keys()) {
        if (bMap.has(r)) common.push(r);
      }
      common.sort((x, y) => x - y);
      if (common.length < MIN_POINTS_PER_COL) continue;
      const a = common.map((r) => aMap.get(r) as number);
      const b = common.map((r) => bMap.get(r) as number);

      let strainCol: number;
      let stressCol: number;
      let strain: number[];
      let stress: number[];
      if (fracIncreasing(b) > fracIncreasing(a) + 1e-9) {
        strainCol = bIdx;
        stressCol = aIdx;
        strain = b;
        stress = a;
      } else {
        strainCol = aIdx;
        stressCol = bIdx;
        strain = a;
        stress = b;
      }
      runs.push({
        sheet: grid.name,
        strainCol,
        stressCol,
        firstRow: common[0],
        lastRow: common[common.length - 1],
        strain,
        stress,
        strainIsPercent: STRAIN_IN_PERCENT_DEFAULT,
      });
    }
  }
  return runs;
}

// --------------------------------------------------------------------------- //
// Instrument "Results" sheet (Phase 8)                                        //
// --------------------------------------------------------------------------- //

/** The machine `Results` column headers we map to computed properties. */
const MACHINE_HEADERS = ["Et", "sM", "eM", "sB", "eB"] as const;

/**
 * Port of `read_machine_results`: pull the instrument's per-specimen values from
 * a `Results` sheet, keyed by specimen label (e.g. "Specimen 1"). Rows 0/1 are
 * the header + units rows; data rows whose first cell starts with "specimen" are
 * read. Returns `{}` when there is no usable `Results` sheet.
 */
export function readMachineResults(sheets: SheetGrid[]): Record<string, MachineResults> {
  const sheet = sheets.find((s) => s.name.trim().toLowerCase() === "results");
  if (!sheet || sheet.rows.length < 3) return {};
  const header = sheet.rows[0].map((c) => (c != null ? String(c).trim() : ""));
  const colOf = new Map<string, number>();
  for (const h of MACHINE_HEADERS) {
    const idx = header.indexOf(h);
    if (idx >= 0) colOf.set(h, idx);
  }
  if (colOf.size === 0) return {};

  const out: Record<string, MachineResults> = {};
  for (let r = 2; r < sheet.rows.length; r += 1) {
    const row = sheet.rows[r];
    const key = cellAt(row, 0);
    if (key == null || !String(key).trim().toLowerCase().startsWith("specimen")) continue;
    const rec: MachineResults = {};
    for (const [h, c] of colOf) {
      const v = cellAt(row, c);
      if (isNum(v)) rec[h as keyof MachineResults] = v;
    }
    out[String(key).trim()] = rec;
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Workbook-level summary helpers                                              //
// --------------------------------------------------------------------------- //

function summarizeStrainUnit(runs: RawRun[]): StrainUnit {
  if (runs.length === 0) return "n/a";
  const anyPercent = runs.some((r) => r.strainIsPercent);
  const anyFraction = runs.some((r) => !r.strainIsPercent);
  if (anyPercent && anyFraction) return "mixed";
  return anyPercent ? "%" : "mm/mm";
}

// --------------------------------------------------------------------------- //
// Public API                                                                  //
// --------------------------------------------------------------------------- //

/**
 * Pure detection over already-extracted sheet grids. Iterates sheets in order,
 * labels each sheet's runs the way the Python driver does, and reports the
 * skipped metadata sheets, the detection path, and the strain-unit summary.
 *
 * `runs.length === 0` is the "No runs detected" condition the caller should
 * surface visibly rather than silently producing nothing.
 */
export function parseSheets(sheets: SheetGrid[], fileName: string): ParsedWorkbook {
  const runs: RawRun[] = [];
  const skippedSheets: string[] = [];
  let sawHeader = false;
  let sawNumeric = false;

  for (const grid of sheets) {
    if (SKIP_SHEETS.has(grid.name.trim().toLowerCase())) {
      skippedSheets.push(grid.name);
      continue;
    }
    const { runs: sheetRuns, method } = detectRunsInSheet(grid);
    if (method === "header") sawHeader = true;
    if (method === "numeric") sawNumeric = true;
    sheetRuns.forEach((run, k) => {
      const label = sheetRuns.length === 1 ? grid.name : `${grid.name} – run ${k + 1}`;
      runs.push({ ...run, label });
    });
  }

  let detection: DetectionMethod = "none";
  if (sawHeader) detection = "header";
  else if (sawNumeric) detection = "numeric";

  return {
    fileName,
    runs,
    skippedSheets,
    detection,
    strainUnit: summarizeStrainUnit(runs),
    machine: readMachineResults(sheets),
  };
}

/**
 * Read every sheet of a SheetJS workbook into a ragged cell grid. `raw: true`
 * keeps numbers as numbers (so `isNum` works), and `blankrows: true` preserves
 * absolute row positions so `firstRow`/`lastRow` stay meaningful.
 */
export function workbookToSheets(wb: XLSX.WorkBook): SheetGrid[] {
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json<Row>(ws, {
      header: 1,
      raw: true,
      blankrows: true,
      defval: null,
    });
    return { name, rows };
  });
}

/**
 * Browser entry point: parse an uploaded `.xlsx` into the model. Accepts the
 * `ArrayBuffer` from `File.arrayBuffer()` (or a `Uint8Array`); both are wrapped
 * in a `Uint8Array` because SheetJS's `type: "array"` reads an indexable byte
 * array, not a bare `ArrayBuffer`.
 */
export function parseWorkbook(data: ArrayBuffer | Uint8Array, fileName: string): ParsedWorkbook {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const wb = XLSX.read(bytes, { type: "array" });
  return parseSheets(workbookToSheets(wb), fileName);
}
