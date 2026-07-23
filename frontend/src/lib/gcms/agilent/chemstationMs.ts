// Parser for the Agilent ChemStation DATA.MS binary format.
//
// The format is documented byte-for-byte in the work-package spec; this file
// implements it literally. All integers are big-endian. The decode rules are
// absolute:
//   - m/z = mzRaw / 20 (constant divisor, never derived).
//   - abundance = (v & 0x3FFF) * 8 ** (v >>> 14) (top two bits are a base-8
//     exponent).
//   - TIC of a scan = the SUM of decoded abundances (the trailer u16 saturates
//     and must never be used).
//   - pairs are stored DESCENDING in m/z and must be reversed to ASCENDING.
//
// The parser is defensive: it never throws on malformed bytes. A record whose
// length is 0, or whose payload would run past the buffer end, stops the walk,
// pushes a warning, and returns what was decoded so far.

import type { MsRun, RunMeta } from "../types";

// --- helpers -----------------------------------------------------------------

/** Read a pascal string (1 length byte + N latin1 bytes) at `off`. */
function pascal(bytes: Uint8Array, off: number): string {
  if (off < 0 || off >= bytes.length) return "";
  const len = bytes[off];
  const start = off + 1;
  if (start + len > bytes.length) return "";
  let s = "";
  for (let i = 0; i < len; i += 1) s += String.fromCharCode(bytes[start + i]);
  return s;
}

/** True when `bytes` looks like a ChemStation DATA.MS file. */
export function isChemStationMs(bytes: Uint8Array): boolean {
  if (bytes.length >= 2) {
    const magic = (bytes[0] << 8) | bytes[1];
    if (magic === 0x0132) return true;
  }
  const head = bytes.subarray(0, Math.min(64, bytes.length));
  let s = "";
  for (let i = 0; i < head.length; i += 1) s += String.fromCharCode(head[i]);
  return s.includes("GC / MS D");
}

/** Decode a packed abundance u16: low 14 bits mantissa, top 2 bits base-8 exp. */
function decodeAbundance(v: number): number {
  return (v & 0x3fff) * 8 ** (v >>> 14);
}

// --- empty run ---------------------------------------------------------------

function emptyRun(name: string, sourcePath: string): MsRun {
  const meta: RunMeta = {};
  return {
    id: crypto.randomUUID(),
    name,
    sourcePath,
    format: "agilent-ms",
    detector: "ms",
    rtMin: new Float64Array(0),
    tic: new Float64Array(0),
    basePeakMz: new Float64Array(0),
    basePeakIntensity: new Float64Array(0),
    msLevel: new Uint8Array(0),
    scanOffset: new Uint32Array(1),
    mz: new Float64Array(0),
    intensity: new Float32Array(0),
    scanCount: 0,
    pointCount: 0,
    mzRange: [Infinity, -Infinity],
    rtRange: [Infinity, -Infinity],
    ticRange: [Infinity, -Infinity],
    meta,
    warnings: [],
  };
}

// --- main parser -------------------------------------------------------------

export function parseChemStationMs(
  buffer: ArrayBuffer,
  opts?: { name?: string; sourcePath?: string; onProgress?: (frac: number) => void },
): MsRun {
  const name = opts?.name ?? "DATA.MS";
  const sourcePath = opts?.sourcePath ?? "";
  const onProgress = opts?.onProgress;

  try {
    return parse(buffer, name, sourcePath, onProgress);
  } catch (err) {
    const run = emptyRun(name, sourcePath);
    run.warnings.push(
      `parseChemStationMs: unexpected error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return run;
  }
}

function parse(
  buffer: ArrayBuffer,
  name: string,
  sourcePath: string,
  onProgress?: (frac: number) => void,
): MsRun {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  const warnings: string[] = [];

  // A buffer too short to even contain the fixed header returns an empty run.
  if (bytes.length < 0x12a) {
    const r = emptyRun(name, sourcePath);
    r.warnings.push("parseChemStationMs: buffer shorter than 0x12A bytes");
    return r;
  }

  // --- header ---------------------------------------------------------------
  const headerScanCount = dv.getUint16(0x118, false);
  const dirWords = dv.getUint32(0x104, false);
  const dataWords = dv.getUint32(0x108, false);
  const dirBytes = 2 * dirWords - 2;
  const dataBytes = 2 * dataWords - 2;

  const meta: RunMeta = {};
  const setIf = (v: string | undefined, key: keyof RunMeta) => {
    if (v != null) {
      const t = v.trim();
      if (t.length > 0) (meta as Record<string, unknown>)[key as string] = t;
    }
  };
  setIf(pascal(bytes, 0x018), "sample");
  setIf(pascal(bytes, 0x094), "operator");
  setIf(pascal(bytes, 0x0b2), "acquiredDate");
  setIf(pascal(bytes, 0x0d0), "instrument");
  setIf(pascal(bytes, 0x0da), "inlet");
  setIf(pascal(bytes, 0x0e4), "method");

  // --- Pass 1: directories --------------------------------------------------
  // Directory A at dirBytes: { offsetWords, rtMs, tic } per scan.
  // Directory B at dirBytes + scanCount*12: { offsetWords, rtMs, basePeakAbund }.
  const dirAOff = dirBytes;
  const dirBOff = dirBytes + headerScanCount * 12;
  const dirAOk = dirAOff >= 0 && dirAOff + headerScanCount * 12 <= bytes.length;
  const dirBOk = dirBOff >= 0 && dirBOff + headerScanCount * 12 <= bytes.length;

  const rtMin = new Float64Array(headerScanCount);
  const dirTic = new Float64Array(headerScanCount);
  const basePeakIntensity = new Float64Array(headerScanCount);

  if (dirAOk) {
    for (let i = 0; i < headerScanCount; i += 1) {
      const base = dirAOff + i * 12;
      rtMin[i] = dv.getUint32(base + 4, false) / 60000;
      dirTic[i] = dv.getUint32(base + 8, false);
    }
  } else {
    warnings.push("parseChemStationMs: Directory A out of bounds; RT/TIC axes will come from records");
  }
  if (dirBOk) {
    for (let i = 0; i < headerScanCount; i += 1) {
      const base = dirBOff + i * 12;
      basePeakIntensity[i] = dv.getUint32(base + 8, false);
    }
  }

  // --- sizing pass over the records ----------------------------------------
  // Walk from dataBytes, accumulate total point count and validate scan count.
  const scanRecStart: number[] = [];
  const scanRecLen: number[] = [];
  const scanNpairs: number[] = [];
  let totalPoints = 0;
  let cur = dataBytes;
  let walked = 0;
  while (walked < headerScanCount) {
    if (cur + 2 > bytes.length) {
      warnings.push(`parseChemStationMs: scan ${walked} record header runs past buffer end; stopping walk`);
      break;
    }
    const lenWords = dv.getUint16(cur, false);
    if (lenWords === 0) {
      warnings.push(`parseChemStationMs: scan ${walked} has zero record length; stopping walk`);
      break;
    }
    const byteLen = 2 * lenWords;
    if (cur + byteLen > bytes.length) {
      warnings.push(`parseChemStationMs: scan ${walked} record (length ${byteLen}) runs past buffer end; stopping walk`);
      break;
    }
    const npairs = dv.getUint16(cur + 12, false);
    // sanity: the pairs must fit inside the record.
    if (18 + npairs * 4 > byteLen) {
      warnings.push(`parseChemStationMs: scan ${walked} npairs ${npairs} exceeds record length ${byteLen}; stopping walk`);
      break;
    }
    scanRecStart.push(cur);
    scanRecLen.push(byteLen);
    scanNpairs.push(npairs);
    totalPoints += npairs;
    walked += 1;
    cur += byteLen;
  }

  const scanCount = walked;
  if (scanCount !== headerScanCount) {
    warnings.push(
      `parseChemStationMs: header scanCount ${headerScanCount} disagrees with walked record count ${scanCount}`,
    );
  }

  // --- Pass 2: fill CSR arrays ---------------------------------------------
  // If the walk stopped early, trim the per-scan arrays to the walked count.
  const rtMinFinal = scanCount === headerScanCount ? rtMin : rtMin.subarray(0, scanCount);
  const dirTicFinal = scanCount === headerScanCount ? dirTic : dirTic.subarray(0, scanCount);
  const basePeakIntensityFinal =
    scanCount === headerScanCount ? basePeakIntensity : basePeakIntensity.subarray(0, scanCount);

  const scanOffset = new Uint32Array(scanCount + 1);
  const mz = new Float64Array(totalPoints);
  const intensity = new Float32Array(totalPoints);
  const basePeakMz = new Float64Array(scanCount);
  const tic = new Float64Array(scanCount);
  const msLevel = new Uint8Array(scanCount);

  let minMz = Infinity;
  let maxMz = -Infinity;
  let minTic = Infinity;
  let maxTic = -Infinity;
  let maxTicIdx = -1;
  let mismatchCount = 0;

  let pointCursor = 0;
  for (let i = 0; i < scanCount; i += 1) {
    const rec = scanRecStart[i];
    const npairs = scanNpairs[i];
    const bpmzRaw = dv.getUint16(rec + 14, false);
    basePeakMz[i] = bpmzRaw / 20;
    msLevel[i] = 1;

    let sumTic = 0;
    const pairBase = rec + 18;
    // Pairs are stored DESCENDING in m/z. Write them into the CSR store
    // in ASCENDING order by filling from the back of this scan's slice.
    const sliceStart = pointCursor;
    const sliceEnd = sliceStart + npairs;
    for (let p = 0; p < npairs; p += 1) {
      const mzRaw = dv.getUint16(pairBase + p * 4, false);
      const abRaw = dv.getUint16(pairBase + p * 4 + 2, false);
      const mzVal = mzRaw / 20;
      const abVal = decodeAbundance(abRaw);
      sumTic += abVal;
      // source is descending (p=0 is highest mz); destination ascending.
      mz[sliceEnd - 1 - p] = mzVal;
      intensity[sliceEnd - 1 - p] = abVal;
      if (mzVal < minMz) minMz = mzVal;
      if (mzVal > maxMz) maxMz = mzVal;
    }
    scanOffset[i] = sliceStart;
    pointCursor = sliceEnd;

    tic[i] = sumTic;
    if (sumTic < minTic) minTic = sumTic;
    if (sumTic > maxTic) {
      maxTic = sumTic;
      maxTicIdx = i;
    }

    // Fallback base-peak intensity from the record's packed u16 at +16 when
    // Directory B is missing/short.
    if (!dirBOk || i >= headerScanCount) {
      basePeakIntensityFinal[i] = decodeAbundance(dv.getUint16(rec + 16, false));
    }

    // Cross-check against Directory A's per-scan TIC.
    const dTic = dirTicFinal[i];
    if (dTic > 0) {
      const rel = Math.abs(sumTic - dTic) / dTic;
      if (rel > 0.01) mismatchCount += 1;
    }

    if (onProgress != null && (i % 200) === 0 && scanCount > 0) {
      try {
        onProgress(i / scanCount);
      } catch {
        /* ignore progress callback errors */
      }
    }
  }
  scanOffset[scanCount] = pointCursor;
  if (onProgress != null) {
    try {
      onProgress(1);
    } catch {
      /* ignore */
    }
  }

  if (mismatchCount > 0) {
    warnings.push(
      `TIC cross-check: ${mismatchCount} scans differ from the file directory by >1%`,
    );
  }

  // Suppress unused-variable lint for maxTicIdx diagnostic value: it is
  // intentionally computed to confirm the max-TIC scan but not stored on the
  // run (the caller derives it from `tic` if needed).
  void maxTicIdx;

  return {
    id: crypto.randomUUID(),
    name,
    sourcePath,
    format: "agilent-ms",
    detector: "ms",
    rtMin: rtMinFinal,
    tic,
    basePeakMz,
    basePeakIntensity: basePeakIntensityFinal,
    msLevel,
    scanOffset,
    mz,
    intensity,
    scanCount,
    pointCount: pointCursor,
    mzRange: totalPoints > 0 ? [minMz, maxMz] : [Infinity, -Infinity],
    rtRange: scanCount > 0 ? [rtMinFinal[0], rtMinFinal[scanCount - 1]] : [Infinity, -Infinity],
    ticRange: scanCount > 0 ? [minTic, maxTic] : [Infinity, -Infinity],
    meta,
    warnings,
  };
}