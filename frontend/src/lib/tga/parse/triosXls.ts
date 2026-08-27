// TRIOS Excel export parser (§2.4 of the plan).
//
// Legacy BIFF8 OLE2 file (`D0 CF 11 E0`), read by SheetJS. The workbook has a
// `Details` sheet (key/value metadata) plus one sheet per procedure segment
// (e.g. "Isothermal 1.0 min", "Ramp 10.00 °Cmin to 600.00 °C"). Each segment
// sheet holds several samples side by side in blocks: row 0 = sample titles,
// row 1 = column headers, row 2 = units, rows 3+ = data. A block is a 5-column
// run (`Time | Temperature | Weight | Weight | Deriv. Weight`) followed by 3
// blank columns, but the block width is NOT fixed — detect blocks by scanning
// row 1 for cells equal to "Time" (case-insensitive); the block runs to the next
// blank header cell. The sample name sits in row 0 one column LEFT of the
// block's Time column. Blocks have different lengths (trim trailing all-null
// rows independently). The export duplicates the first three rows — dedupe by
// dropping rows whose time is not strictly greater than the previous kept row.
//
// One file therefore yields N runs (one per sample block, across all segment
// sheets). The store's unit is a run, not a file.
//
// Pure over a SheetJS cell grid (mirrors `lib/tensile/parse.ts`'s split): the
// pure `parseTriosSheets` works over `SheetGrid[]` and is unit-testable without
// a binary; `parseTriosXls` is the thin browser entry that reads the bytes via
// SheetJS then delegates.

import * as XLSX from "xlsx";
import {
  type Cell,
  type Row,
  type SheetGrid,
  workbookToSheets,
} from "@/lib/tensile/parse";
import type { ParsedRun, ParsedTgaFile, TgaMetadata, TgaSegment } from "../types";

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

/** Read the `Details` sheet into a key/value map. */
export function readDetailsSheet(sheets: SheetGrid[]): Record<string, string> {
  const sheet = sheets.find((s) => s.name.trim().toLowerCase() === "details");
  if (!sheet) return {};
  const out: Record<string, string> = {};
  for (const row of sheet.rows) {
    if (row.length < 2) continue;
    const k = txt(row[0]);
    const v = at(row, 1);
    if (k && v != null) out[k] = String(v).trim();
  }
  return out;
}

/** One detected sample block in a segment sheet. */
export interface TriosBlock {
  sampleName: string;
  timeCol: number;
  tempCol: number;
  weightCol: number;
  weightPctCol: number;
  dtgCol: number;
  /** Last column index (exclusive) of the block. */
  endCol: number;
}

/** Detect sample blocks in a segment sheet by scanning row 1 (the header row)
 *  for cells equal to "Time" (case-insensitive, trimmed). Each block runs from
 *  its Time column to the next blank header cell. The sample name sits in row 0
 *  one column to the LEFT of the Time column. The two "Weight" columns (mg and
 *  %) are distinguished by the units row (row 2): the one with a "%" unit is the
 *  weight-% column; the plain weight column is the mg one. */
export function detectBlocks(grid: SheetGrid): TriosBlock[] {
  if (grid.rows.length < 3) return [];
  const headerRow = grid.rows[1];
  const titleRow = grid.rows[0];
  const unitsRow = grid.rows[2];
  const blocks: TriosBlock[] = [];
  for (let c = 0; c < headerRow.length; c++) {
    if (txt(headerRow[c]) !== "time") continue;
    // The block runs from `c` to the next blank header cell.
    let endCol = c + 1;
    while (endCol < headerRow.length && txt(headerRow[endCol]) !== "") endCol++;
    // The sample name is one column left of the Time column.
    const sampleName = at(titleRow, c - 1) != null ? String(at(titleRow, c - 1)).trim() : "";
    // Find the Temperature, Weight, Weight%, Deriv columns within the block.
    // Two "Weight" columns exist (mg and %); the units row distinguishes them.
    let tempCol = -1;
    let weightCol = -1;
    let weightPctCol = -1;
    let dtgCol = -1;
    for (let k = c; k < endCol; k++) {
      const h = txt(headerRow[k]);
      const u = txt(at(unitsRow, k));
      if (h.startsWith("temp")) tempCol = k;
      else if (h.startsWith("weight")) {
        if (u.includes("%")) weightPctCol = k;
        else weightCol = k;
      } else if (h.startsWith("deriv")) dtgCol = k;
    }
    if (tempCol < 0 || weightCol < 0) continue;
    blocks.push({
      sampleName,
      timeCol: c,
      tempCol,
      weightCol,
      weightPctCol: weightPctCol >= 0 ? weightPctCol : -1,
      dtgCol: dtgCol >= 0 ? dtgCol : -1,
      endCol,
    });
    c = endCol - 1;
  }
  return blocks;
}

/** Extract one block's data: trim trailing all-null rows and dedupe by
 *  strictly-ascending time. Returns the parallel arrays. */
export function extractBlock(
  grid: SheetGrid,
  block: TriosBlock,
  firstDataRow: number,
): {
  timeMin: Float64Array;
  tempC: Float64Array;
  weightMg: Float64Array;
  weightPct?: Float64Array;
  dtg?: Float64Array;
} {
  const rows = grid.rows;
  // Find the last non-null row for this block (trim trailing all-null rows).
  let lastRow = firstDataRow - 1;
  for (let r = firstDataRow; r < rows.length; r++) {
    const row = rows[r];
    let any = false;
    for (let c = block.timeCol; c < block.endCol; c++) {
      if (at(row, c) != null && at(row, c) !== "") {
        any = true;
        break;
      }
    }
    if (any) lastRow = r;
  }
  const timeMin: number[] = [];
  const tempC: number[] = [];
  const weightMg: number[] = [];
  const weightPct: number[] = [];
  const dtg: number[] = [];
  let prevTime = -Infinity;
  for (let r = firstDataRow; r <= lastRow; r++) {
    const row = rows[r];
    const t = num(at(row, block.timeCol));
    if (!Number.isFinite(t)) continue;
    // Dedupe: drop rows whose time is not strictly greater than the previous kept row.
    if (t <= prevTime) continue;
    prevTime = t;
    const T = num(at(row, block.tempCol));
    const w = num(at(row, block.weightCol));
    timeMin.push(t);
    tempC.push(Number.isFinite(T) ? T : NaN);
    weightMg.push(Number.isFinite(w) ? w : NaN);
    if (block.weightPctCol >= 0) {
      const wp = num(at(row, block.weightPctCol));
      weightPct.push(Number.isFinite(wp) ? wp : NaN);
    }
    if (block.dtgCol >= 0) {
      const d = num(at(row, block.dtgCol));
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
  if (block.weightPctCol >= 0 && weightPct.length === timeMin.length) {
    out.weightPct = Float64Array.from(weightPct);
  }
  if (block.dtgCol >= 0 && dtg.length === timeMin.length) {
    out.dtg = Float64Array.from(dtg);
  }
  return out;
}

/** Build metadata from the `Details` sheet. */
export function buildTriosXlsMetadata(
  details: Record<string, string>,
  fileName: string,
): TgaMetadata {
  const get = (k: string): string => details[k.toLowerCase()] ?? details[k] ?? "";
  let sampleSizeMg: number | null = null;
  const sizeStr = get("sample size") || get("samplesize");
  if (sizeStr) {
    const n = Number(sizeStr);
    if (Number.isFinite(n)) sampleSizeMg = n; // TRIOS Details gives mg directly
  }
  const segmentsStr = get("proceduresegments") || get("procedure segments");
  const methodSteps = segmentsStr
    ? segmentsStr.split(";").map((s) => s.trim()).filter(Boolean)
    : [];
  return {
    instrument: get("instrument name") || "TGA5500",
    operator: get("operator"),
    sampleName: get("sample name") || get("samplename") || fileName.replace(/\.[^.]+$/, ""),
    sampleSizeMg,
    pan: get("pan type") || get("pantype"),
    methodSteps,
    runDate: get("rundate") || get("run date"),
    gases: "",
  };
}

/** Pure detection over already-extracted SheetJS sheets. Returns one run per
 *  detected sample block, across all segment sheets (excluding `Details`). */
/** Highest temperature below which a block counts as "at ambient", in °C. */
const AMBIENT_MAX_C = 40;
/** Temperature span below which a block counts as isothermal, in °C. */
const ISOTHERMAL_SPAN_C = 1;
/** Mass change below which a block counts as featureless, in percent. */
const FEATURELESS_LOSS_PCT = 1;

/**
 * True for an instrument equilibration hold: near room temperature, no
 * temperature range, and no mass change. See the call site for why these three
 * conditions are required together rather than any one of them.
 */
export function isAmbientHold(tempC: Float64Array, weightMg: Float64Array): boolean {
  const n = Math.min(tempC.length, weightMg.length);
  if (n === 0) return false;
  let tLo = Infinity;
  let tHi = -Infinity;
  let wLo = Infinity;
  let wHi = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const T = tempC[i];
    const w = weightMg[i];
    if (Number.isFinite(T)) {
      if (T < tLo) tLo = T;
      if (T > tHi) tHi = T;
    }
    if (Number.isFinite(w)) {
      if (w < wLo) wLo = w;
      if (w > wHi) wHi = w;
    }
  }
  if (!Number.isFinite(tLo) || !Number.isFinite(wLo) || wHi <= 0) return false;
  const spanC = tHi - tLo;
  const changePct = ((wHi - wLo) / wHi) * 100;
  return tHi < AMBIENT_MAX_C && spanC < ISOTHERMAL_SPAN_C && changePct < FEATURELESS_LOSS_PCT;
}

export function parseTriosSheets(sheets: SheetGrid[], fileName: string): ParsedTgaFile {
  const warnings: string[] = [];
  const details = readDetailsSheet(sheets);
  const metadata = buildTriosXlsMetadata(details, fileName);
  const runs: ParsedRun[] = [];
  for (const grid of sheets) {
    const name = grid.name.trim().toLowerCase();
    if (name === "details") continue;
    if (grid.rows.length < 4) continue;
    const blocks = detectBlocks(grid);
    if (blocks.length === 0) continue;
    const segmentLabel = grid.name.trim();
    const segment: TgaSegment = { label: segmentLabel };
    for (const block of blocks) {
      const data = extractBlock(grid, block, 3);
      if (data.timeMin.length === 0) continue;
      // A TRIOS procedure usually opens with a short hold at ambient to let the
      // balance settle, and the export gives that hold its own segment sheet.
      // It is not a sample: no temperature range, no mass change, nothing to
      // analyse — but as a "run" it lands in every list, skews the compare
      // chart, and stretches the figure axes. Skip it, and only it: a genuine
      // isothermal experiment sits well above ambient (or actually loses mass),
      // so both tests have to pass before a block is dropped.
      if (isAmbientHold(data.tempC, data.weightMg)) {
        warnings.push(
          `${fileName}: skipped "${segmentLabel}" — an equilibration hold at ambient with no mass change.`,
        );
        continue;
      }
      runs.push({
        label: block.sampleName || `${segmentLabel} run ${runs.length + 1}`,
        meta: { ...metadata, sampleName: block.sampleName || metadata.sampleName },
        segments: [segment],
        timeMin: data.timeMin,
        tempC: data.tempC,
        weightMg: data.weightMg,
        ...(data.weightPct ? { weightPctFile: data.weightPct } : {}),
        ...(data.dtg ? { dtgFile: data.dtg } : {}),
      });
    }
  }
  if (runs.length === 0) {
    warnings.push(`${fileName}: no sample blocks found in any segment sheet.`);
  }
  return { fileName, runs, warnings };
}

/** Browser entry: parse a TRIOS Excel export (`sample 1.xls`) into one or more
 *  runs. Reads the bytes via SheetJS, then delegates to the pure
 *  {@link parseTriosSheets}. */
export function parseTriosXls(buffer: ArrayBuffer | Uint8Array, fileName: string): ParsedTgaFile {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const wb = XLSX.read(bytes, { type: "array" });
  return parseTriosSheets(workbookToSheets(wb), fileName);
}