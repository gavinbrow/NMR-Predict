// Agilent ChemStation single-signal chromatogram parser (.ch / .uv).
//
// Reads the legacy (version 8/81) and modern (version 130/179/181) single-signal
// file formats used by ChemStation for LC-UV / DAD single-wavelength and GC-FID
// traces. The result is an `MsRun` carrying only a chromatogram: `scanCount` is 0
// and the time axis / signal live in `rtMin` / `tic`.
//
// IMPORTANT: the offsets below are taken from public reverse-engineering of the
// format and are NOT verified against a real instrument file (we have no .ch
// sample in the repo). Every parse therefore pushes a warning telling the caller
// the values are unvalidated, and every field is defensively validated before
// use. This module never throws on malformed input — it returns an empty `MsRun`
// with warnings instead.

import type { MsRun, RunMeta } from "../types";

const SUPPORTED_VERSIONS = new Set(["8", "81", "30", "130", "179", "181"]);
const LATIN1_VERSIONS = new Set(["8", "81"]);
const UTF16_VERSIONS = new Set(["130", "179", "181"]);
const F64_VERSIONS = new Set(["179", "181"]);

const EXPERIMENTAL_WARNING =
  "Agilent .ch/.uv support is experimental and has not been validated against a " +
  "real instrument file. Verify the values before use.";

/** Max pascal-string length (characters) we will trust before calling it corrupt. */
const MAX_PASCAL_LEN = 512;

/* ------------------------------------------------------------------ *
 * Binary helpers
 * ------------------------------------------------------------------ */

/**
 * Reads a pascal string at `offset`: one length byte, then that many bytes of
 * text. `utf16` selects UTF-16LE decoding where the length byte counts CHARACTERS
 * (so the byte span is `2 * len`). Returns the decoded text or undefined when
 * the field is implausible (length too large, runs off the buffer, non-printable).
 */
function readPascalString(
  view: DataView,
  bytes: Uint8Array,
  offset: number,
  utf16: boolean,
  warnings: string[],
  label: string,
): string | undefined {
  if (offset < 0 || offset + 1 > view.byteLength) {
    warnings.push(`${label} pascal-length byte is outside the buffer`);
    return undefined;
  }
  const len = view.getUint8(offset);
  if (len === 0) return "";
  if (len > MAX_PASCAL_LEN) {
    warnings.push(`${label} pascal length ${len} exceeds ${MAX_PASCAL_LEN}, dropped`);
    return undefined;
  }
  const byteLen = utf16 ? len * 2 : len;
  const start = offset + 1;
  const end = start + byteLen;
  if (end > view.byteLength) {
    warnings.push(`${label} pascal string runs past end of buffer, dropped`);
    return undefined;
  }
  let text: string;
  if (utf16) {
    let s = "";
    for (let i = 0; i < len; i++) {
      const code = view.getUint16(start + i * 2, true);
      s += String.fromCharCode(code);
    }
    text = s;
  } else {
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[start + i]);
    text = s;
  }
  if (!isPlausiblyPrintable(text)) {
    warnings.push(`${label} string is non-printable, dropped`);
    return undefined;
  }
  return text;
}

/** At least 75% of characters must be printable (tab/newline/cr or >= 0x20). */
function isPlausiblyPrintable(text: string): boolean {
  if (text.length === 0) return true;
  let printable = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) {
      printable++;
    } else if (c >= 0x20 && c <= 0xff) {
      printable++;
    } else if (c >= 0x100) {
      printable++;
    }
  }
  return printable / text.length >= 0.75;
}

function isDadUvDescription(desc: string | undefined): boolean {
  if (!desc) return false;
  const up = desc.toUpperCase();
  return /\b(DAD|UV)\b/.test(up) || /NM\b/.test(up);
}

function canReadF64(view: DataView, offset: number): boolean {
  return offset >= 0 && offset + 8 <= view.byteLength;
}
function canReadU32(view: DataView, offset: number): boolean {
  return offset >= 0 && offset + 4 <= view.byteLength;
}

/* ------------------------------------------------------------------ *
 * Public sniff helpers
 * ------------------------------------------------------------------ */

/** Reads the leading pascal version string and returns it, or null. */
export function chemStationChVersion(bytes: Uint8Array): string | null {
  if (bytes.length < 1) return null;
  const len = bytes[0];
  if (len === 0 || bytes.length < 1 + len) return null;
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[1 + i]);
  return s;
}

/** True when the leading version string is one we claim to support. */
export function isChemStationCh(bytes: Uint8Array): boolean {
  const v = chemStationChVersion(bytes);
  return v !== null && SUPPORTED_VERSIONS.has(v);
}

/* ------------------------------------------------------------------ *
 * Empty-run factory
 * ------------------------------------------------------------------ */

function emptyRun(
  name: string,
  sourcePath: string,
  detector: "uv" | "fid",
  meta: RunMeta,
  warnings: string[],
): MsRun {
  return {
    id: crypto.randomUUID(),
    name,
    sourcePath,
    format: "agilent-ch",
    detector,
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
    mzRange: [0, 0],
    rtRange: [Infinity, -Infinity],
    ticRange: [Infinity, -Infinity],
    meta,
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * Decoders
 * ------------------------------------------------------------------ */

interface DecodeResult {
  values: Float64Array;
  warning?: string;
}

/**
 * i16-delta with 0x8000 escape. `value += delta`, except when a delta reads as
 * -32768 the next big-endian i32 is an absolute value that replaces `value`.
 * Uses a dynamic JS array because escapes consume extra bytes, so the point
 * count can exceed the naive `(buffer - dataStart) / 2` estimate.
 */
function decodeI16DeltaRun(
  view: DataView,
  bytes: Uint8Array,
  dataStart: number,
): DecodeResult {
  if (dataStart < 0 || dataStart >= bytes.length) {
    return { values: new Float64Array(0), warning: "No room for any i16 delta points" };
  }
  const out: number[] = [];
  let value = 0;
  let i = dataStart;
  // Safety: cap iterations so a corrupt stream can't loop the whole buffer
  // forever. Each point is >=2 bytes, so `bytes.length` iterations is generous.
  const safetyLimit = bytes.length;
  let safety = 0;
  while (i + 2 <= bytes.length && safety < safetyLimit) {
    safety++;
    const delta = view.getInt16(i, false); // big-endian
    i += 2;
    if (delta === -32768) {
      if (i + 4 > bytes.length) break;
      value = view.getInt32(i, false);
      i += 4;
    } else {
      value += delta;
    }
    out.push(value);
  }
  if (out.length === 0) {
    return { values: new Float64Array(0), warning: "No i16 delta points decoded" };
  }
  return { values: Float64Array.from(out) };
}

/** Big-endian f64 values, one per point (version 179/181). */
function decodeF64Run(
  view: DataView,
  bytes: Uint8Array,
  dataStart: number,
): DecodeResult {
  const bytesPerPoint = 8;
  const maxPoints = Math.floor((bytes.length - dataStart) / bytesPerPoint);
  if (maxPoints <= 0) {
    return { values: new Float64Array(0), warning: "No room for any f64 points" };
  }
  const out = new Float64Array(maxPoints);
  for (let k = 0; k < maxPoints; k++) {
    out[k] = view.getFloat64(dataStart + k * 8, false);
  }
  return { values: out };
}

/* ------------------------------------------------------------------ *
 * Axis construction
 * ------------------------------------------------------------------ */

function applySlopeIntercept(
  values: Float64Array,
  slope: number,
  intercept: number,
): Float64Array {
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    out[i] = values[i] * slope + intercept;
  }
  return out;
}

function buildAxes(
  signal: Float64Array,
  startTimeMs: number,
  endTimeMs: number,
  warnings: string[],
): { rtMin: Float64Array; tic: Float64Array } {
  const n = signal.length;
  if (n < 2) {
    return { rtMin: new Float64Array(0), tic: new Float64Array(0) };
  }
  const rtMin = new Float64Array(n);
  const tic = signal;
  const finiteStart = Number.isFinite(startTimeMs);
  const finiteEnd = Number.isFinite(endTimeMs);
  if (finiteStart && finiteEnd && endTimeMs > startTimeMs) {
    const span = endTimeMs - startTimeMs;
    for (let i = 0; i < n; i++) {
      rtMin[i] = (startTimeMs + (i * span) / (n - 1)) / 60000;
    }
  } else {
    if (finiteStart && finiteEnd && endTimeMs <= startTimeMs) {
      warnings.push("endTime <= startTime; RT axis estimated assuming 1 Hz sampling");
    } else if (!finiteStart || !finiteEnd) {
      warnings.push("Start/end time not finite; RT axis estimated assuming 1 Hz sampling");
    } else {
      warnings.push("RT axis is degenerate; RT axis estimated assuming 1 Hz sampling");
    }
    warnings.push(
      "Retention-time header is invalid; the time axis is an estimate assuming 1 Hz sampling.",
    );
    // The fallback assumes a 1 Hz sampling rate so the axis is honest minutes,
    // not raw sample indices (which the rest of the app treats as minutes).
    for (let i = 0; i < n; i++) rtMin[i] = i / 60;
  }
  return { rtMin, tic };
}

/* ------------------------------------------------------------------ *
 * Main parser
 * ------------------------------------------------------------------ */

export function parseChemStationCh(
  buffer: ArrayBuffer,
  opts?: { name?: string; sourcePath?: string },
): MsRun {
  const name = opts?.name ?? "";
  const sourcePath = opts?.sourcePath ?? "";
  const warnings: string[] = [EXPERIMENTAL_WARNING];

  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // A buffer too small to even hold a version string is handled gracefully.
  if (bytes.length < 4) {
    warnings.push("Buffer too small to be a valid ChemStation .ch/.uv file");
    return emptyRun(name, sourcePath, "fid", {}, warnings);
  }

  const version = chemStationChVersion(bytes);
  if (version === null || !SUPPORTED_VERSIONS.has(version)) {
    warnings.push(
      `Unrecognised ChemStation .ch/.uv version string "${version ?? ""}" — no data parsed`,
    );
    return emptyRun(name, sourcePath, "fid", {}, warnings);
  }

  const isLatin1 = LATIN1_VERSIONS.has(version);
  const isUtf16 = UTF16_VERSIONS.has(version);
  const isF64 = F64_VERSIONS.has(version);
  const isModern = isUtf16; // 130/179/181

  // ---- header strings ------------------------------------------------
  const meta: RunMeta = {};

  let description: string | undefined;
  if (isLatin1) {
    meta.sample = readPascalString(view, bytes, 0x018, false, warnings, "sample");
    description = readPascalString(view, bytes, 0x03d, false, warnings, "description");
    meta.operator = readPascalString(view, bytes, 0x148, false, warnings, "operator");
    meta.acquiredDate = readPascalString(view, bytes, 0x15e, false, warnings, "acq date");
    meta.instrument = readPascalString(view, bytes, 0x1e6, false, warnings, "instrument");
    meta.method = readPascalString(view, bytes, 0x254, false, warnings, "method");
  } else {
    meta.sample = readPascalString(view, bytes, 0x15b, true, warnings, "sample");
    description = readPascalString(view, bytes, 0x35a, true, warnings, "description");
    meta.operator = readPascalString(view, bytes, 0x758, true, warnings, "operator");
    meta.acquiredDate = readPascalString(view, bytes, 0x957, true, warnings, "acq date");
    meta.instrument = readPascalString(view, bytes, 0xa0e, true, warnings, "instrument");
    meta.method = readPascalString(view, bytes, 0xe11, true, warnings, "method");
    const sigDesc = readPascalString(view, bytes, 0xc11, true, warnings, "signal");
    if (sigDesc && description === undefined) description = sigDesc;
  }

  const detector: "uv" | "fid" = isDadUvDescription(description) ? "uv" : "fid";

  // ---- times --------------------------------------------------------
  let startTimeMs = NaN;
  let endTimeMs = NaN;
  if (canReadF64(view, 0x282)) startTimeMs = view.getFloat64(0x282, false);
  if (canReadF64(view, 0x28a)) endTimeMs = view.getFloat64(0x28a, false);

  // ---- slope / intercept --------------------------------------------
  let slope = 1;
  let intercept = 0;
  if (isLatin1) {
    // 0x27C intercept. The spec lists slope at 0x284, but that 8-byte f64
    // (0x284..0x28B) overlaps the end-time f64 at 0x28A (0x28A..0x291). The spec
    // says to prefer the times and warn, so we do NOT read slope from 0x284 and
    // leave it at the default of 1.
    if (canReadF64(view, 0x27c)) {
      const ic = view.getFloat64(0x27c, false);
      if (Number.isFinite(ic)) intercept = ic;
    }
    warnings.push(
      "Legacy slope offset 0x284 overlaps end-time 0x28a; slope not read (left at 1)",
    );
  } else if (version === "179" || version === "181") {
    if (canReadF64(view, 0x1e4)) {
      const sl = view.getFloat64(0x1e4, false);
      if (Number.isFinite(sl)) slope = sl;
    }
    if (canReadF64(view, 0x1ec)) {
      const ic = view.getFloat64(0x1ec, false);
      if (Number.isFinite(ic)) intercept = ic;
    }
  }

  // ---- data start ---------------------------------------------------
  let dataStart = 0;
  if (canReadU32(view, 0x11a)) {
    const words = view.getUint32(0x11a, false);
    if (words > 0) dataStart = words * 2 - 2;
  }
  if (dataStart <= 0) {
    const fallback = version === "130" ? 0x1000 : 0x1800;
    dataStart = fallback;
    warnings.push(
      `Data-start word at 0x11A read as 0; fell back to fixed 0x${fallback.toString(16)}`,
    );
  }
  if (dataStart >= bytes.length) {
    warnings.push(
      `Data start 0x${dataStart.toString(16)} is past end of buffer (0x${bytes.length.toString(16)}); no points`,
    );
    return emptyRun(name, sourcePath, detector, meta, warnings);
  }

  // ---- decode the data run -----------------------------------------
  let rtMin: Float64Array;
  let tic: Float64Array;
  if (isF64) {
    const out = decodeF64Run(view, bytes, dataStart);
    if (out.warning) warnings.push(out.warning);
    ({ rtMin, tic } = buildAxes(out.values, startTimeMs, endTimeMs, warnings));
  } else {
    // version 8/81/130: i16 delta + escape
    const out = decodeI16DeltaRun(view, bytes, dataStart);
    if (out.warning) warnings.push(out.warning);
    const signal = applySlopeIntercept(out.values, slope, intercept);
    ({ rtMin, tic } = buildAxes(signal, startTimeMs, endTimeMs, warnings));
  }

  if (rtMin.length < 2) {
    warnings.push("Fewer than 2 chromatogram points produced; trace is empty");
    return emptyRun(name, sourcePath, detector, meta, warnings);
  }

  const rtRange: [number, number] = [rtMin[0], rtMin[rtMin.length - 1]];
  let ticMin = Infinity;
  let ticMax = -Infinity;
  for (let i = 0; i < tic.length; i++) {
    const v = tic[i];
    if (v < ticMin) ticMin = v;
    if (v > ticMax) ticMax = v;
  }
  if (!Number.isFinite(ticMin)) {
    ticMin = 0;
    ticMax = 0;
  }
  const ticRange: [number, number] = [ticMin, ticMax];

  return {
    id: crypto.randomUUID(),
    name,
    sourcePath,
    format: "agilent-ch",
    detector,
    rtMin,
    tic,
    basePeakMz: new Float64Array(0),
    basePeakIntensity: new Float64Array(0),
    msLevel: new Uint8Array(0),
    scanOffset: new Uint32Array(1),
    mz: new Float64Array(0),
    intensity: new Float32Array(0),
    scanCount: 0,
    pointCount: 0,
    mzRange: [0, 0],
    rtRange,
    ticRange,
    meta,
    warnings,
  };
}