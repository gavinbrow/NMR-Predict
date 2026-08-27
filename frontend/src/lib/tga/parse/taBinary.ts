// TA Q50 raw binary parser (§2.2 of the plan).
//
// The file begins with the same UTF-16LE header text (without BOM handling),
// then a block of little-endian float32 TRIPLETS (time_min, temperature_C,
// weight_mg). The data block's start offset is not fixed — scan forward for the
// first offset where four consecutive triplets are all plausible
// (0 ≤ t < 1e4, 15 < T < 1200, 0 < w < 1e4) and t is strictly ascending. The
// series ends at a terminator triplet whose first value is -100.0; trailing
// garbage after it is ignored. The derivative column is not stored — DTG is
// computed downstream.
//
// Pure over a byte buffer so it is unit-testable without the DOM.

import { parseTaTextHeader, decodeTaText, buildMetadata } from "./taText";
import type { ParsedRun, ParsedTgaFile, TgaMetadata, TgaSegment } from "../types";

/** Plausibility window for a (time, temperature, weight) triplet. */
function plausible(t: number, T: number, w: number): boolean {
  return t >= 0 && t < 1e4 && T > 15 && T < 1500 && w >= 0 && w < 1e4;
}

/** Scan for the first offset where four consecutive triplets are all plausible
 *  and time is strictly ascending. The data block may start at ANY byte offset
 *  (the UTF-16LE header preamble is not 4-byte aligned), so we scan by 1-byte
 *  steps until we find the run, then read triplets from there. Returns -1 when
 *  no such run is found. */
export function findDataStart(dv: DataView, bytes: Uint8Array): number {
  for (let i = 0; i + 48 <= bytes.length; i += 1) {
    let prevT = -Infinity;
    let ok = true;
    for (let k = 0; k < 4; k++) {
      const t = dv.getFloat32(i + k * 12, true);
      const T = dv.getFloat32(i + k * 12 + 4, true);
      const w = dv.getFloat32(i + k * 12 + 8, true);
      if (!plausible(t, T, w) || !(t > prevT)) {
        ok = false;
        break;
      }
      prevT = t;
    }
    if (ok) return i;
  }
  return -1;
}

/** Parse a TA Q50 binary file (`DAC1.001`-style) into one run. Pure over the
 *  byte buffer. Reuses the TA text parser's header reader to pull metadata out
 *  of the UTF-16LE preamble. */
export function parseTaBinary(buffer: ArrayBuffer | Uint8Array, fileName: string): ParsedTgaFile {
  const warnings: string[] = [];
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The UTF-16LE header preamble carries metadata (Sample, Size, Operator, …).
  // Decode it and build metadata even though the data block is binary. The header
  // ends at a line equal to "StartOfData" — but in the binary file the marker may
  // not be present; decode what we can and tolerate a missing marker.
  let meta: Record<string, string | string[]> = {};
  try {
    const lines = decodeTaText(bytes);
    const parsed = parseTaTextHeader(lines);
    if (parsed.dataStartIndex >= 0) meta = parsed.meta;
  } catch {
    // Header decode failed — proceed with empty metadata; the binary scan is the
    // source of truth for the data.
  }
  const metadata: TgaMetadata = buildMetadata(meta, fileName);

  const start = findDataStart(dv, bytes);
  if (start < 0) {
    warnings.push(`${fileName}: could not locate the float32 data block.`);
    return { fileName, runs: [], warnings };
  }

  const timeMin: number[] = [];
  const tempC: number[] = [];
  const weightMg: number[] = [];
  for (let i = start; i + 12 <= bytes.length; i += 12) {
    const t = dv.getFloat32(i, true);
    // Terminator: a triplet whose first value is -100.0. Stop there.
    if (t === -100) break;
    const T = dv.getFloat32(i + 4, true);
    const w = dv.getFloat32(i + 8, true);
    if (!Number.isFinite(t) || !Number.isFinite(T) || !Number.isFinite(w)) break;
    timeMin.push(t);
    tempC.push(T);
    weightMg.push(w);
  }
  if (timeMin.length === 0) {
    warnings.push(`${fileName}: no data rows found after the scan offset.`);
    return { fileName, runs: [], warnings };
  }
  const segments: TgaSegment[] = metadata.methodSteps.length
    ? metadata.methodSteps.map((label) => ({ label }))
    : [{ label: "TGA" }];
  const run: ParsedRun = {
    label: metadata.sampleName || fileName.replace(/\.[^.]+$/, ""),
    meta: metadata,
    segments,
    timeMin: Float64Array.from(timeMin),
    tempC: Float64Array.from(tempC),
    weightMg: Float64Array.from(weightMg),
  };
  return { fileName, runs: [run], warnings };
}