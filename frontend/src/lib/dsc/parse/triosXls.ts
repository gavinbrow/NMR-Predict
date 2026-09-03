// TRIOS Excel export parser for DSC25 runs (§2.2 of the plan).
//
// Same legacy BIFF8 OLE2 container as the TGA export, read via SheetJS. The
// workbook shape is different, though: a `Details` sheet, then ONE SHEET PER
// DATA-ON RAMP (e.g. "Ramp 10.00 °Cmin to 280.00 °C", with Excel's stripped
// "/" and a "-2" suffix on a repeated ramp). Each sheet is therefore a
// SEGMENT, not a run — all of a workbook's segment sheets merge into ONE run,
// keyed by the `Details` sheet's Sample Name. (TGA's export is the other way
// around: one sheet per procedure step, several SAMPLES side by side within
// it, each block its own run.)
//
// Row 0's cell one column left of "Time" carries the segment's own title,
// e.g. "Ramp 10.00 °C/min to 280.00 °C" — WITH the slash Excel's sheet-name
// restriction strips. Read the rate/label from there, never from the sheet
// name.
//
// `Details` is a flat two-column key/value sheet, but its keys repeat across
// bracketed `[Section]` headers (`Sample Mass` appears only under
// `[Procedure]`, but other keys collide) — `readDscDetails` returns a
// section-keyed map (plus a flat `top` map for the handful of keys that
// appear before any section header).
//
// ⚠️ The exported "Heat Flow (Normalized)" column is rounded to 3 decimal
// places in W/g (§2.2) — every successful import pushes exactly one warning
// about it. When a raw "Heat Flow" (mW/W) column isn't present (the observed
// case), the raw mW series is derived from the normalized W/g column times
// the sample mass (W/g × mg = mW, since W/g ≡ mW/mg exactly) rather than left
// unpopulated, so every run still has a `heatFlowMw`.
//
// Pure over a SheetJS cell grid (`parseTriosSheets`); `parseTriosXls` is the
// thin browser entry that reads the bytes via SheetJS then delegates.

import * as XLSX from "xlsx";
import { type Cell, type Row, type SheetGrid, workbookToSheets } from "@/lib/tensile/parse";
import { buildSegments, type SegmentBlock } from "../segments";
import type { DscMetadata, ParsedDscFile, ParsedDscRun } from "../types";

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

/** Section-keyed + flat top-level `Details` sheet reader (§2.2). Keys are
 *  trimmed, which also normalises away the raw file's trailing-space quirk
 *  on `"Sample Interval "` — callers look up `"Sample Interval"`. */
export interface DscDetails {
  /** Keys that appear before any `[Section]` header (Filename, Instrument
   *  name, Operator, rundate, Sample name, proceduresegments). */
  top: Record<string, string>;
  /** Keys grouped by their `[Section]` header, section name without the
   *  brackets (e.g. `sections["Procedure"]["Sample Mass"]`). */
  sections: Record<string, Record<string, string>>;
}

export function readDscDetails(sheets: SheetGrid[]): DscDetails {
  const top: Record<string, string> = {};
  const sections: Record<string, Record<string, string>> = {};
  const sheet = sheets.find((s) => s.name.trim().toLowerCase() === "details");
  if (!sheet) return { top, sections };
  let current: string | null = null;
  for (const row of sheet.rows) {
    const keyCell = at(row, 0);
    const key = keyCell == null ? "" : String(keyCell).trim();
    if (!key) continue;
    const sectionMatch = /^\[(.+)\]$/.exec(key);
    if (sectionMatch) {
      current = sectionMatch[1].trim();
      if (!sections[current]) sections[current] = {};
      continue;
    }
    const valueCell = at(row, 1);
    const value = valueCell == null ? "" : String(valueCell).trim();
    if (current) sections[current][key] = value;
    else top[key] = value;
  }
  return { top, sections };
}

/** Parse a `"<number> <unit>"` string (e.g. `"11.69 mg"`), returning the
 *  value converted to mg. Returns null when unparseable. */
function parseMassMg(s: string | undefined): number | null {
  if (!s) return null;
  const m = /(-?[\d.]+)\s*([a-zA-Z]+)?/.exec(s.trim());
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (m[2] ?? "mg").toLowerCase();
  if (unit === "g") return value * 1000;
  return value; // mg, or an unrecognised unit — keep the raw number
}

/** Build the DSC metadata from the `Details` sheet's section-keyed map. */
export function buildTriosXlsDscMetadata(details: DscDetails, fileName: string): DscMetadata {
  const { top, sections } = details;
  const proc = sections["Procedure"] ?? {};
  const config = sections["Configuration"] ?? {};
  const cellCal = sections["Cell Constant Calibration"] ?? {};
  const t1Cal = sections["T1 Calibration"] ?? {};

  const segmentsStr = top["proceduresegments"] ?? "";
  const methodSteps = segmentsStr
    ? segmentsStr.split(";").map((s) => s.trim()).filter(Boolean)
    : [];

  const gasType = t1Cal["Gas Type"] ?? "";
  const flowRate = config["Flow Rate"] ?? "";
  const gases = [gasType, flowRate].filter(Boolean).join(", ");

  const exoRaw = (config["Exotherm Direction"] ?? "").trim().toLowerCase();

  return {
    instrument: config["Instrument Type"] || top["Instrument name"] || "DSC25",
    operator: top["Operator"] ?? "",
    sampleName: proc["Sample Name"] || top["Sample name"] || fileName.replace(/\.[^.]+$/, ""),
    sampleMassMg: parseMassMg(proc["Sample Mass"]),
    panMassMg: parseMassMg(proc["Pan Mass"]),
    pan: proc["Pan Type"] ?? "",
    methodSteps,
    runDate: top["rundate"] ?? "",
    gases,
    cooler: config["Cooler"] ?? "",
    cellConstant: cellCal["Onset Slope"] ?? "",
    sampleInterval: config["Sample Interval"] ?? "",
    exoDirection: exoRaw === "down" ? "down" : "up",
  };
}

/** One detected sample block within a segment sheet. Usually exactly one per
 *  sheet; `detectBlocks` scans for more so a multi-sample export still works
 *  (§2.2), though no sample file exercises that path. */
export interface TriosBlock {
  /** The segment's own title, from row 0 one column left of "Time" — this is
   *  what keeps the "/" a sheet name has to strip. */
  label: string;
  timeCol: number;
  timeUnit: "min" | "s";
  tempCol: number;
  tempUnit: "C" | "K";
  /** -1 when the sheet carries no raw Heat Flow column (the observed case —
   *  only the normalized W/g column is exported). */
  heatFlowCol: number;
  heatFlowUnit: "mW" | "W";
  /** -1 when the sheet carries no normalized column. */
  heatFlowNormCol: number;
  endCol: number;
}

/** Detect sample blocks by scanning row 1 for cells equal to "time"
 *  (case-insensitive). Mirrors TGA's `detectBlocks`, with DSC's column set:
 *  Temperature (°C|K, also accepts "Tzero Temperature"), Heat Flow (mW|W),
 *  Heat Flow (Normalized) (W/g|mW/mg — numerically identical, no conversion
 *  needed either way). */
export function detectBlocks(grid: SheetGrid): TriosBlock[] {
  if (grid.rows.length < 3) return [];
  const titleRow = grid.rows[0];
  const headerRow = grid.rows[1];
  const unitsRow = grid.rows[2];
  const blocks: TriosBlock[] = [];
  for (let c = 0; c < headerRow.length; c++) {
    if (txt(headerRow[c]) !== "time") continue;
    let endCol = c + 1;
    while (endCol < headerRow.length && txt(headerRow[endCol]) !== "") endCol++;

    const label = at(titleRow, c - 1) != null ? String(at(titleRow, c - 1)).trim() : "";

    let tempCol = -1;
    let tempFallbackCol = -1;
    let heatFlowCol = -1;
    let heatFlowUnit: TriosBlock["heatFlowUnit"] = "mW";
    let heatFlowNormCol = -1;
    for (let k = c; k < endCol; k++) {
      const h = txt(headerRow[k]);
      const u = txt(at(unitsRow, k));
      if (h === "temperature") tempCol = k;
      else if (h.includes("temp") && tempFallbackCol < 0) tempFallbackCol = k;
      else if (h.includes("heat flow") && h.includes("normal")) heatFlowNormCol = k;
      else if (h === "heat flow") {
        heatFlowCol = k;
        heatFlowUnit = u === "w" ? "W" : "mW";
      }
    }
    if (tempCol < 0) tempCol = tempFallbackCol;
    if (tempCol < 0) continue; // no usable temperature column — not a real block
    const timeUnit = txt(at(unitsRow, c)) === "s" ? "s" : "min";
    const tempUnitCell = txt(at(unitsRow, tempCol));
    const tempUnit: TriosBlock["tempUnit"] = tempUnitCell === "k" ? "K" : "C";
    blocks.push({
      label,
      timeCol: c,
      timeUnit,
      tempCol,
      tempUnit,
      heatFlowCol,
      heatFlowUnit,
      heatFlowNormCol,
      endCol,
    });
    c = endCol - 1;
  }
  return blocks;
}

/** Extract one block's data: trim trailing blank rows (TRIOS leaves the
 *  tail of a block's Temperature/Heat-Flow cells empty rather than
 *  zero-filled, unlike the `.tri` container's trailing zero pad, §2.1),
 *  dedupe exact leading repeats (the export duplicates the first three
 *  rows verbatim), and convert units. `sampleMassMg` derives `heatFlowMw`
 *  from the normalized W/g column when no raw column exists.
 *
 *  ⚠️ Dedupe by an EXACT repeat of the previously kept row, not merely a
 *  tied *displayed* Time value. Time is exported rounded to 2 dp (minutes);
 *  at a 0.1 s/pt sample interval, five or six consecutive real samples
 *  round to the same printed Time before it ticks over. A naive "reject any
 *  non-increasing Time" dedupe discarded ~5 of every 6 genuine data points
 *  — verified on `1-2 S1.xls`'s first ramp sheet: 16801 raw rows, only 2801
 *  survived, which also pulled a blank trailing row's NaN Temperature in as
 *  the segment's last point and broke `classifySegment` (it reads the
 *  segment's very last sample). */
export function extractBlock(
  grid: SheetGrid,
  block: TriosBlock,
  firstDataRow: number,
  sampleMassMg: number | null,
): { timeMin: Float64Array; tempC: Float64Array; heatFlowMw: Float64Array; heatFlowNormFile?: Float64Array } {
  const rows = grid.rows;
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
  const heatFlowMw: number[] = [];
  const heatFlowNorm: number[] = [];
  let prevTime = -Infinity;
  let prevTempRaw = NaN;
  let prevNormRaw = NaN;
  let prevHfRaw = NaN;
  for (let r = firstDataRow; r <= lastRow; r++) {
    const row = rows[r];
    const tRaw = num(at(row, block.timeCol));
    if (!Number.isFinite(tRaw)) continue;
    const TRaw = num(at(row, block.tempCol));
    if (!Number.isFinite(TRaw)) continue; // trailing blank pad — not a real sample
    const normRaw = block.heatFlowNormCol >= 0 ? num(at(row, block.heatFlowNormCol)) : NaN;
    const hfRaw = block.heatFlowCol >= 0 ? num(at(row, block.heatFlowCol)) : NaN;

    if (tRaw < prevTime) continue; // a genuine time regression — drop, keep the axis monotone
    const exactRepeat =
      tRaw === prevTime &&
      Object.is(TRaw, prevTempRaw) &&
      Object.is(normRaw, prevNormRaw) &&
      Object.is(hfRaw, prevHfRaw);
    if (exactRepeat) continue;
    prevTime = tRaw;
    prevTempRaw = TRaw;
    prevNormRaw = normRaw;
    prevHfRaw = hfRaw;

    const tMin = block.timeUnit === "s" ? tRaw / 60 : tRaw;
    const T = block.tempUnit === "K" ? TRaw - 273.15 : TRaw;

    let normWPerG = NaN;
    if (block.heatFlowNormCol >= 0 && Number.isFinite(normRaw)) normWPerG = normRaw; // W/g === mW/mg, no conversion needed
    let hfMw = NaN;
    if (block.heatFlowCol >= 0) {
      if (Number.isFinite(hfRaw)) hfMw = block.heatFlowUnit === "W" ? hfRaw * 1000 : hfRaw;
    } else if (Number.isFinite(normWPerG) && sampleMassMg != null && sampleMassMg > 0) {
      hfMw = normWPerG * sampleMassMg; // W/g × mg = mW
    }

    timeMin.push(tMin);
    tempC.push(T);
    heatFlowMw.push(hfMw);
    if (block.heatFlowNormCol >= 0) heatFlowNorm.push(normWPerG);
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
  if (block.heatFlowNormCol >= 0 && heatFlowNorm.length === timeMin.length) {
    out.heatFlowNormFile = Float64Array.from(heatFlowNorm);
  }
  return out;
}

/** Parse already-extracted SheetJS sheets into one `ParsedDscFile`. Every
 *  non-`Details` sheet is a segment; sample blocks are grouped by their
 *  index within the sheet (block 0 of every sheet → run 0's segments, block
 *  1 → run 1's, …) so a multi-sample export would still yield one run per
 *  sample. The observed file has exactly one block per sheet. */
export function parseTriosSheets(sheets: SheetGrid[], fileName: string): ParsedDscFile {
  const warnings: string[] = [];
  const details = readDscDetails(sheets);
  const metadata = buildTriosXlsDscMetadata(details, fileName);

  const segmentSheets = sheets.filter(
    (s) => s.name.trim().toLowerCase() !== "details" && s.rows.length >= 4,
  );
  // Group each sheet's blocks by their positional index, so block i across
  // every sheet becomes run i's segments.
  const perRun: { grid: SheetGrid; block: TriosBlock }[][] = [];
  for (const grid of segmentSheets) {
    const blocks = detectBlocks(grid);
    blocks.forEach((block, i) => {
      (perRun[i] ??= []).push({ grid, block });
    });
  }

  if (perRun.length === 0) {
    warnings.push(`${fileName}: no segment sheets with a Time/Temperature column found.`);
    return { fileName, runs: [], warnings };
  }

  let usedNormalized = false;
  const runs: ParsedDscRun[] = [];
  perRun.forEach((sources, runIndex) => {
    const segmentBlocks: SegmentBlock[] = [];
    const timeParts: Float64Array[] = [];
    const tempParts: Float64Array[] = [];
    const hfParts: Float64Array[] = [];
    const hfNormParts: Float64Array[] = [];
    let haveNorm = true;
    let w = 0;
    for (const { grid, block } of sources) {
      const data = extractBlock(grid, block, 3, metadata.sampleMassMg);
      if (data.timeMin.length === 0) continue;
      if (data.heatFlowNormFile) usedNormalized = true;
      else haveNorm = false;
      const segStart = w;
      w += data.timeMin.length;
      segmentBlocks.push({ start: segStart, end: w, label: block.label || grid.name.trim() });
      timeParts.push(data.timeMin);
      tempParts.push(data.tempC);
      hfParts.push(data.heatFlowMw);
      if (data.heatFlowNormFile) hfNormParts.push(data.heatFlowNormFile);
    }
    if (segmentBlocks.length === 0) return;

    const concat = (parts: Float64Array[]): Float64Array => {
      const total = parts.reduce((s, p) => s + p.length, 0);
      const out = new Float64Array(total);
      let o = 0;
      for (const p of parts) {
        out.set(p, o);
        o += p.length;
      }
      return out;
    };
    const timeMin = concat(timeParts);
    const tempC = concat(tempParts);
    const heatFlowMw = concat(hfParts);
    const heatFlowNormFile = haveNorm && hfNormParts.length === timeParts.length
      ? concat(hfNormParts)
      : undefined;

    const runIdPlaceholder = `${metadata.sampleName || fileName.replace(/\.[^.]+$/, "")}${runIndex > 0 ? `-${runIndex + 1}` : ""}`;
    const segments = buildSegments(runIdPlaceholder, tempC, timeMin, segmentBlocks);

    runs.push({
      label: runIdPlaceholder,
      meta: metadata,
      segments,
      timeMin,
      tempC,
      heatFlowMw,
      ...(heatFlowNormFile ? { heatFlowNormFile } : {}),
    });
  });

  if (runs.length === 0) {
    warnings.push(`${fileName}: no sample data found in any segment sheet.`);
    return { fileName, runs: [], warnings };
  }

  if (usedNormalized) {
    warnings.push(
      `${fileName}: Heat Flow (Normalized) is rounded to 3 decimal places (0.001 W/g) in the TRIOS Excel export — for full precision, drop the matching .tri file instead.`,
    );
  }

  return { fileName, runs, warnings };
}

/** Browser entry: parse a TRIOS Excel export into one or more DSC runs.
 *  Reads the bytes via SheetJS, then delegates to {@link parseTriosSheets}. */
export function parseTriosXls(buffer: ArrayBuffer | Uint8Array, fileName: string): ParsedDscFile {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const wb = XLSX.read(bytes, { type: "array" });
  return parseTriosSheets(workbookToSheets(wb), fileName);
}
