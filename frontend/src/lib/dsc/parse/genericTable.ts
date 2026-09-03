// Generic CSV / XLSX / TSV parser (§2.3 of the plan).
//
// Any delimited text or spreadsheet the user drops that doesn't match a
// native DSC format. Sniff the delimiter, find the header row, then either
// auto-detect the column map or defer to a column-mapping dialog (WP2).
// Column matchers are lowercased header-text substrings, mirroring
// `lib/tga/parse/genericTable.ts`'s style exactly — but adapted for heat
// flow instead of weight, including a normalized (W/g) column that may exist
// ALONGSIDE or INSTEAD OF a raw (mW/W) one.
//
// A generic import carries no segment structure of its own — the whole run
// becomes one segment, classified the same way any other segment is
// (§WP1.4's `classifySegment`, via `buildSegments`).
//
// Pure over a cell grid; the browser entry reads the bytes via SheetJS (for
// .xlsx/.xls) or a CSV split (for .csv/.txt/.tsv).

import * as XLSX from "xlsx";
import { type Cell, type Row, type SheetGrid, workbookToSheets } from "@/lib/tensile/parse";
import { buildSegments } from "../segments";
import type { DscColumnMap, ParsedDscFile, ParsedDscRun } from "../types";

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
 *  localStorage (the joined, lowercased header text). Consumed by WP2's
 *  `columnMaps.ts` under the key `"dsc.columnMaps.v1"`. */
export function headerSignature(headerRow: Row): string {
  return headerRow.map((c) => txt(c)).filter(Boolean).join("|");
}

/** Find the first header column matching `pred`, skipping any index in
 *  `exclude`. Returns -1 when none match. */
function findCol(header: Row, pred: (h: string) => boolean, exclude: number[] = []): number {
  for (let c = 0; c < header.length; c++) {
    if (exclude.includes(c)) continue;
    const h = txt(header[c]);
    if (h && pred(h)) return c;
  }
  return -1;
}

/** Unit alias detection for a heat-flow-like header's own text (§2.3: units
 *  are read from the header string itself, e.g. "Heat Flow (mW)", the same
 *  convention TGA's generic table uses — there's no separate units row for
 *  an arbitrary CSV). */
function heatFlowUnitFromHeader(h: string): DscColumnMap["heatFlowUnit"] {
  if (h.includes("w/g")) return "W/g";
  if (h.includes("mw/mg")) return "mW/mg";
  if (h.includes("mw")) return "mW";
  if (h.includes("w")) return "W";
  return "mW";
}

/**
 * Auto-detect a {@link DscColumnMap} from a single-sheet grid by header-name
 * matching (§2.3's matcher table). Returns null when no confident
 * Time/Temperature/HeatFlow trio is found — the caller should then open the
 * ColumnMapDialog.
 *
 * A µV/µV-labelled heat-flow column is explicitly UNSUPPORTED (no calibration
 * factor is knowable from the header alone) — it is skipped as a candidate
 * rather than silently mis-scaled; if a separate normalized (W/g) column also
 * exists it is used instead.
 */
export function autoDetectColumnMap(grid: SheetGrid): DscColumnMap | null {
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

  const time = findCol(header, (h) => h.includes("time") || h.includes("min") || h.includes("sec") || h === "s");
  const temperature = findCol(
    header,
    (h) => h.includes("temp") || h.includes("°c") || h === "ts" || h === "tr",
  );
  if (time < 0 || temperature < 0) return null;

  const heatFlowNorm = findCol(
    header,
    (h) => h.includes("normal") || h.includes("w/g") || h.includes("mw/mg"),
    [time, temperature],
  );
  const rawCandidate = findCol(
    header,
    (h) =>
      !h.includes("µv") &&
      !h.includes("uv") &&
      (h.includes("heat flow") ||
        h.includes("heatflow") ||
        /\bhf\b/.test(h) ||
        h.includes("dsc") ||
        h.includes("unsubtracted") ||
        /\bvalue\b/.test(h)),
    [time, temperature, heatFlowNorm],
  );

  const heatFlow = rawCandidate >= 0 ? rawCandidate : heatFlowNorm;
  if (heatFlow < 0) return null; // no usable heat-flow column at all (or only a µV one)

  const heatFlowUnit = heatFlowUnitFromHeader(txt(header[heatFlow]));
  const timeHeader = txt(header[time]);
  const timeUnit: DscColumnMap["timeUnit"] =
    timeHeader.includes("sec") || /\bs\b/.test(timeHeader) ? "s" : "min";
  const tempHeader = txt(header[temperature]);
  const tempUnit: DscColumnMap["tempUnit"] = tempHeader.includes("k") && !tempHeader.includes("°c") ? "K" : "C";

  return {
    time,
    timeUnit,
    temperature,
    heatFlow,
    heatFlowNorm: heatFlowNorm >= 0 ? heatFlowNorm : undefined,
    heatFlowUnit,
    tempUnit,
    exoDirection: "up",
    headerRow: headerRowIdx,
    firstDataRow: headerRowIdx + 1,
  };
}

/** Convert a temperature to °C per the column map's unit. */
function toC(v: number, unit: DscColumnMap["tempUnit"]): number {
  if (!Number.isFinite(v)) return NaN;
  return unit === "K" ? v - 273.15 : v;
}

/** Convert a time value to minutes per the column map's unit. */
function toMin(v: number, unit: DscColumnMap["timeUnit"]): number {
  if (!Number.isFinite(v)) return NaN;
  return unit === "s" ? v / 60 : v;
}

/**
 * Pure extraction over a single-sheet grid given a column map (§2.3's
 * conversion table). When the heat-flow column is normalized (W/g or
 * mW/mg) a raw mW series is derived via `× sampleMassMg` when a mass is
 * known; otherwise `heatFlowMw` is left `NaN`-filled and only
 * `heatFlowNormFile` carries real data.
 */
export function extractGenericGrid(
  grid: SheetGrid,
  map: DscColumnMap,
  sampleMassMg: number | null,
): { timeMin: Float64Array; tempC: Float64Array; heatFlowMw: Float64Array; heatFlowNormFile?: Float64Array } {
  const timeMin: number[] = [];
  const tempC: number[] = [];
  const heatFlowMw: number[] = [];
  const heatFlowNorm: number[] = [];
  const isNormUnit = map.heatFlowUnit === "W/g" || map.heatFlowUnit === "mW/mg";
  for (let r = map.firstDataRow; r < grid.rows.length; r++) {
    const row = grid.rows[r];
    const t = num(at(row, map.time));
    if (!Number.isFinite(t)) continue;
    const T = num(at(row, map.temperature));
    timeMin.push(toMin(t, map.timeUnit));
    tempC.push(toC(T, map.tempUnit));

    const hfRaw = num(at(row, map.heatFlow));
    if (isNormUnit) {
      const norm = Number.isFinite(hfRaw) ? hfRaw : NaN;
      heatFlowNorm.push(norm);
      heatFlowMw.push(
        Number.isFinite(norm) && sampleMassMg != null && sampleMassMg > 0 ? norm * sampleMassMg : NaN,
      );
    } else {
      heatFlowMw.push(Number.isFinite(hfRaw) ? (map.heatFlowUnit === "W" ? hfRaw * 1000 : hfRaw) : NaN);
      if (map.heatFlowNorm != null && map.heatFlowNorm >= 0) {
        const n = num(at(row, map.heatFlowNorm));
        heatFlowNorm.push(Number.isFinite(n) ? n : NaN);
      }
    }
  }
  const out: {
    timeMin: Float64Array;
    tempC: Float64Array;
    heatFlowMw: Float64Array;
    heatFlowNormFile?: Float64Array;
  } = {
    timeMin: Float64Array.from(timeMin),
    tempC: Float64Array.from(tempC),
    heatFlowMw: Float64Array.from(heatFlowMw),
  };
  if (heatFlowNorm.length === timeMin.length && heatFlowNorm.length > 0) {
    out.heatFlowNormFile = Float64Array.from(heatFlowNorm);
  }
  return out;
}

/** Parse a single-sheet generic grid into one run, given a column map. Pure.
 *  The whole run becomes one segment (§2.3) — classified the normal way. */
export function parseGenericGrid(
  grid: SheetGrid,
  fileName: string,
  map: DscColumnMap,
  sampleMassMg: number | null = null,
): ParsedDscFile {
  const warnings: string[] = [];
  const data = extractGenericGrid(grid, map, sampleMassMg);
  if (data.timeMin.length === 0) {
    warnings.push(`${fileName}: no data rows found after the header.`);
    return { fileName, runs: [], warnings };
  }
  if ((map.heatFlowUnit === "W/g" || map.heatFlowUnit === "mW/mg") && (sampleMassMg == null || sampleMassMg <= 0)) {
    warnings.push(
      `${fileName}: no sample mass available to convert the normalized heat-flow column to mW — only normalized values are stored.`,
    );
  }
  const stem = fileName.replace(/\.[^.]+$/, "");
  const meta: ParsedDscRun["meta"] = {
    instrument: "",
    operator: "",
    sampleName: stem,
    sampleMassMg,
    panMassMg: null,
    pan: "",
    methodSteps: [],
    runDate: "",
    gases: "",
    cooler: "",
    cellConstant: "",
    sampleInterval: "",
    exoDirection: map.exoDirection,
  };
  const segments = buildSegments(stem, data.tempC, data.timeMin, [
    { start: 0, end: data.timeMin.length, label: "Run" },
  ]);
  const run: ParsedDscRun = {
    label: stem,
    meta,
    segments,
    timeMin: data.timeMin,
    tempC: data.tempC,
    heatFlowMw: data.heatFlowMw,
    ...(data.heatFlowNormFile ? { heatFlowNormFile: data.heatFlowNormFile } : {}),
  };
  return { fileName, runs: [run], warnings };
}

/** Sniff the delimiter of a text file from its first line: "," ";" or "\t",
 *  whichever splits it into the most fields. */
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
    rows.push(line.split(delim).map((c) => c.trim()));
  }
  return { name: fileName, rows };
}

/** The first sheet of a spreadsheet as a cell grid. Returns null when the
 *  workbook has no sheets. */
export function firstSheetGrid(buffer: ArrayBuffer | Uint8Array, fileName: string): SheetGrid | null {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const wb = XLSX.read(bytes, { type: "array" });
  const sheets = workbookToSheets(wb);
  const grid = sheets[0];
  if (!grid) return null;
  return { ...grid, name: grid.name || fileName };
}

/** Browser entry for a generic spreadsheet (.xlsx/.xls). */
export function parseGenericXlsx(
  buffer: ArrayBuffer | Uint8Array,
  fileName: string,
  map?: DscColumnMap,
): ParsedDscFile {
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
export function parseGenericCsv(text: string, fileName: string, map?: DscColumnMap): ParsedDscFile {
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
