// TA Q-series raw binary parser for DSC (§2.4 of the plan).
//
// ⚠️ No Q-series DSC sample file exists. The file begins with the same
// UTF-16LE `Key<TAB>Value` header text TGA's binary reader decodes (reusing
// `decodeTaText`/`parseTaTextHeader`/`parseColumnNames` from
// `lib/tga/parse/taText.ts` UNCHANGED), then a block of little-endian
// float32 TUPLES. Unlike TGA's binary — which is always a fixed
// (time, temperature, weight) TRIPLET, so `lib/tga/parse/taBinary.ts`'s
// `findDataStart` hardcodes a 12-byte stride — a DSC export's tuple width
// depends on how many signals the method recorded (`Nsig`), so this module
// has its OWN width-aware `findDataStart` rather than reusing TGA's; the
// column order within a tuple is read from `Sig1..SigN`, never assumed.
//
// Guarded per the plan: require ≥4 consecutive plausible tuples
// (`0 ≤ t < 1e4`, `−200 < T < 800`, `|heatFlow| < 1e4`) before trusting an
// offset, and on any failure return a friendly warning rather than throw.
// This path is covered only by hand-built fixtures in `parsers.test.ts` — say
// so again at the call site as a reminder to future readers.

import { decodeTaText, parseTaTextHeader, parseColumnNames } from "@/lib/tga/parse/taText";
import { buildTaDscMetadata } from "./taText";
import { buildSegments } from "../segments";
import type { ParsedDscFile, ParsedDscRun } from "../types";

/** A denormal-magnitude value is bit-pattern noise, not a real reading — the
 *  same wisdom `triosTri.ts`'s `isFlagArray` discriminator uses. Re-scanning
 *  the UTF-16LE header preamble as arbitrary float32 tuples otherwise finds
 *  "plausible" runs of tiny monotonically-increasing denormals purely by
 *  chance (ASCII text bytes reinterpreted as floats trend this way), well
 *  before the real data block. 0 itself is always realistic. */
function isRealisticMagnitude(v: number): boolean {
  return v === 0 || Math.abs(v) > 1e-6;
}

/** Plausibility window for one (time, temperature, heatFlow) reading within a
 *  tuple. `hasHeatFlow` is false when no Heat Flow signal was found — the
 *  column is then not read or checked at all. */
function plausible(t: number, T: number, heatFlow: number, hasHeatFlow: boolean): boolean {
  if (!Number.isFinite(t) || !isRealisticMagnitude(t) || !(t >= 0 && t < 1e4)) return false;
  if (!Number.isFinite(T) || !isRealisticMagnitude(T) || !(T > -200 && T < 800)) return false;
  if (hasHeatFlow) {
    if (!Number.isFinite(heatFlow) || !isRealisticMagnitude(heatFlow)) return false;
    if (Math.abs(heatFlow) >= 1e4) return false;
  }
  return true;
}

/**
 * Scan for the first byte offset where 4 consecutive `width`-wide float32
 * tuples are all plausible and `time` is strictly ascending. `timeCol`/
 * `tempCol`/`heatFlowCol` are 0-based indices within each tuple (`heatFlowCol
 * < 0` when no Heat Flow signal was found). Returns -1 when no such run
 * exists. Scans byte-by-byte: the UTF-16LE header preamble is not aligned to
 * the tuple width.
 */
export function findDataStart(
  dv: DataView,
  bytes: Uint8Array,
  width: number,
  timeCol: number,
  tempCol: number,
  heatFlowCol: number,
): number {
  if (width <= 0 || timeCol < 0 || tempCol < 0) return -1;
  const tupleBytes = width * 4;
  const need = tupleBytes * 4; // 4 consecutive tuples
  const hasHeatFlow = heatFlowCol >= 0;
  for (let i = 0; i + need <= bytes.length; i++) {
    let prevT = -Infinity;
    let ok = true;
    for (let k = 0; k < 4; k++) {
      const base = i + k * tupleBytes;
      const t = dv.getFloat32(base + timeCol * 4, true);
      const T = dv.getFloat32(base + tempCol * 4, true);
      const hf = hasHeatFlow ? dv.getFloat32(base + heatFlowCol * 4, true) : NaN;
      if (!plausible(t, T, hf, hasHeatFlow) || !(t > prevT)) {
        ok = false;
        break;
      }
      prevT = t;
    }
    if (ok) return i;
  }
  return -1;
}

/** Unit alias from a `SigN` column name's own text — same convention as
 *  `taText.ts`'s reader, duplicated locally to keep this module independent. */
function heatFlowUnitFromName(name: string): "mW" | "W" {
  const h = name.toLowerCase();
  return h.includes("w") && !h.includes("mw") ? "W" : "mW";
}

/** Parse a TA Q-series binary export into one DSC run. Pure over the byte
 *  buffer; never throws — every failure becomes a warning string. */
export function parseTaBinary(buffer: ArrayBuffer | Uint8Array, fileName: string): ParsedDscFile {
  const warnings: string[] = [];
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let meta: Record<string, string | string[]> = {};
  try {
    const lines = decodeTaText(bytes);
    const parsed = parseTaTextHeader(lines);
    if (parsed.dataStartIndex >= 0) meta = parsed.meta;
  } catch {
    // Header decode failed — proceed with empty metadata; the binary scan
    // below is the source of truth for the numeric data either way.
  }
  const metadata = buildTaDscMetadata(meta, fileName);

  const columnNames = parseColumnNames(meta);
  if (columnNames.length === 0) {
    warnings.push(
      `${fileName}: couldn't read the TA binary. Export it as text and drop that instead.`,
    );
    return { fileName, runs: [], warnings };
  }
  const timeCol = columnNames.findIndex((n) => /time/i.test(n));
  const tempCol = columnNames.findIndex((n) => /temp/i.test(n));
  const heatFlowCol = columnNames.findIndex((n) => /heat flow/i.test(n));
  if (timeCol < 0 || tempCol < 0) {
    warnings.push(
      `${fileName}: couldn't read the TA binary. Export it as text and drop that instead.`,
    );
    return { fileName, runs: [], warnings };
  }
  const width = columnNames.length;

  const start = findDataStart(dv, bytes, width, timeCol, tempCol, heatFlowCol);
  if (start < 0) {
    warnings.push(
      `${fileName}: couldn't read the TA binary. Export it as text and drop that instead.`,
    );
    return { fileName, runs: [], warnings };
  }

  const heatFlowUnit = heatFlowCol >= 0 ? heatFlowUnitFromName(columnNames[heatFlowCol]) : "mW";
  const tupleBytes = width * 4;
  const timeMin: number[] = [];
  const tempC: number[] = [];
  const heatFlowMw: number[] = [];
  for (let i = start; i + tupleBytes <= bytes.length; i += tupleBytes) {
    const t = dv.getFloat32(i + timeCol * 4, true);
    if (t === -100) break; // TGA's binary terminator convention; harmless if absent here
    const T = dv.getFloat32(i + tempCol * 4, true);
    if (!Number.isFinite(t) || !Number.isFinite(T)) break;
    const hf = heatFlowCol >= 0 ? dv.getFloat32(i + heatFlowCol * 4, true) : NaN;
    timeMin.push(t);
    tempC.push(T);
    heatFlowMw.push(Number.isFinite(hf) ? (heatFlowUnit === "W" ? hf * 1000 : hf) : NaN);
  }
  if (timeMin.length === 0) {
    warnings.push(`${fileName}: no data rows found after the scan offset.`);
    return { fileName, runs: [], warnings };
  }

  const timeArr = Float64Array.from(timeMin);
  const tempArr = Float64Array.from(tempC);
  const segments = buildSegments(metadata.sampleName || fileName, tempArr, timeArr, [
    { start: 0, end: timeArr.length, label: "Run" },
  ]);
  const run: ParsedDscRun = {
    label: metadata.sampleName || fileName.replace(/\.[^.]+$/, ""),
    meta: metadata,
    segments,
    timeMin: timeArr,
    tempC: tempArr,
    heatFlowMw: Float64Array.from(heatFlowMw),
  };
  return { fileName, runs: [run], warnings };
}
