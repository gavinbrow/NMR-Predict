// TRIOS `.tri` project file parser for DSC25 runs (§2.1 of the plan).
//
// Same outer container as the TGA `.tri`: a length-prefixed UTF-8 key/value
// header, a PNG preview that marks the header's end, then float32 signal
// arrays. Three things differ from the TGA reader and each one silently
// corrupts the read if missed — see the plan's §2.1 for the byte-level
// verification against the real sample files:
//
//   1. `samplesize` is ALREADY IN MILLIGRAMS here (TGA's is kilograms — do
//      NOT multiply by 1e6).
//   2. The inter-array gap within a block VARIES (66, 6, 72, 69 bytes were
//      all observed), so TGA's fixed `N * 4 + 72` stride
//      (`readBlockArrays`) does not work. Every array — including the block's
//      own Time axis — is instead preceded by a 6-byte marker
//      (`0x01 0x00 <N as LE uint32>`); {@link walkBlockSignals} walks that
//      marker forward, byte-by-byte, within a 512-byte window per hop.
//   3. TRIOS interleaves per-point "flag" status arrays that carry the same
//      marker as a real signal. {@link isFlagArray} discriminates them: every
//      element is exactly 0 or a denormal-magnitude value (`|v| < 1e-25`),
//      AND at least one denormal is present (a genuine all-zero signal, e.g.
//      "Heat Flow Phase" on a non-modulated run, has no denormals and must be
//      KEPT or the ordinal mapping onto `proceduresignals` shifts).
//
// The block-start marker (`findNextBlock`, unchanged from TGA) is a DIFFERENT,
// stronger pattern than the per-array marker above — it requires the array's
// length to repeat at both offset -22 and -4 before the array — which is
// verified to match only the Time axis of each "Data On" procedure segment,
// not any of the other monotonic signals (Temperature climbs steadily during
// a ramp too, and would otherwise be mistaken for a new block).
//
// ⚠️ A 4th thing, discovered while getting `parseTriosTri` to pass against the
// REAL `DAC1.tri` (not just synthetic fixtures): `parseTriosHeader` (reused
// unchanged from TGA, per the plan) assumes every header value's length fits
// in a single byte. Every DSC25 header string is actually length-prefixed the
// .NET `BinaryWriter.Write(string)` way — a 7-bit-encoded varint — which
// collapses to one byte for any value under 128 bytes (every field TGA's
// procedures ever populate, and most of DSC's: `samplename`, `samplesize`,
// `pantype`, …, all still decode correctly). `proceduresegments` and
// `proceduresignals` don't fit that assumption: verified on `DAC1.tri`, the
// former is 397 bytes (`parseTriosHeader` reads only the first 141, silently
// dropping 3 of the file's 4 procedure segments and breaking the §2.1 label
// pairing) and the latter is 201 (truncated to 200, losing "Total Heat
// Capacity"'s last letter). `readLongHeaderValue` re-reads just these two
// keys with the correct decoder and overrides `parseTriosHeader`'s result —
// see its doc comment for the byte-level detail. Every other key is still
// read by the shared, unmodified `parseTriosHeader`.
//
// This is the riskiest DSC parser; like the TGA one, it never throws — every
// failure becomes a friendly warning string and an empty `runs` array.

import { parseTriosHeader, findPngSpan, findNextBlock } from "@/lib/tga/parse/triosTri";
import { buildSegments, type SegmentBlock } from "../segments";
import type { DscMetadata, ParsedDscFile, ParsedDscRun } from "../types";

/** DSC signal names, in the order the header's `proceduresignals` lists them
 *  for a standard (non-modulated) DSC25 method (§2.1). Used only as a
 *  fallback count when the header's own list can't be read. */
const DEFAULT_SIGNAL_COUNT = 13;

/** How far forward to scan for the next array's marker, per hop (§2.1). */
const MARKER_SCAN_WINDOW = 512;

/** Guard against a corrupt length byte being read as a huge array. */
const MAX_MARKER_ARRAY_LEN = 20_000_000;

/** Header keys DSC needs beyond the ones `parseTriosHeader`'s fixed
 *  `knownKeys` list already covers (§2.1). `parseTriosHeader` itself is
 *  reused unchanged from the read-only TGA module, so these are picked up by
 *  a small local scan using the same length-prefixed key/value convention. */
const EXTRA_HEADER_KEYS = [
  "samplepanmass",
  "samplepannumber",
  "referencesize",
  "referencepanmass",
];

/** Find a byte substring (ASCII needle) from `from`. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let k = 0; k < needle.length; k++) {
      if (haystack[i + k] !== needle[k]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Decode a header value: strict UTF-8 first (TRIOS writes "°C" as UTF-8),
 *  falling back to latin1 for the rare field that would make the strict
 *  decoder throw. Mirrors `lib/tga/parse/triosTri.ts`'s `decodeText`. */
function decodeHeaderText(slice: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(slice);
  } catch {
    let out = "";
    for (let k = 0; k < slice.length; k++) out += String.fromCharCode(slice[k]);
    return out;
  }
}

/** Find a known key's position in the header region (the byte index of its
 *  first character), requiring the byte immediately before it to equal the
 *  key's own length — the same signature `parseTriosHeader` scans for.
 *  Returns -1 when the key isn't present before `pngStart`. */
function locateHeaderKey(bytes: Uint8Array, pngStart: number, key: string): number {
  const keyBytes = new TextEncoder().encode(key);
  let from = 0;
  while (from < pngStart) {
    const idx = indexOfBytes(bytes, keyBytes, from);
    if (idx < 0 || idx >= pngStart) return -1;
    if (idx > 0 && bytes[idx - 1] === key.length) return idx;
    from = idx + 1;
  }
  return -1;
}

/**
 * Scan for a small set of additional, optional header keys not covered by
 * the shared `parseTriosHeader` (§2.1: pan mass, pan number, reference size,
 * reference pan mass), using the same "length byte + key text + length byte
 * + value text" convention. Best-effort and silent: a key that isn't found
 * or doesn't parse is simply absent from the result — these are optional
 * metadata fields, never load-bearing for the numeric arrays.
 */
export function scanExtraHeaderKeys(bytes: Uint8Array, pngStart: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of EXTRA_HEADER_KEYS) {
    const pos = locateHeaderKey(bytes, pngStart, key);
    if (pos < 0) continue;
    const vStart = pos + key.length;
    if (vStart >= bytes.length) continue;
    const vLen = bytes[vStart];
    if (vLen > 250 || vStart + 1 + vLen > bytes.length) continue;
    const value = decodeHeaderText(bytes.subarray(vStart + 1, vStart + 1 + vLen));
    let cleaned = value;
    while (cleaned.length > 0 && cleaned.charCodeAt(0) < 32) cleaned = cleaned.slice(1);
    out[key] = cleaned;
  }
  return out;
}

/**
 * Decode a .NET `BinaryWriter.Write(string)`-style 7-bit-encoded length
 * prefix at `pos`: each byte contributes its low 7 bits to the value, and a
 * set high bit means "one more byte follows". Returns the decoded length and
 * how many prefix bytes it took, or null on a malformed (>5-byte) prefix.
 */
function read7BitEncodedLength(
  bytes: Uint8Array,
  pos: number,
): { length: number; prefixBytes: number } | null {
  let result = 0;
  let shift = 0;
  let p = pos;
  for (let i = 0; i < 5; i++) {
    if (p >= bytes.length) return null;
    const b = bytes[p];
    p++;
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { length: result >>> 0, prefixBytes: p - pos };
    shift += 7;
  }
  return null;
}

/**
 * ⚠️ Re-read one header value using the REAL length encoding, for a key whose
 * value may be too long for `parseTriosHeader`'s simplifying single-byte
 * length assumption. Every DSC25 `.tri` header string (verified on
 * `DAC1.tri`) is actually length-prefixed the .NET `BinaryWriter` way — a
 * 7-bit-encoded varint, not a fixed single byte — but that assumption only
 * ever breaks for a value ≥ 128 bytes, so `parseTriosHeader` reads every
 * short field (`samplename`, `samplesize`, `pantype`, …) correctly and is
 * safe to keep reusing for those. It is NOT safe for `proceduresegments`
 * (397 bytes on `DAC1.tri` — `parseTriosHeader` truncates it to 141 bytes,
 * losing 3 of the file's 4 procedure segments) or `proceduresignals` (201
 * bytes — truncated to 200, losing the final character of "Total Heat
 * Capacity"). Both are re-read here with the correct decoder and override
 * whatever `parseTriosHeader` already returned. Returns null (leaving the
 * caller's existing value alone) when the key isn't found or the length
 * doesn't decode plausibly.
 */
function readLongHeaderValue(bytes: Uint8Array, pngStart: number, key: string): string | null {
  const pos = locateHeaderKey(bytes, pngStart, key);
  if (pos < 0) return null;
  const vStart = pos + key.length;
  const lenInfo = read7BitEncodedLength(bytes, vStart);
  if (!lenInfo || lenInfo.length > 100_000) return null;
  const dataStart = vStart + lenInfo.prefixBytes;
  if (dataStart + lenInfo.length > bytes.length) return null;
  return decodeHeaderText(bytes.subarray(dataStart, dataStart + lenInfo.length));
}

/** Keys whose value can exceed `parseTriosHeader`'s 127-byte single-prefix-
 *  byte assumption and need {@link readLongHeaderValue}'s re-read. */
const LONG_HEADER_KEYS = ["proceduresegments", "proceduresignals"];

/** Split `proceduresignals` into trimmed names, stripping the leading
 *  control byte TRIOS sometimes prefixes the first entry with. */
function parseSignalNames(raw: string): string[] {
  return raw
    .split(";")
    .map((s) => {
      let t = s;
      while (t.length > 0 && t.charCodeAt(0) < 32) t = t.slice(1);
      return t.trim();
    })
    .filter(Boolean);
}

/**
 * A DSC "flag" array's elements are all either exactly 0 or a
 * denormal-magnitude value (`|v| < 1e-25`, TRIOS repeats a
 * `3.85186e-34`-ish byte pattern), AND at least one denormal is present.
 * Verified discriminator from §2.1 — copied verbatim. A genuine all-zero
 * signal (no denormals at all) must NOT be treated as a flag array, or the
 * ordinal mapping onto `proceduresignals` shifts.
 */
export function isFlagArray(dv: DataView, start: number, n: number): boolean {
  let denorm = 0;
  for (let k = 0; k < n; k++) {
    const v = dv.getFloat32(start + k * 4, true);
    if (v === 0) continue;
    if (Number.isFinite(v) && Math.abs(v) < 1e-25) {
      denorm++;
      continue;
    }
    return false; // a real value ⇒ a real signal
  }
  return denorm > 0;
}

/** Read `count` little-endian float32s starting at `start` into a Float64Array. */
function readF32(dv: DataView, start: number, count: number): Float64Array {
  const out = new Float64Array(count);
  for (let k = 0; k < count; k++) out[k] = dv.getFloat32(start + k * 4, true);
  return out;
}

/** How close together two occurrences of the same `01 00 <N>` marker have to
 *  be for the second one to count as a duplicate of the first, rather than a
 *  genuinely different, much-further-away array (§2.1 walk, see the comment
 *  on {@link findNextMarker} for why this exists). */
const CLUSTER_COLLAPSE_WINDOW = 64;

/** Scan for a single `01 00 <expectedLength>` marker at or after `from`,
 *  within `windowBytes`. Returns the array's own start offset (6 bytes past
 *  the marker), or null when none is found. */
function scanForMarker(
  dv: DataView,
  bytes: Uint8Array,
  from: number,
  windowBytes: number,
  expectedLength: number,
): number | null {
  const begin = Math.max(0, from);
  const limit = Math.min(bytes.length - 6, begin + windowBytes);
  for (let p = begin; p <= limit; p++) {
    if (bytes[p] !== 0x01 || bytes[p + 1] !== 0x00) continue;
    const n = dv.getUint32(p + 2, true);
    if (n !== expectedLength) continue;
    if (n <= 0 || n > MAX_MARKER_ARRAY_LEN) continue;
    const arrStart = p + 6;
    if (arrStart + n * 4 > bytes.length) continue;
    return arrStart;
  }
  return null;
}

/**
 * Find the next array's universal marker (`0x01 0x00 <N as LE uint32>`) at or
 * after `from`, scanning byte-by-byte within `windowBytes`. Returns the
 * array's own start offset and its length, or null when no marker with the
 * expected length is found in the window.
 *
 * ⚠️ Some signals (verified on `DAC1.tri`: Delta T, Delta Tzero, Tzero
 * Temperature, Cell Purge, Heater Temp, Power Delivered, Reference Junction
 * Temperature, Flange Temperature — everything with an extra per-signal type
 * descriptor) carry TWO copies of the identical `01 00 <N>` marker a few
 * bytes apart, with a small non-data descriptor sandwiched between them; only
 * the SECOND copy is immediately followed by real float data. Taking the
 * first occurrence lands the read a few bytes into that descriptor, which
 * (being not a multiple of 4 bytes) misaligns every subsequent float read
 * for the rest of the array. So once a candidate is found, this collapses a
 * TIGHT cluster of repeated same-length markers (within
 * {@link CLUSTER_COLLAPSE_WINDOW} bytes of each other) down to the last one
 * in the cluster — real distinct arrays are always much further apart than
 * that, so this never over-collapses across two genuinely different arrays.
 */
function findNextMarker(
  dv: DataView,
  bytes: Uint8Array,
  from: number,
  windowBytes: number,
  expectedLength: number,
): { start: number; length: number } | null {
  const first = scanForMarker(dv, bytes, from, windowBytes, expectedLength);
  if (first === null) return null;
  let arrStart = first;
  for (;;) {
    const dup = scanForMarker(dv, bytes, arrStart, CLUSTER_COLLAPSE_WINDOW, expectedLength);
    if (dup === null) break;
    arrStart = dup;
  }
  return { start: arrStart, length: expectedLength };
}

/**
 * Walk one procedure-segment block's signal arrays starting from its Time
 * array (`start`, length `n`, already located by `findNextBlock`). Reads
 * arrays via the universal per-array marker (§2.1), skipping any
 * {@link isFlagArray} array so the kept arrays map ordinally onto
 * `proceduresignals`, and stops once `signalCount` real arrays are collected.
 * Also returns the byte offset just past the last array it looked at, so the
 * caller can resume the block search there instead of a slow re-scan through
 * this block's own signal data (which — Temperature included — is often
 * itself monotonic and would otherwise risk being mistaken for the next
 * block's Time axis).
 */
export function walkBlockSignals(
  dv: DataView,
  bytes: Uint8Array,
  start: number,
  n: number,
  signalCount: number,
): { arrays: Float64Array[]; endOffset: number } {
  const arrays: Float64Array[] = [];
  let curStart = start;
  let curN = n;
  let endOffset = start + n * 4;
  // Generous cap on marker hops: signalCount real arrays plus a handful of
  // interleaved flag arrays, never an unbounded scan on a corrupt file.
  const maxHops = signalCount * 6 + 16;
  for (let hop = 0; hop < maxHops; hop++) {
    if (curStart < 0 || curN <= 0 || curStart + curN * 4 > bytes.length) break;
    endOffset = curStart + curN * 4;
    if (!isFlagArray(dv, curStart, curN)) {
      arrays.push(readF32(dv, curStart, curN));
      if (arrays.length >= signalCount) break;
    }
    const next = findNextMarker(dv, bytes, curStart + curN * 4 - 8, MARKER_SCAN_WINDOW, n);
    if (!next) break;
    curStart = next.start;
    curN = next.length;
  }
  return { arrays, endOffset };
}

/** Length to keep after dropping the trailing run of EXACTLY-zero samples
 *  (§2.1's zero pad: the tail of every block is zero-filled). A real DSC heat
 *  flow sample is never exactly `0.0` — float32 noise sees to that — so an
 *  exact 0 only appears in the padded tail past the segment's real data. */
export function trimTrailingZeroRun(heatFlow: Float64Array): number {
  let end = heatFlow.length;
  while (end > 0 && heatFlow[end - 1] === 0) end--;
  return end;
}

/**
 * Segment labels from `proceduresegments` (§2.1): split on `;`, trim, and
 * keep only `Ramp`/`Isothermal` entries that fall between a `Data On` and the
 * next `Data Off`. Equilibration holds and the pre/post-ramp isothermal steps
 * outside the Data On/Off window are excluded — they store no arrays.
 */
export function deriveTriSegmentLabels(methodSteps: string[]): string[] {
  const labels: string[] = [];
  let inDataWindow = false;
  for (const step of methodSteps) {
    if (/^Data On\b/i.test(step)) {
      inDataWindow = true;
      continue;
    }
    if (/^Data Off\b/i.test(step)) {
      inDataWindow = false;
      continue;
    }
    if (inDataWindow && (/^Ramp\b/i.test(step) || /^Isothermal\b/i.test(step))) {
      labels.push(step);
    }
  }
  return labels;
}

/** Build the DSC metadata from the parsed (+ extended) header map. */
export function buildTriosDscMetadata(
  header: Record<string, string>,
  fileName: string,
): DscMetadata {
  const get = (k: string): string => header[k] ?? "";
  // §2.1: samplesize is ALREADY in milligrams in a DSC .tri (unlike TGA's
  // kilograms) — do NOT multiply by 1e6 here.
  let sampleMassMg: number | null = null;
  const sizeStr = get("samplesize");
  if (sizeStr) {
    const mg = Number(sizeStr);
    if (Number.isFinite(mg)) sampleMassMg = mg;
  }
  let panMassMg: number | null = null;
  const panMassStr = get("samplepanmass");
  if (panMassStr) {
    const mg = Number(panMassStr);
    if (Number.isFinite(mg)) panMassMg = mg;
  }
  const segmentsStr = get("proceduresegments");
  const methodSteps = segmentsStr
    ? segmentsStr.split(";").map((s) => s.trim()).filter(Boolean)
    : [];
  return {
    instrument: get("instrumenttype") || "DSC25",
    operator: get("operator"),
    sampleName: get("samplename") || fileName.replace(/\.[^.]+$/, ""),
    sampleMassMg,
    panMassMg,
    pan: get("pantype"),
    methodSteps,
    runDate: get("rundate"),
    gases: "",
    // Not present in the .tri header — only the .xls Details sheet's
    // [Configuration] section carries these (§2.2); left blank here so the
    // UI can fall back to "—" rather than showing a wrong value.
    cooler: "",
    cellConstant: "",
    sampleInterval: "",
    // §2.1: the .tri's raw Heat Flow signal is already exo-up, and the .tri
    // header carries no explicit direction flag to read otherwise.
    exoDirection: "up",
  };
}

/**
 * Parse a DSC25 TRIOS `.tri` project file into one run. Pure over the byte
 * buffer; never throws — any decode failure becomes a warning string.
 */
export function parseTriosTri(buffer: ArrayBuffer | Uint8Array, fileName: string): ParsedDscFile {
  const warnings: string[] = [];
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const png = findPngSpan(bytes);
  const pngStart = png ? png.start : bytes.length;

  let header: Record<string, string> = {};
  try {
    header = parseTriosHeader(bytes, pngStart);
  } catch {
    warnings.push(`${fileName}: failed to read the metadata header.`);
  }
  try {
    header = { ...header, ...scanExtraHeaderKeys(bytes, pngStart) };
  } catch {
    /* extra keys are optional metadata — a failure here doesn't block the run */
  }
  // §2.1 correctness fix: proceduresegments/proceduresignals can exceed the
  // 127-byte length `parseTriosHeader` assumes fits in one prefix byte — see
  // `readLongHeaderValue`'s doc comment. Re-read them with the real 7-bit
  // length decoding and prefer that result whenever it succeeds.
  try {
    for (const key of LONG_HEADER_KEYS) {
      const full = readLongHeaderValue(bytes, pngStart, key);
      if (full) header[key] = full;
    }
  } catch {
    /* best-effort re-read — parseTriosHeader's (possibly truncated) value still applies */
  }

  const signalNames = parseSignalNames(header.proceduresignals ?? "");
  const signalCount = signalNames.length || DEFAULT_SIGNAL_COUNT;
  const lowerNames = signalNames.map((s) => s.toLowerCase());
  const iHeatFlow = lowerNames.findIndex((s) => s.startsWith("heat flow") && !s.includes("phase"));

  // Walk every procedure-segment block, using each block's own accurate end
  // offset (from walkBlockSignals) to resume the search — a fixed-stride or
  // "search from block.start + 1" resume would risk re-matching a later,
  // still-monotonic signal (Temperature during a ramp) as a new block.
  const rawBlocks: Float64Array[][] = [];
  let cursor = png ? png.end : 0;
  for (let b = 0; b < 64; b++) {
    const block = findNextBlock(dv, bytes, cursor);
    if (!block) break;
    const { arrays, endOffset } = walkBlockSignals(dv, bytes, block.start, block.length, signalCount);
    if (arrays.length >= 3) rawBlocks.push(arrays);
    cursor = Math.max(block.start + 1, endOffset);
  }

  if (rawBlocks.length === 0) {
    warnings.push(
      `${fileName}: couldn't read the TRIOS DSC binary. Export it from TRIOS as Excel and drop that instead.`,
    );
    return { fileName, runs: [], warnings };
  }

  // §2.1: trim the trailing zero-pad using Heat Flow (index 2 when the
  // header's own signal list is missing/short — proceduresignals lists Time,
  // Temperature, Heat Flow first for every DSC25 method seen). Every array in
  // the block is trimmed to the same kept length.
  const hfIndex = iHeatFlow >= 0 ? iHeatFlow : 2;
  const trimmedBlocks = rawBlocks.map((arrays) => {
    if (arrays.length <= hfIndex) return arrays;
    const keep = trimTrailingZeroRun(arrays[hfIndex]);
    if (keep >= arrays[0].length) return arrays;
    return arrays.map((a) => a.subarray(0, keep));
  });

  const total = trimmedBlocks.reduce((sum, arrays) => sum + arrays[0].length, 0);
  const timeMin = new Float64Array(total);
  const tempC = new Float64Array(total);
  const heatFlowMw = new Float64Array(total);
  const segmentBlocks: SegmentBlock[] = [];
  let w = 0;
  for (const arrays of trimmedBlocks) {
    const t = arrays[0];
    const T = arrays[1];
    const hf = arrays.length > hfIndex ? arrays[hfIndex] : null;
    const segStart = w;
    for (let k = 0; k < t.length; k++) {
      timeMin[w] = t[k] / 60; // seconds → minutes
      tempC[w] = T ? T[k] : NaN;
      heatFlowMw[w] = hf ? hf[k] * 1000 : NaN; // watts → milliwatts
      w++;
    }
    segmentBlocks.push({ start: segStart, end: w, label: "" });
  }
  const n = w;

  const metadata = buildTriosDscMetadata(header, fileName);

  // §2.1: pair segment labels 1:1 with blocks; fall back to positional labels
  // (and a warning) rather than risk mis-pairing.
  const derivedLabels = deriveTriSegmentLabels(metadata.methodSteps);
  const labels =
    derivedLabels.length === segmentBlocks.length
      ? derivedLabels
      : segmentBlocks.map((_, i) => `Segment ${i + 1}`);
  if (derivedLabels.length !== segmentBlocks.length) {
    warnings.push(
      `${fileName}: found ${derivedLabels.length} segment label(s) for ${segmentBlocks.length} data block(s) — using positional labels.`,
    );
  }
  segmentBlocks.forEach((block, i) => {
    block.label = labels[i];
  });

  // Segment ids are stamped with the sample name as a placeholder prefix;
  // the store re-keys them to the adopted run's own id when it builds a
  // `DscRun` from this `ParsedDscRun` (WP2), the same way it assigns `id`.
  const runIdPlaceholder = metadata.sampleName || fileName.replace(/\.[^.]+$/, "");
  const segments = buildSegments(runIdPlaceholder, tempC, timeMin, segmentBlocks);

  const run: ParsedDscRun = {
    label: metadata.sampleName || fileName.replace(/\.[^.]+$/, ""),
    meta: metadata,
    segments,
    timeMin: timeMin.subarray(0, n),
    tempC: tempC.subarray(0, n),
    heatFlowMw: heatFlowMw.subarray(0, n),
  };
  return { fileName, runs: [run], warnings };
}
