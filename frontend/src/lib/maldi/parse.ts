// CSV/TXT parsing for MALDI spectra.
//
// The priority (and currently only) import format is a two-column text export of
// m/z vs intensity, as produced by flexAnalysis, Data Explorer, mMass, and most
// "export as text" buttons. The challenge is that those exports vary wildly:
// comma / tab / semicolon / whitespace delimiters, optional header rows, comment
// lines, and occasionally comma decimal separators. This module sniffs all of
// that so a user can usually just drop a file in, while still exposing explicit
// overrides for the awkward cases.

import type { SpectrumData } from "./types";

export type Delimiter = "comma" | "tab" | "semicolon" | "space";

export interface ParseOptions {
  /** Field separator; "auto" sniffs it from the data. */
  delimiter?: Delimiter | "auto";
  /** Whether the first non-comment row is a header; "auto" detects it. */
  hasHeader?: boolean | "auto";
  /** Zero-based column index for m/z (default 0). */
  mzColumn?: number;
  /** Zero-based column index for intensity (default 1). */
  intensityColumn?: number;
  /** Treat "," as the decimal mark (European exports). "auto" infers it. */
  decimalComma?: boolean | "auto";
}

export interface ParseMeta {
  delimiter: Delimiter;
  hasHeader: boolean;
  decimalComma: boolean;
  columnCount: number;
  /** Number of data points kept. */
  rowCount: number;
  /** Rows dropped because they did not contain two finite numbers. */
  skippedRows: number;
  /** Whether the m/z column had to be sorted ascending. */
  resorted: boolean;
}

export interface ParseResult {
  spectrum: SpectrumData;
  meta: ParseMeta;
}

const DELIMITER_CHARS: Record<Delimiter, string> = {
  comma: ",",
  tab: "\t",
  semicolon: ";",
  space: " ",
};

/** A line is a comment if it starts with a conventional comment marker. */
function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("#") || t.startsWith("//") || t.startsWith("%") || t.startsWith(";;");
}

/** Split a line on a delimiter, collapsing runs of whitespace for "space". */
function splitLine(line: string, delimiter: Delimiter): string[] {
  if (delimiter === "space") {
    return line.trim().split(/\s+/);
  }
  return line.split(DELIMITER_CHARS[delimiter]).map((field) => field.trim());
}

/**
 * Pick the delimiter that most consistently yields ≥2 columns across the sample
 * lines. We score each candidate by how often it produces the same (>1) column
 * count, which reliably distinguishes a real separator from incidental commas.
 */
function sniffDelimiter(sampleLines: string[]): Delimiter {
  const candidates: Delimiter[] = ["tab", "comma", "semicolon", "space"];
  let best: Delimiter = "space";
  let bestScore = -1;

  for (const candidate of candidates) {
    const counts = sampleLines.map((line) => splitLine(line, candidate).length);
    const multi = counts.filter((c) => c >= 2);
    if (multi.length === 0) continue;
    // Reward consistency: the modal column count's frequency among multi-column rows.
    const freq = new Map<number, number>();
    for (const c of multi) freq.set(c, (freq.get(c) ?? 0) + 1);
    const modalFreq = Math.max(...freq.values());
    const score = multi.length + modalFreq;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** Parse a numeric field, honoring a comma decimal mark when requested. */
function toNumber(field: string, decimalComma: boolean): number {
  if (!field) return NaN;
  const normalized = decimalComma ? field.replace(/\./g, "").replace(",", ".") : field;
  return Number(normalized);
}

/** A row "looks numeric" if both target columns parse to finite numbers. */
function rowIsNumeric(fields: string[], mzCol: number, intCol: number, decimalComma: boolean): boolean {
  return (
    Number.isFinite(toNumber(fields[mzCol] ?? "", decimalComma)) &&
    Number.isFinite(toNumber(fields[intCol] ?? "", decimalComma))
  );
}

/**
 * Parse a CSV/TXT spectrum into parallel Float64Arrays. Sniffs the delimiter,
 * header presence, and decimal mark unless overridden. Throws if no usable
 * numeric rows are found so the caller can surface a clear import error.
 */
export function parseSpectrumText(text: string, options: ParseOptions = {}): ParseResult {
  const allLines = text.split(/\r\n|\r|\n/);
  const lines = allLines.filter((line) => line.trim().length > 0 && !isCommentLine(line));
  if (lines.length === 0) {
    throw new Error("No data rows found in file.");
  }

  const sample = lines.slice(0, Math.min(50, lines.length));
  const delimiter: Delimiter =
    options.delimiter && options.delimiter !== "auto" ? options.delimiter : sniffDelimiter(sample);

  // Decide the decimal mark. With a comma delimiter a comma can't also be the
  // decimal mark, so only sniff it for non-comma delimiters.
  let decimalComma: boolean;
  if (options.decimalComma === true || options.decimalComma === false) {
    decimalComma = options.decimalComma;
  } else if (delimiter === "comma") {
    decimalComma = false;
  } else {
    // If a comma appears but no dot in the numeric fields, assume comma decimals.
    const joined = sample.join("\n");
    decimalComma = joined.includes(",") && !joined.includes(".");
  }

  const mzCol = options.mzColumn ?? 0;
  const intCol = options.intensityColumn ?? 1;

  // Header detection: the first row is a header if it does NOT parse as numeric
  // but the following rows do.
  let hasHeader: boolean;
  if (options.hasHeader === true || options.hasHeader === false) {
    hasHeader = options.hasHeader;
  } else {
    const first = splitLine(lines[0], delimiter);
    hasHeader = !rowIsNumeric(first, mzCol, intCol, decimalComma);
  }

  const dataLines = hasHeader ? lines.slice(1) : lines;

  const mzList: number[] = [];
  const intList: number[] = [];
  let skippedRows = 0;
  let columnCount = 0;

  for (const line of dataLines) {
    const fields = splitLine(line, delimiter);
    columnCount = Math.max(columnCount, fields.length);
    const mz = toNumber(fields[mzCol] ?? "", decimalComma);
    const intensity = toNumber(fields[intCol] ?? "", decimalComma);
    if (!Number.isFinite(mz) || !Number.isFinite(intensity)) {
      skippedRows += 1;
      continue;
    }
    mzList.push(mz);
    intList.push(intensity);
  }

  if (mzList.length === 0) {
    throw new Error(
      `Parsed 0 numeric rows (delimiter: ${delimiter}). Check the delimiter and column settings.`,
    );
  }

  // Ensure the m/z axis is strictly ascending — most processing assumes it.
  let resorted = false;
  for (let i = 1; i < mzList.length; i += 1) {
    if (mzList[i] < mzList[i - 1]) {
      resorted = true;
      break;
    }
  }

  let mz: Float64Array;
  let intensity: Float64Array;
  if (resorted) {
    const order = Array.from(mzList.keys()).sort((a, b) => mzList[a] - mzList[b]);
    mz = new Float64Array(order.length);
    intensity = new Float64Array(order.length);
    order.forEach((srcIndex, dstIndex) => {
      mz[dstIndex] = mzList[srcIndex];
      intensity[dstIndex] = intList[srcIndex];
    });
  } else {
    mz = Float64Array.from(mzList);
    intensity = Float64Array.from(intList);
  }

  return {
    spectrum: { mz, intensity },
    meta: {
      delimiter,
      hasHeader,
      decimalComma,
      columnCount,
      rowCount: mz.length,
      skippedRows,
      resorted,
    },
  };
}
