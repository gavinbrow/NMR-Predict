// Parser for Waters MassLynx `.raw` acquisitions.
//
// A Waters `.raw` is a FOLDER, not a file. The members this parser reads are:
//   _HEADER.TXT   text, `$$ Key: Value` lines — sample/instrument/calibration
//   _extern.inf   text, `Key<TAB>Value` lines — tune page + per-function method
//   _FUNCTNS.INF  binary, one fixed-size record per acquisition function
//   _FUNCnnn.IDX  binary, one fixed-size record per scan (the scan directory)
//   _FUNCnnn.DAT  binary, the packed points, concatenated scan after scan
//
// Everything below was reverse-engineered from a SYNAPT XS acquisition and
// validated against the vendor-processed spectrum of the same scan. The decode
// rules are absolute:
//
//   IDX record (30 bytes, little-endian):
//     +4  u32  bitfield: point count in the low 22 bits, flags above it.
//              Bit 30 set => the scan's masses are already CALIBRATED.
//     +8  f32  TIC
//     +12 f32  retention time, minutes
//     +22 u64  byte offset of the scan's points in the .DAT
//
//   DAT point, 8 bytes (continuum) or 12 bytes (centroid). Both start with the
//   same two block-float words; the centroid form adds a third word (peak
//   width/area diagnostics) that this parser ignores:
//     w0  intensity = (w0 & 0x3FFFFF)  * 2 ** (((w0 >>> 22) & 0x1F) - 21)
//     w1  m/z       = (w1 & 0x7FFFFFF) * 2 ** ( (w1 >>> 27)         - 27)
//
// The intensity exponent is FIVE bits wide; w0's top five bits are flags, set
// only on the handful of samples at the apex of a saturating peak. Masking them
// in as exponent bits is the difference between an intensity of 1e46 and the
// real one, and it only shows up on the most intense peak of the most intense
// scan — so do not "simplify" the mask away.
//
// Both rules are exact, not approximate: on continuum data the decoded
// intensities of every scan sum to the IDX's own TIC to within the f32
// precision the TIC is stored at, and the decoded m/z axis lands on the
// acquisition's stated mass range. Do not "round" or rescale them. (A centroid
// function's TIC is a different quantity — MassLynx computes centroid areas
// against a subtracted baseline — so that cross-check applies to continuum
// data only.)
//
// Scans whose calibrated-masses flag is CLEAR carry raw flight-time-derived
// masses and need the `Cal Function N` polynomial from _HEADER.TXT applied as
//   m_cal = (SUM ci * sqrt(m_raw) ** i) ** 2
// which on the reference function moves the lock mass from 476 ppm off to
// 34 ppm off (the residue is the lockspray correction the vendor applies
// separately, which this parser does not attempt).
//
// The parser is defensive: a malformed member degrades to a warning on the run
// rather than throwing, and the IDX record size / DAT bytes-per-point are
// DETECTED (and cross-checked against the .DAT's exact byte length) rather than
// assumed, so other MassLynx versions either work or fail loudly.

import type { MsRun, RunMeta } from "../types";
import { centroidProfile } from "../centroid";

// --- constants ---------------------------------------------------------------

/** IDX record sizes seen in the wild, most recent first. */
const IDX_RECORD_SIZES = [30, 22] as const;
/** Point sizes this parser can decode. */
const SUPPORTED_POINT_SIZES = new Set([8, 12]);
/** Bit 30 of the IDX bitfield: the scan's masses are already calibrated. */
const FLAG_CALIBRATED_MASSES = 1 << 30;

/** 2 ** (e - 21) for every value of the intensity word's 5-bit exponent. */
const INTENSITY_SCALE = (() => {
  const t = new Float64Array(32);
  for (let e = 0; e < 32; e += 1) t[e] = Math.pow(2, e - 21);
  return t;
})();
/** 2 ** (e - 27) for every m/z exponent a 5-bit field can hold. */
const MZ_SCALE = (() => {
  const t = new Float64Array(32);
  for (let e = 0; e < 32; e += 1) t[e] = Math.pow(2, e - 27);
  return t;
})();

const EMPTY_F64 = new Float64Array(0);
const EMPTY_F32 = new Float32Array(0);

// --- inputs ------------------------------------------------------------------

/** The members of ONE `.raw` folder, as collected by the loader. */
export interface WatersRawBundle {
  /** The `.raw` folder's own name, e.g. `"6169_DAC_3.raw"`. */
  folderName: string;
  /** Relative path of the folder, for the panel's title line. */
  sourcePath: string;
  headerTxt?: string | null;
  externInf?: string | null;
  functnsInf?: ArrayBuffer | null;
  /** Function number (1-based, from the file name) -> its payload files. */
  functions: Map<number, { idx?: ArrayBuffer | null; dat?: ArrayBuffer | null }>;
}

export interface WatersParseOptions {
  /**
   * Reduce continuum (profile) functions to centroids while decoding. Default
   * true, because raw continuum m/z values do NOT match vendor peak lists and
   * a profile LC run is far too large to hold in memory otherwise. Already
   * centroided functions are never touched.
   */
  centroid?: boolean;
  /** Passed to {@link centroidProfile}: drop peaks below this fraction of base. */
  centroidRelThreshold?: number;
  /**
   * Point budget for `centroid: false`. A profile run bigger than this is
   * centroided anyway and a warning is recorded, rather than exhausting memory.
   */
  maxProfilePoints?: number;
  onProgress?: (frac: number, msg?: string) => void;
}

const DEFAULT_MAX_PROFILE_POINTS = 24_000_000;

// --- text members ------------------------------------------------------------

/** Decode Latin-1/CP1252 bytes; MassLynx writes degree and micro signs raw. */
export function decodeWatersText(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder("windows-1252").decode(buffer);
  } catch {
    return new TextDecoder("latin1", { fatal: false }).decode(buffer);
  }
}

/** `_HEADER.TXT`: `$$ Key: Value` lines. Values may themselves contain colons. */
export function parseWatersHeader(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.startsWith("$$") ? rawLine.slice(2) : rawLine;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    if (key.length === 0) continue;
    out.set(key, line.slice(colon + 1).trim());
  }
  return out;
}

/** One function's block out of `_extern.inf`. */
export interface ExternFunction {
  /** The heading's trailing label, e.g. `"TOF MS FUNCTION"` or `"REFERENCE"`. */
  type: string;
  params: Map<string, string>;
}

/**
 * `_extern.inf`: tab-separated `Key<TAB><TAB>Value` lines, split into a global
 * block and one block per `Function Parameters - Function N - TYPE` heading.
 */
export function parseWatersExtern(text: string): {
  global: Map<string, string>;
  functions: Map<number, ExternFunction>;
} {
  const global = new Map<string, string>();
  const functions = new Map<number, ExternFunction>();
  let current: Map<string, string> = global;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const heading = /^Function Parameters\s*-\s*Function\s+(\d+)\s*-\s*(.*)$/i.exec(line.trim());
    if (heading) {
      const fn = Number.parseInt(heading[1], 10);
      const entry: ExternFunction = { type: heading[2].trim(), params: new Map() };
      functions.set(fn, entry);
      current = entry.params;
      continue;
    }
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const key = line.slice(0, tab).trim();
    const value = line.slice(tab).trim();
    if (key.length === 0 || value.length === 0) continue;
    // First writer wins inside a block: MassLynx repeats some tune keys.
    if (!current.has(key)) current.set(key, value);
  }
  return { global, functions };
}

// --- _FUNCTNS.INF ------------------------------------------------------------

export interface FunctionInfo {
  cycleTimeSec?: number;
  interScanDelaySec?: number;
  startRtMin?: number;
  endRtMin?: number;
  startMass?: number;
  endMass?: number;
}

/**
 * `_FUNCTNS.INF`: fixed-size records, one per function. Only the fields this
 * viewer surfaces are read, and every one is bounds-checked — an unexpected
 * record size just yields an empty list and the `_extern.inf` text wins.
 */
export function parseWatersFunctions(buffer: ArrayBuffer): FunctionInfo[] {
  const size = 416;
  if (buffer.byteLength === 0 || buffer.byteLength % size !== 0) return [];
  const dv = new DataView(buffer);
  const finite = (v: number): number | undefined =>
    Number.isFinite(v) && Math.abs(v) < 1e9 ? v : undefined;
  const out: FunctionInfo[] = [];
  for (let base = 0; base + size <= buffer.byteLength; base += size) {
    out.push({
      cycleTimeSec: finite(dv.getFloat32(base + 2, true)),
      interScanDelaySec: finite(dv.getFloat32(base + 6, true)),
      startRtMin: finite(dv.getFloat32(base + 10, true)),
      endRtMin: finite(dv.getFloat32(base + 14, true)),
      startMass: finite(dv.getFloat32(base + 0xa0, true)),
      endMass: finite(dv.getFloat32(base + 0x120, true)),
    });
  }
  return out;
}

// --- _FUNCnnn.IDX ------------------------------------------------------------

export interface ScanIndexEntry {
  pointCount: number;
  flags: number;
  tic: number;
  rtMin: number;
  /** Byte offset of this scan's points in the .DAT. */
  offset: number;
  /** True when the scan's masses already carry the calibration. */
  calibrated: boolean;
}

export interface ScanIndex {
  entries: ScanIndexEntry[];
  recordSize: number;
  bytesPerPoint: number;
  warnings: string[];
}

/**
 * Decode a scan directory. The IDX record size and the .DAT's bytes-per-point
 * are both unknown up front, so every candidate record size is tried and the
 * one whose total point count divides the .DAT's byte length EXACTLY into a
 * supported point size wins. That single check is decisive — a wrong record
 * size mis-reads the point counts and essentially never divides evenly.
 */
export function parseWatersIndex(
  idxBuffer: ArrayBuffer,
  datByteLength: number,
): ScanIndex | null {
  for (const recordSize of IDX_RECORD_SIZES) {
    if (idxBuffer.byteLength === 0 || idxBuffer.byteLength % recordSize !== 0) continue;
    const count = idxBuffer.byteLength / recordSize;
    const dv = new DataView(idxBuffer);

    let totalPoints = 0;
    let rtOk = true;
    let lastRt = -Infinity;
    const raw: {
      pointCount: number;
      flags: number;
      tic: number;
      rtMin: number;
      offset: number;
    }[] = [];
    for (let i = 0; i < count; i += 1) {
      const base = i * recordSize;
      const bitfield = dv.getUint32(base + 4, true);
      const pointCount = bitfield & 0x3fffff;
      const tic = dv.getFloat32(base + 8, true);
      const rtMin = dv.getFloat32(base + 12, true);
      // The offset is a 64-bit field, read as two u32s: a .DAT never approaches
      // 2**53 bytes, so the arithmetic stays exact.
      let offset = 0;
      if (recordSize >= 30) {
        offset = dv.getUint32(base + 22, true) + dv.getUint32(base + 26, true) * 4294967296;
      }
      if (!Number.isFinite(rtMin) || rtMin < lastRt - 1e-6) rtOk = false;
      lastRt = rtMin;
      totalPoints += pointCount;
      raw.push({ pointCount, flags: bitfield, tic, rtMin, offset });
    }

    if (!rtOk || totalPoints <= 0) continue;
    if (datByteLength % totalPoints !== 0) continue;
    const bytesPerPoint = datByteLength / totalPoints;
    if (!SUPPORTED_POINT_SIZES.has(bytesPerPoint)) continue;

    // Prefer the stored offsets, but only once they agree with the offsets the
    // point counts imply. They are the same number on every file seen so far;
    // if a variant disagrees, the derived offsets are the provable ones.
    const warnings: string[] = [];
    let cursor = 0;
    let storedOk = recordSize >= 30;
    const entries: ScanIndexEntry[] = raw.map((r) => {
      const derived = cursor;
      cursor += r.pointCount * bytesPerPoint;
      if (storedOk && r.offset !== derived) storedOk = false;
      return {
        pointCount: r.pointCount,
        flags: r.flags,
        tic: r.tic,
        rtMin: r.rtMin,
        offset: derived,
        calibrated: (r.flags & FLAG_CALIBRATED_MASSES) !== 0,
      };
    });
    if (recordSize >= 30 && !storedOk) {
      warnings.push(
        "scan index offsets disagree with the point counts; using the derived offsets",
      );
    }
    return { entries, recordSize, bytesPerPoint, warnings };
  }
  return null;
}

// --- calibration -------------------------------------------------------------

/** Parse `Cal Function N: c0,c1,...,T1` into its numeric coefficients. */
export function parseCalCoefficients(value: string | undefined): number[] | null {
  if (!value) return null;
  const nums: number[] = [];
  for (const part of value.split(",")) {
    const t = part.trim();
    if (t.length === 0) continue;
    const v = Number.parseFloat(t);
    // The trailing `T1`/`T0` token parses as NaN and ends the coefficient list.
    if (!Number.isFinite(v)) break;
    nums.push(v);
  }
  return nums.length >= 2 ? nums : null;
}

/** Apply a MassLynx mass-calibration polynomial: `m = (SUM ci * sqrt(m) ** i) ** 2`. */
export function applyCalibration(mzRaw: number, coeffs: number[]): number {
  const x = Math.sqrt(mzRaw);
  let acc = 0;
  let p = 1;
  for (let i = 0; i < coeffs.length; i += 1) {
    acc += coeffs[i] * p;
    p *= x;
  }
  return acc * acc;
}

// --- metadata ----------------------------------------------------------------

function num(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const v = Number.parseFloat(value);
  return Number.isFinite(v) ? v : undefined;
}

/** Map `ES+` / `ES-` / `EI+` ... onto the viewer's ionization + polarity pair. */
function readPolarity(value: string | undefined): {
  ionization?: RunMeta["ionization"];
  polarity?: RunMeta["polarity"];
} {
  if (!value) return {};
  const v = value.trim().toUpperCase();
  const polarity: RunMeta["polarity"] = v.includes("-") ? "-" : v.includes("+") ? "+" : null;
  let ionization: RunMeta["ionization"] = "unknown";
  if (v.startsWith("ES")) ionization = "ESI";
  else if (v.startsWith("AP")) ionization = "APCI";
  else if (v.startsWith("EI")) ionization = "EI";
  else if (v.startsWith("CI")) ionization = "CI";
  return { ionization, polarity };
}

function buildMeta(
  header: Map<string, string>,
  extern: { global: Map<string, string>; functions: Map<number, ExternFunction> },
  fnNumber: number,
  fnInfo: FunctionInfo | undefined,
): RunMeta {
  const fn = extern.functions.get(fnNumber);
  const g = extern.global;
  const p = (k: string) => fn?.params.get(k) ?? g.get(k);

  const acquiredDate = [header.get("Acquired Date"), header.get("Acquired Time")]
    .filter((s) => s != null && s.length > 0)
    .join(" ");
  const { ionization, polarity } = readPolarity(g.get("Polarity"));

  const meta: RunMeta = {
    sample: header.get("Sample Description") || header.get("Acquired Name") || undefined,
    operator: header.get("User Name") || undefined,
    instrument: header.get("Instrument") || undefined,
    method: header.get("MS Method") || undefined,
    inlet: header.get("Inlet Method") || undefined,
    tuneFile: header.get("Tune Method") || undefined,
    acquiredDate: acquiredDate.length > 0 ? acquiredDate : undefined,
    ionization,
    polarity,
    scanMode: fn?.type || undefined,
    lowMass: num(p("Start Mass")) ?? fnInfo?.startMass,
    highMass: num(p("End Mass")) ?? fnInfo?.endMass,
    sourceTemp:
      num(g.get("Source Temperature (°C)")) ?? num(g.get("Source Temperature (C)")),
    solventDelayMin: num(header.get("Solvent Delay")),
    runTimeMin: num(p("End Time (mins)")) ?? fnInfo?.endRtMin,
  };

  const entries: { key: string; value: string }[] = [];
  for (const [k, v] of g) entries.push({ key: k, value: v });
  if (fn) for (const [k, v] of fn.params) entries.push({ key: `fn${fnNumber} ${k}`, value: v });
  if (entries.length > 0) {
    meta.tune = { tuneFile: header.get("Tune Method") || undefined, entries };
  }
  return meta;
}

// --- main parser -------------------------------------------------------------

/**
 * Decode one `.raw` folder into one `MsRun` PER ACQUISITION FUNCTION. A Waters
 * acquisition routinely holds several: the sample's TOF MS survey, a lockspray
 * REFERENCE channel, MS/MS functions. They are separate measurements on
 * separate time bases, so they become separate documents rather than being
 * merged; function 1 is returned first and is what the workspace activates.
 */
export function parseWatersRaw(
  bundle: WatersRawBundle,
  options?: WatersParseOptions,
): { runs: MsRun[]; errors: string[] } {
  const errors: string[] = [];
  const runs: MsRun[] = [];

  const header = bundle.headerTxt
    ? parseWatersHeader(bundle.headerTxt)
    : new Map<string, string>();
  const extern = bundle.externInf
    ? parseWatersExtern(bundle.externInf)
    : { global: new Map<string, string>(), functions: new Map<number, ExternFunction>() };
  const fnInfos = bundle.functnsInf ? parseWatersFunctions(bundle.functnsInf) : [];

  const baseName = bundle.folderName.replace(/\.raw$/i, "");
  const fnNumbers = Array.from(bundle.functions.keys()).sort((a, b) => a - b);
  const multi = fnNumbers.length > 1;

  fnNumbers.forEach((fnNumber, order) => {
    const files = bundle.functions.get(fnNumber);
    if (!files) return;
    const label = extern.functions.get(fnNumber)?.type;
    const displayName = multi
      ? `${baseName} — fn${fnNumber}${label ? ` ${label}` : ""}`
      : baseName;
    const stem = `_FUNC${String(fnNumber).padStart(3, "0")}`;
    try {
      if (!files.idx || !files.dat) {
        errors.push(
          `${bundle.folderName}: function ${fnNumber} is missing its ` +
            `${stem}${!files.idx ? ".IDX" : ".DAT"}`,
        );
        return;
      }
      const run = parseFunction({
        idxBuffer: files.idx,
        datBuffer: files.dat,
        name: displayName,
        sourcePath: bundle.sourcePath,
        meta: buildMeta(header, extern, fnNumber, fnInfos[fnNumber - 1]),
        calCoefficients: parseCalCoefficients(header.get(`Cal Function ${fnNumber}`)),
        dataFormat: extern.functions.get(fnNumber)?.params.get("Data Format") ?? null,
        options,
        onProgress: (frac) => {
          options?.onProgress?.(
            (order + frac) / fnNumbers.length,
            `${bundle.folderName} function ${fnNumber}`,
          );
        },
      });
      runs.push(run);
    } catch (err) {
      errors.push(
        `${bundle.folderName} (function ${fnNumber}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });

  if (runs.length === 0 && errors.length === 0) {
    errors.push(`${bundle.folderName}: no _FUNCnnn.DAT/.IDX pair found in the .raw folder`);
  }
  return { runs, errors };
}

interface ParseFunctionArgs {
  idxBuffer: ArrayBuffer;
  datBuffer: ArrayBuffer;
  name: string;
  sourcePath: string;
  meta: RunMeta;
  calCoefficients: number[] | null;
  dataFormat: string | null;
  options?: WatersParseOptions;
  onProgress?: (frac: number) => void;
}

function parseFunction(args: ParseFunctionArgs): MsRun {
  const { idxBuffer, datBuffer, name, sourcePath, meta, calCoefficients } = args;
  const warnings: string[] = [];

  const index = parseWatersIndex(idxBuffer, datBuffer.byteLength);
  if (!index) {
    throw new Error(
      "could not decode the scan index — the .IDX record layout or the .DAT " +
        "point size is not one this reader knows " +
        `(.IDX ${idxBuffer.byteLength} B, .DAT ${datBuffer.byteLength} B)`,
    );
  }
  warnings.push(...index.warnings);
  const { entries, bytesPerPoint } = index;
  const wordsPerPoint = bytesPerPoint / 4;

  // Centroid data is one point per peak already; only continuum needs reducing.
  const isCentroidSource =
    bytesPerPoint === 12 || (args.dataFormat ?? "").toLowerCase().startsWith("centroid");
  let totalRawPoints = 0;
  for (const e of entries) totalRawPoints += e.pointCount;
  const maxProfile = args.options?.maxProfilePoints ?? DEFAULT_MAX_PROFILE_POINTS;
  let centroid = args.options?.centroid ?? true;
  if (!centroid && !isCentroidSource && totalRawPoints > maxProfile) {
    centroid = true;
    warnings.push(
      `profile data has ${totalRawPoints.toLocaleString()} points, over the ` +
        `${maxProfile.toLocaleString()}-point budget — centroided instead of kept as profile`,
    );
  }
  const doCentroid = centroid && !isCentroidSource;

  const scanCount = entries.length;
  const rtMin = new Float64Array(scanCount);
  const tic = new Float64Array(scanCount);
  const basePeakMz = new Float64Array(scanCount);
  const basePeakIntensity = new Float64Array(scanCount);
  const msLevel = new Uint8Array(scanCount);
  const scanOffset = new Uint32Array(scanCount + 1);

  const level = /daughter|ms\s*\/?\s*ms|msms|product/i.test(meta.scanMode ?? "") ? 2 : 1;
  msLevel.fill(level);

  // Scans are decoded one at a time into per-scan chunks and only flattened at
  // the end. Centroiding shrinks a scan by ~40x, so the chunk list is far
  // smaller than the profile data it came from.
  const mzChunks: Float64Array[] = [];
  const intChunks: Float32Array[] = [];
  let pointCursor = 0;
  let minMz = Infinity;
  let maxMz = -Infinity;
  let minTic = Infinity;
  let maxTic = -Infinity;
  let ticMismatches = 0;
  let truncated = 0;

  const scratchMz: number[] = [];
  const scratchInt: number[] = [];

  for (let i = 0; i < scanCount; i += 1) {
    const entry = entries[i];
    rtMin[i] = entry.rtMin;

    const byteStart = entry.offset;
    const byteEnd = byteStart + entry.pointCount * bytesPerPoint;
    let usable = entry.pointCount;
    if (byteStart < 0 || byteEnd > datBuffer.byteLength) {
      usable = Math.max(0, Math.floor((datBuffer.byteLength - byteStart) / bytesPerPoint));
      truncated += 1;
    }

    scratchMz.length = 0;
    scratchInt.length = 0;
    let sumIntensity = 0;
    let apexMz = 0;
    let apexIntensity = 0;

    if (usable > 0) {
      const words = new Uint32Array(datBuffer, byteStart, usable * wordsPerPoint);
      for (let p = 0, w = 0; p < usable; p += 1, w += wordsPerPoint) {
        const w0 = words[w];
        const w1 = words[w + 1];
        const intensity = (w0 & 0x3fffff) * INTENSITY_SCALE[(w0 >>> 22) & 0x1f];
        let mz = (w1 & 0x7ffffff) * MZ_SCALE[w1 >>> 27];
        if (calCoefficients && !entry.calibrated && mz > 0) {
          mz = applyCalibration(mz, calCoefficients);
        }
        scratchMz.push(mz);
        scratchInt.push(intensity);
        sumIntensity += intensity;
      }
    }

    let outMz: Float64Array;
    let outInt: Float32Array;
    if (doCentroid) {
      const peaks = centroidProfile(scratchMz, scratchInt, {
        relThreshold: args.options?.centroidRelThreshold,
      });
      outMz = new Float64Array(peaks.length);
      outInt = new Float32Array(peaks.length);
      for (let k = 0; k < peaks.length; k += 1) {
        outMz[k] = peaks[k].mz;
        outInt[k] = peaks[k].intensity;
        if (peaks[k].intensity > apexIntensity) {
          apexIntensity = peaks[k].intensity;
          apexMz = peaks[k].mz;
        }
      }
    } else {
      outMz = Float64Array.from(scratchMz);
      outInt = Float32Array.from(scratchInt);
      for (let k = 0; k < outInt.length; k += 1) {
        if (outInt[k] > apexIntensity) {
          apexIntensity = outInt[k];
          apexMz = outMz[k];
        }
      }
    }

    if (outMz.length > 0) {
      if (outMz[0] < minMz) minMz = outMz[0];
      if (outMz[outMz.length - 1] > maxMz) maxMz = outMz[outMz.length - 1];
    }

    mzChunks.push(outMz);
    intChunks.push(outInt);
    scanOffset[i] = pointCursor;
    pointCursor += outMz.length;

    // On CONTINUUM data the decoded intensities sum to the index's TIC (bar
    // f32 storage precision), so a drift means the point decode is off and is
    // worth surfacing. Centroiding conserves area, so the check holds either
    // way. Centroid-source functions are exempt: MassLynx computes their peak
    // areas against a subtracted baseline, so they legitimately do not sum to
    // the scan's TIC.
    const declared = entry.tic;
    const haveDeclared = Number.isFinite(declared) && declared > 0;
    tic[i] = haveDeclared ? declared : sumIntensity;
    if (
      haveDeclared &&
      !isCentroidSource &&
      Math.abs(sumIntensity - declared) / declared > 0.01
    ) {
      ticMismatches += 1;
    }
    if (tic[i] < minTic) minTic = tic[i];
    if (tic[i] > maxTic) maxTic = tic[i];
    basePeakMz[i] = apexMz;
    basePeakIntensity[i] = apexIntensity;

    if ((i & 15) === 0) args.onProgress?.(i / Math.max(1, scanCount));
  }
  scanOffset[scanCount] = pointCursor;
  args.onProgress?.(1);

  if (truncated > 0) {
    warnings.push(`${truncated} scan(s) ran past the end of the .DAT and were truncated`);
  }
  if (ticMismatches > 0) {
    warnings.push(`TIC cross-check: ${ticMismatches} scan(s) differ from the scan index by >1%`);
  }
  if (doCentroid) {
    warnings.push(
      `continuum data centroided on load: ${totalRawPoints.toLocaleString()} profile ` +
        `points reduced to ${pointCursor.toLocaleString()} peaks`,
    );
  }

  const mz = new Float64Array(pointCursor);
  const intensity = new Float32Array(pointCursor);
  let cursor = 0;
  for (let i = 0; i < mzChunks.length; i += 1) {
    mz.set(mzChunks[i], cursor);
    intensity.set(intChunks[i], cursor);
    cursor += mzChunks[i].length;
    // Release each chunk as it is copied so peak memory stays near 1x.
    mzChunks[i] = EMPTY_F64;
    intChunks[i] = EMPTY_F32;
  }

  return {
    id: crypto.randomUUID(),
    name,
    sourcePath,
    format: "waters-raw",
    detector: "ms",
    rtMin,
    tic,
    basePeakMz,
    basePeakIntensity,
    msLevel,
    scanOffset,
    mz,
    intensity,
    scanCount,
    pointCount: pointCursor,
    mzRange: pointCursor > 0 ? [minMz, maxMz] : [Infinity, -Infinity],
    rtRange: scanCount > 0 ? [rtMin[0], rtMin[scanCount - 1]] : [Infinity, -Infinity],
    ticRange: scanCount > 0 ? [minTic, maxTic] : [Infinity, -Infinity],
    meta,
    warnings,
  };
}
