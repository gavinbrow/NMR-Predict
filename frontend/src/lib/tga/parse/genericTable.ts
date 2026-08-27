// Generic CSV / XLSX / TSV parser (§2.5 of the plan).
//
// Any delimited text or spreadsheet the user drops, when it doesn't match a
// native TGA format. Sniff the delimiter (, ; \t), find the header row, then
// open a column-mapping dialog: which column is Time, Temperature, Weight, and
// optionally Weight % / Deriv. Weight, plus the weight unit (mg/g/%) and
// temperature unit (°C/K). Pre-select by header-name matching
// (temp/weight/mass/time/deriv/dtg). Remember the mapping per header signature
// in localStorage so a repeat import of the same layout is one click.
//
// Pure over a cell grid; the browser entry reads the bytes via SheetJS (for
// .xlsx/.xls) or a CSV split (for .csv/.txt/.tsv).

import * as XLSX from "xlsx";
import { type Cell, type Row, type SheetGrid, workbookToSheets } from "@/lib/tensile/parse";
import type { ColumnMap, ParsedRun, ParsedTgaFile, TgaMetadata, TgaSegment } from "../types";

/** Lowercase, trimmed text of a cell. "" for null/undefined. */
function txt(v: Cell): string {
  if (v == null) return "";
  return String(v).trim().toLowerCase();
}

/** The cell as a finite number, or NaN. */
function num(v: Cell): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/** Safe indexed access on a ragged row. */
function at(row: Row, col: number): Cell {
  return col >= 0 && col < row.length ? row[col] : undefined;
}

/** A header-signature string for remembering a mapping per layout in
 *  localStorage (the joined, lowercased header text). */
export function headerSignature(headerRow: Row): string {
  return headerRow.map((c) => txt(c)).filter(Boolean).join("|");
}

/** Auto-detect a {@link ColumnMap} from a single-sheet grid by header-name
 *  matching. Returns null when no confident Time/Temperature/Weight trio is
 *  found — the caller should then open the ColumnMapDialog. */
export function autoDetectColumnMap(grid: SheetGrid): ColumnMap | null {
  // Find the header row: the first row with at least three non-blank cells.
  let headerRowIdx = -1;
  for (let r = 0; r < grid.rows.length && r < 20; r++) {
    let nonBlank = 0;
    for (const c of grid.rows[r]) if (txt(c) !== "") nonBlank++;
    if (nonBlank >= 3) {
      headerRowIdx = r;
      break;
    }
  }
  if (headerRowIdx < 0) return null;
  const header = grid.rows[headerRowIdx];
  const findCol = (pred: (s: string) => boolean): number => {
    for (let c = 0; c < header.length; c++) {
      const h = txt(header[c]);
      if (h && pred(h)) return c;
    }
    return -1;
  };
  const time = findCol((h) => h.includes("time") || h.includes("min"));
  const temperature = findCol((h) => h.includes("temp") || h === "t" || h.includes("°c"));
  const weight = findCol(
    (h) => h.includes("weight") || h.includes("mass") || h === "w" || h.includes("mg"),
  );
  const weightPct = findCol((h) => h.includes("weight") && h.includes("%"));
  const dtg = findCol((h) => h.includes("deriv") || h.includes("dtg"));
  if (time < 0 || temperature < 0 || weight < 0) return null;
  // Unit sniffing from the header text.
  const weightHeader = txt(header[weight]);
  let weightUnit: ColumnMap["weightUnit"] = "mg";
  if (weightHeader.includes("g") && !weightHeader.includes("mg")) weightUnit = "g";
  else if (weightHeader.includes("%")) weightUnit = "%";
  const tempHeader = txt(header[temperature]);
  const tempUnit: ColumnMap["tempUnit"] = tempHeader.includes("k") ? "K" : "C";
  return {
    time,
    temperature,
    weight,
    weightPct: weightPct >= 0 ? weightPct : undefined,
    dtg: dtg >= 0 ? dtg : undefined,
    weightUnit,
    tempUnit,
    headerRow: headerRowIdx,
    firstDataRow: headerRowIdx + 1,
  };
}

/** Convert a weight value to mg per the column map's unit. */
function toMg(v: number, unit: ColumnMap["weightUnit"]): number {
  if (!Number.isFinite(v)) return NaN;
  if (unit === "g") return v * 1000;
  if (unit === "%") return v; // pass through — % is handled by normalization
  return v; // mg
}

/** Convert a temperature to °C per the column map's unit. */
function toC(v: number, unit: ColumnMap["tempUnit"]): number {
  if (!Number.isFinite(v)) return NaN;
  if (unit === "K") return v - 273.15;
  return v;
}

/** Pure extraction over a single-sheet grid given a column map. Returns the
 *  parallel arrays. Generic imports do NOT dedupe (only TRIOS does). */
export function extractGenericGrid(grid: SheetGrid, map: ColumnMap): {
  timeMin: Float64Array;
  tempC: Float64Array;
  weightMg: Float64Array;
  weightPct?: Float64Array;
  dtg?: Float64Array;
} {
  const timeMin: number[] = [];
  const tempC: number[] = [];
  const weightMg: number[] = [];
  const weightPct: number[] = [];
  const dtg: number[] = [];
  for (let r = map.firstDataRow; r < grid.rows.length; r++) {
    const row = grid.rows[r];
    const t = num(at(row, map.time));
    if (!Number.isFinite(t)) continue;
    const T = num(at(row, map.temperature));
    const w = num(at(row, map.weight));
    timeMin.push(t);
    tempC.push(toC(T, map.tempUnit));
    weightMg.push(toMg(w, map.weightUnit));
    if (map.weightPct != null && map.weightPct >= 0) {
      const wp = num(at(row, map.weightPct));
      weightPct.push(Number.isFinite(wp) ? wp : NaN);
    }
    if (map.dtg != null && map.dtg >= 0) {
      const d = num(at(row, map.dtg));
      dtg.push(Number.isFinite(d) ? d : NaN);
    }
  }
  const out: {
    timeMin: Float64Array;
    tempC: Float64Array;
    weightMg: Float64Array;
    weightPct?: Float64Array;
    dtg?: Float64Array;
  } = {
    timeMin: Float64Array.from(timeMin),
    tempC: Float64Array.from(tempC),
    weightMg: Float64Array.from(weightMg),
  };
  if (map.weightPct != null && map.weightPct >= 0 && weightPct.length === timeMin.length) {
    out.weightPct = Float64Array.from(weightPct);
  }
  if (map.dtg != null && map.dtg >= 0 && dtg.length === timeMin.length) {
    out.dtg = Float64Array.from(dtg);
  }
  return out;
}

/** Parse a single-sheet generic grid into one run, given a column map. Pure. */
export function parseGenericGrid(
  grid: SheetGrid,
  fileName: string,
  map: ColumnMap,
): ParsedTgaFile {
  const warnings: string[] = [];
  const data = extractGenericGrid(grid, map);
  if (data.timeMin.length === 0) {
    warnings.push(`${fileName}: no data rows found after the header.`);
    return { fileName, runs: [], warnings };
  }
  const stem = fileName.replace(/\.[^.]+$/, "");
  const meta: TgaMetadata = {
    instrument: "",
    operator: "",
    sampleName: stem,
    sampleSizeMg: null,
    pan: "",
    methodSteps: [],
    runDate: "",
    gases: "",
  };
  const run: ParsedRun = {
    label: stem,
    meta,
    segments: [{ label: "TGA" }],
    timeMin: data.timeMin,
    tempC: data.tempC,
    weightMg: data.weightMg,
    ...(data.weightPct ? { weightPctFile: data.weightPct } : {}),
    ...(data.dtg ? { dtgFile: data.dtg } : {}),
  };
  return { fileName, runs: [run], warnings };
}

/** Sniff the delimiter of a text file from its first line. Returns ",",
 *  ";", or "\t" — the one that splits the first non-empty line into the most
 *  fields (with a tie-break preferring the rarer one). */
export function sniffDelimiter(text: string): "," | ";" | "\t" {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  let best: "," | ";" | "\t" = ",";
  let bestCount = 0;
  for (const d of [",", ";", "\t"] as const) {
    const count = firstLine.split(d).length;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** Parse a CSV/TSV/TXT file into a single-sheet grid. Pure over the text. */
export function parseCsvText(text: string, fileName: string): SheetGrid {
  const delim = sniffDelimiter(text);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const rows: Row[] = [];
  for (const line of lines) {
    if (line === "" && rows.length > 0) continue;
    // Simple split — quotes are not common in TGA exports; if needed, SheetJS
    // handles a .csv via XLSX.read too, and that path is used by the browser
    // entry for .xlsx/.xls.
    rows.push(line.split(delim).map((c) => c.trim()));
  }
  return { name: fileName, rows };
}

/** The first sheet of a spreadsheet as a cell grid. Split out from
 *  {@link parseGenericXlsx} so the dispatcher can hand the grid to the
 *  column-mapping dialog when auto-detect can't decide. Returns null when the
 *  workbook has no sheets. */
export function firstSheetGrid(
  buffer: ArrayBuffer | Uint8Array,
  fileName: string,
): SheetGrid | null {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const wb = XLSX.read(bytes, { type: "array" });
  const sheets = workbookToSheets(wb);
  const grid = sheets[0];
  if (!grid) return null;
  return { ...grid, name: grid.name || fileName };
}

/** Browser entry for a generic spreadsheet (.xlsx/.xls). Reads via SheetJS,
 *  takes the first sheet, and delegates to {@link parseGenericGrid}. The column
 *  map is auto-detected when confident; otherwise the caller opens the dialog
 *  and re-calls with a map. */
export function parseGenericXlsx(
  buffer: ArrayBuffer | Uint8Array,
  fileName: string,
  map?: ColumnMap,
): ParsedTgaFile {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const wb = XLSX.read(bytes, { type: "array" });
  const sheets = workbookToSheets(wb);
  const grid = sheets[0];
  if (!grid) {
    return { fileName, runs: [], warnings: [`${fileName}: no sheets found.`] };
  }
  const resolved = map ?? autoDetectColumnMap(grid);
  if (!resolved) {
    return {
      fileName,
      runs: [],
      warnings: [`${fileName}: could not auto-detect columns — open the column mapper.`],
    };
  }
  return parseGenericGrid(grid, fileName, resolved);
}

/** Browser entry for a generic text file (.csv/.tsv/.txt). */
export function parseGenericCsv(
  text: string,
  fileName: string,
  map?: ColumnMap,
): ParsedTgaFile {
  const grid = parseCsvText(text, fileName);
  const resolved = map ?? autoDetectColumnMap(grid);
  if (!resolved) {
    return {
      fileName,
      runs: [],
      warnings: [`${fileName}: could not auto-detect columns — open the column mapper.`],
    };
  }
  return parseGenericGrid(grid, fileName, resolved);
}