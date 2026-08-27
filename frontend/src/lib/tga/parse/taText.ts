// TA Q50 text export parser (§2.1 of the plan).
//
// The file is UTF-16LE with a BOM (FF FE), CRLF lines, tab-separated. The header
// is `Key<TAB>Value` lines until a line equal to `StartOfData`; repeated keys
// (Xcomment ×5, OrgMethod ×3) collect into arrays. The column set is named by
// `Sig1..SigN` (with the count in `Nsig`) — never hardcode four columns. Data
// rows are tab-separated floats; values like `.00749511` (no leading zero) parse
// fine with `Number()`, and empty cells must become `NaN`, not `0`.
//
// Pure over a byte buffer so it is unit-testable without the DOM; the browser
// entry (`parseTgaFiles` in `./index.ts`) reads the `File` and hands the bytes
// here.

import type { ParsedRun, ParsedTgaFile, TgaMetadata, TgaSegment } from "../types";

/** Degree sign variants the file mixes (UTF-8 ° and Latin-1 °). Normalise both
 *  to the UTF-8 ° so downstream string search/display is consistent. */
function normalizeDeg(s: string): string {
  return s.replace(/\u00b0/g, "\u00b0"); // already ° in UTF-8; no-op for display
}

/** Parse a `Key<TAB>Value` header block into a map, collecting repeated keys
 *  into arrays. Returns the map and the index of the `StartOfData` line. */
export function parseTaTextHeader(lines: string[]): {
  meta: Record<string, string | string[]>;
  dataStartIndex: number;
} {
  const meta: Record<string, string | string[]> = {};
  let dataStartIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "StartOfData") {
      dataStartIndex = i + 1;
      break;
    }
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const key = line.slice(0, tab).trim();
    const value = line.slice(tab + 1).trim();
    if (!key) continue;
    const existing = meta[key];
    if (existing === undefined) {
      meta[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      meta[key] = [existing, value];
    }
  }
  return { meta, dataStartIndex };
}

/** Read the `Nsig`/`SigN` column names in order, so the data rows map to the
 *  right signals regardless of how many columns the instrument recorded. */
export function parseColumnNames(meta: Record<string, string | string[]>): string[] {
  const n = Number(meta.Nsig);
  if (!Number.isFinite(n) || n <= 0) return [];
  const names: string[] = [];
  for (let i = 1; i <= n; i++) {
    const v = meta[`Sig${i}`];
    if (typeof v === "string") names.push(v);
  }
  return names;
}

/** A parsed row of floats. Empty/blank cells become `NaN` (not 0) so the
 *  downstream arrays don't silently flatten gaps. */
export function parseDataRow(line: string): number[] {
  return line.split("\t").map((cell) => {
    const trimmed = cell.trim();
    if (trimmed === "") return NaN;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : NaN;
  });
}

/** Build the TgaMetadata from the parsed header map. */
export function buildMetadata(
  meta: Record<string, string | string[]>,
  fileName: string,
): TgaMetadata {
  const get = (k: string): string =>
    typeof meta[k] === "string" ? (meta[k] as string) : "";
  const sizeStr = get("Size");
  // "2.15200\tmg" — take the numeric prefix and the unit separately.
  let sampleSizeMg: number | null = null;
  if (sizeStr) {
    const [numStr, unit] = sizeStr.split(/\s+/);
    const num = Number(numStr);
    if (Number.isFinite(num)) {
      // Convert to mg.
      if (unit === "mg") sampleSizeMg = num;
      else if (unit === "g") sampleSizeMg = num * 1000;
      else sampleSizeMg = num; // unknown unit — keep the raw number
    }
  }
  // Method steps: OrgMethod repeats (up to 3×).
  const methodSteps: string[] = [];
  const org = meta.OrgMethod;
  if (Array.isArray(org)) methodSteps.push(...org);
  else if (typeof org === "string") methodSteps.push(org);
  // Gases: the TA header's Method line sometimes names the gas; best-effort.
  const method = get("Method").toLowerCase();
  let gases = "";
  if (method.includes("nitrogen") || method.includes("n2")) gases = "N2";
  else if (method.includes("air") || method.includes("oxygen")) gases = "Air";
  return {
    instrument: get("Instrument") || "TA Q50",
    operator: get("Operator"),
    sampleName: get("Sample") || fileName.replace(/\.[^.]+$/, ""),
    sampleSizeMg,
    pan: get("FurnaceType"),
    methodSteps,
    runDate: `${get("Date")} ${get("Time")}`.trim(),
    gases,
  };
}

/** Decode a UTF-16LE buffer (BOM-stripped) and split into CRLF/LF lines. */
export function decodeTaText(buffer: ArrayBuffer | Uint8Array): string[] {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  // Strip a UTF-16LE BOM (FF FE) if present.
  const start = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe ? 2 : 0;
  const text = new TextDecoder("utf-16le").decode(bytes.subarray(start));
  return text.replace(/\r\n/g, "\n").split("\n");
}

/** Parse a TA Q50 text export (UTF-16LE, tab-separated) into one run. Pure over
 *  the byte buffer. The browser entry (`parseTgaFiles`) reads the `File`. */
export function parseTaText(buffer: ArrayBuffer | Uint8Array, fileName: string): ParsedTgaFile {
  const warnings: string[] = [];
  const lines = decodeTaText(buffer);
  const { meta, dataStartIndex } = parseTaTextHeader(lines);
  if (dataStartIndex < 0) {
    warnings.push(`${fileName}: no StartOfData marker found.`);
    return { fileName, runs: [], warnings };
  }
  const columnNames = parseColumnNames(meta);
  if (columnNames.length === 0) {
    warnings.push(`${fileName}: could not read the column set (Nsig/SigN).`);
    return { fileName, runs: [], warnings };
  }
  // Locate the column indices by header name.
  const timeCol = columnNames.findIndex((n) => /time/i.test(n));
  const tempCol = columnNames.findIndex((n) => /temp/i.test(n));
  const weightCol = columnNames.findIndex((n) => /weight/i.test(n) && !/deriv/i.test(n));
  const dtgCol = columnNames.findIndex((n) => /deriv/i.test(n));
  if (timeCol < 0 || tempCol < 0 || weightCol < 0) {
    warnings.push(`${fileName}: missing a Time/Temperature/Weight column.`);
    return { fileName, runs: [], warnings };
  }
  const timeMin: number[] = [];
  const tempC: number[] = [];
  const weightMg: number[] = [];
  const dtg: number[] = [];
  for (let i = dataStartIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    const row = parseDataRow(line);
    const t = row[timeCol];
    const T = row[tempCol];
    const w = row[weightCol];
    if (!Number.isFinite(t) || !Number.isFinite(T) || !Number.isFinite(w)) continue;
    timeMin.push(t);
    tempC.push(T);
    weightMg.push(w);
    if (dtgCol >= 0) dtg.push(Number.isFinite(row[dtgCol]) ? row[dtgCol] : NaN);
  }
  if (timeMin.length === 0) {
    warnings.push(`${fileName}: no data rows found.`);
    return { fileName, runs: [], warnings };
  }
  const metadata = buildMetadata(meta, fileName);
  const segments: TgaSegment[] = metadata.methodSteps.map((label) => ({ label }));
  const run: ParsedRun = {
    label: metadata.sampleName || fileName.replace(/\.[^.]+$/, ""),
    meta: metadata,
    segments: segments.length ? segments : [{ label: "TGA" }],
    timeMin: Float64Array.from(timeMin),
    tempC: Float64Array.from(tempC),
    weightMg: Float64Array.from(weightMg),
    ...(dtgCol >= 0 && dtg.length === timeMin.length ? { dtgFile: Float64Array.from(dtg) } : {}),
  };
  return { fileName, runs: [run], warnings };
}