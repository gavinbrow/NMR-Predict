// TRIOS `.tri` project file parser (§2.3 of the plan).
//
// Discovery TGA 5500 project file. Proprietary but tractable:
//   - A metadata header (length-prefixed key/value strings) in the first ~750
//     bytes, UTF-8 encoded.
//   - A full PNG preview image embedded at byte 761 (0x89 PNG … IEND ~17914).
//   - After the PNG, the signal data, stored as ONE BLOCK PER PROCEDURE SEGMENT.
//     Each block holds one float32 array per entry in `proceduresignals`
//     (Time; Temperature; Weight; Temperature Difference; Sample Purge;
//     Balance Purge; Set Point), all of the same length N.
//
// Array framing (verified byte-for-byte against `Sample 1.tri`): each array is
// preceded by a descriptor that carries N as a little-endian uint32 at
// `start - 22` AND again at `start - 4`. Within a block the arrays are a fixed
// `N * 4 + 72` bytes apart. Blocks are NOT 4-byte aligned — the isothermal
// block's arrays sit at 24064, 26540, … (aligned) but the ramp block's sit at
// 65689, 204453, … (odd), so every scan here works byte-by-byte.
//
// `Sample 1.tri` contains two blocks: the `Isothermal 1.0 min` segment
// (N = 601) and the `Ramp 10.00 °C/min to 600.00 °C` segment (N = 34 673 —
// the same point count the TRIOS Excel export writes for that ramp). Reading
// only the first block, as an earlier version did, yielded a run that never
// left room temperature. The blocks are concatenated in file order; their time
// axes are already continuous (the ramp's starts at 60.1, right after the
// isothermal's 60.0).
//
// UNITS: the stored Time signal is in SECONDS and Weight in KILOGRAMS. Both are
// converted here (÷ 60 → min, × 1e6 → mg). The seconds reading is what makes
// the file self-consistent: the isothermal block spans 0–60, which is the
// declared 1.0 min, and the ramp block then works out at 10.0 °C/min, matching
// the method line — in minutes it would be 0.17 °C/min over 58 hours.
//
// This is the riskiest parser. It is guarded: every step validates plausibility
// and on any failure returns a friendly warning string instead of throwing.
// The UI surfaces "Couldn't read the TRIOS binary. Export it from TRIOS as
// Excel and drop that instead."

import type { ParsedRun, ParsedTgaFile, TgaMetadata, TgaSegment } from "../types";

/** Find the byte position of a substring in a byte array (ASCII needle). */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let k = 0; k < needle.length; k++) {
      if (haystack[i + k] !== needle[k]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Parse the length-prefixed ASCII header by scanning for known keys. The
 *  header is a stream of `length-byte + that-many-chars` entries alternating
 *  key/value, but some values carry a 1-byte type prefix (e.g. a leading 0x01
 *  before the proceduresignals string), which makes a pure walking parse
 *  drift. Instead, we scan for each known key by its byte signature, read the
 *  length byte that precedes it, and the length byte that follows it for the
 *  value. This is robust to the prefix quirks. The header ends before the PNG
 *  signature (0x89 0x50 0x4E 0x47) embedded around byte 761. */
export function parseTriosHeader(
  bytes: Uint8Array,
  pngStart: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  const knownKeys = [
    "instrumenttype",
    "instrumentserialnumber",
    "instrumentname",
    "companyname",
    "rundate",
    "operator",
    "project",
    "samplename",
    "comments",
    "instrumentmode",
    "testtype",
    "pantype",
    "procedurename",
    "proceduresegments",
    "proceduresignals",
    "samplesize",
    "referencepannumber",
  ];
  for (const key of knownKeys) {
    const keyBytes = new TextEncoder().encode(key);
    // Find the key in the header region. The byte BEFORE it should be its
    // length byte (= key.length). Find all matches and pick the one whose
    // preceding byte equals the key length.
    let pos = -1;
    let from = 0;
    while (from < pngStart) {
      const idx = indexOfBytes(bytes, keyBytes, from);
      if (idx < 0 || idx >= pngStart) break;
      if (idx > 0 && bytes[idx - 1] === key.length) {
        pos = idx;
        break;
      }
      from = idx + 1;
    }
    if (pos < 0) continue;
    // The value follows the key. The only known type prefix is 0x01 before
    // `proceduresignals`'s value (it carries a count of signal-type codes). A
    // genuine value length byte can be as small as 1, so the prefix must be
    // detected conservatively: only skip 0x01 when the NEXT byte, treated as a
    // length, gives a string that is mostly printable ASCII AND the byte
    // itself (0x01) is not a plausible length for the value (a 1-char value is
    // possible but rare for the known keys). This avoids eating a real length
    // byte that happens to be small (e.g. samplename's value length is 8).
    let vStart = pos + key.length;
    if (vStart < bytes.length && bytes[vStart] === 0x01) {
      const candidateLen = bytes[vStart + 1] ?? 0;
      if (vStart + 2 + candidateLen <= bytes.length && candidateLen > 2) {
        const candidate = decodeText(bytes.subarray(vStart + 2, vStart + 2 + candidateLen));
        let printable = 0;
        for (let k = 0; k < candidate.length; k++) {
          const c = candidate.charCodeAt(k);
          if ((c >= 32 && c < 127) || c === 0xb0 || c > 0x7f) printable++;
        }
        // Require a high printable ratio AND that the candidate is longer than
        // the prefix-byte interpretation (1 char), so a 1-char real value is not
        // eaten. proceduresignals' candidate is ~129 chars, so this is safe.
        if (printable >= candidate.length * 0.7) vStart++;
      }
    }
    if (vStart >= bytes.length) continue;
    const vLen = bytes[vStart];
    if (vLen > 250 || vStart + 1 + vLen > bytes.length) continue;
    const value = decodeText(bytes.subarray(vStart + 1, vStart + 1 + vLen));
    // Some values also carry a leading control char in the string itself
    // (proceduresignals starts with 0x01). Strip leading non-printable bytes
    // without a control-char regex (which trips `no-control-regex`).
    let cleaned = value;
    while (cleaned.length > 0 && cleaned.charCodeAt(0) < 32) cleaned = cleaned.slice(1);
    out[key] = cleaned;
  }
  return out;
}

/**
 * Decode a header string. TRIOS writes UTF-8, so "°C" arrives as C2 B0 —
 * decoding it as latin1 turns every method line into "10.00 Â°C/min". Strict
 * UTF-8 first, falling back to latin1 for the odd field that genuinely is
 * single-byte (and so would make the strict decoder throw).
 */
function decodeText(slice: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(slice);
  } catch {
    let out = "";
    for (let k = 0; k < slice.length; k++) out += String.fromCharCode(slice[k]);
    return out;
  }
}

/** Locate the PNG preview image and return its byte span. The PNG starts at the
 *  0x89 0x50 0x4E 0x47 signature and ends at the IEND chunk (0x49 0x45 0x4E 0x44
 *  followed by a 4-byte CRC). */
export function findPngSpan(bytes: Uint8Array): { start: number; end: number } | null {
  const pngSig = [0x89, 0x50, 0x4e, 0x47];
  const iend = [0x49, 0x45, 0x4e, 0x44];
  const start = indexOfBytes(bytes, new Uint8Array(pngSig));
  if (start < 0) return null;
  // Find IEND after the start; the chunk is "IEND" + 4-byte CRC.
  let iendPos = -1;
  for (let i = start; i + 8 <= bytes.length; i++) {
    if (
      bytes[i] === iend[0] &&
      bytes[i + 1] === iend[1] &&
      bytes[i + 2] === iend[2] &&
      bytes[i + 3] === iend[3]
    ) {
      iendPos = i;
    }
  }
  if (iendPos < 0) return { start, end: bytes.length };
  return { start, end: Math.min(bytes.length, iendPos + 8) };
}

/** Bytes between the start of one array in a block and the start of the next:
 *  the array itself plus a fixed 72-byte inter-array descriptor. */
const ARRAY_GAP = 72;
/** Offset back from an array's start at which its length is repeated. */
const COUNT_OFFSETS = [4, 22];
/** Shortest array we will accept as a segment's time axis. */
const MIN_BLOCK_POINTS = 30;
/** Longest plausible point count, as a guard against reading garbage as a length. */
const MAX_BLOCK_POINTS = 20_000_000;

/** Read `count` little-endian float32s into a Float64Array. */
function readF32(dv: DataView, start: number, count: number): Float64Array {
  const out = new Float64Array(count);
  for (let k = 0; k < count; k++) out[k] = dv.getFloat32(start + k * 4, true);
  return out;
}

/** A strictly ascending, finite, non-negative run — the shape a segment's time
 *  axis always has, and the discriminator that keeps the block scan off the
 *  all-zero and non-monotonic arrays that share the same framing. */
function isPlausibleTimeAxis(values: Float64Array): boolean {
  if (values.length < MIN_BLOCK_POINTS) return false;
  let prev = -Infinity;
  for (let k = 0; k < values.length; k++) {
    const v = values[k];
    if (!Number.isFinite(v) || v < 0 || v > 1e8 || v <= prev) return false;
    prev = v;
  }
  return values[values.length - 1] > values[0];
}

/**
 * Find the next segment block at or after `from`: a position whose descriptor
 * repeats the same length N at both {@link COUNT_OFFSETS} before the array, and
 * whose array reads as a time axis. Returns the array's start offset and N.
 *
 * Scans byte-by-byte on purpose — the ramp block in `Sample 1.tri` starts at an
 * ODD offset, so a 4-byte-stride scan walks straight past it.
 */
export function findNextBlock(
  dv: DataView,
  bytes: Uint8Array,
  from: number,
): { start: number; length: number } | null {
  const limit = bytes.length;
  for (let p = Math.max(0, from); p + 26 <= limit; p++) {
    const n = dv.getUint32(p, true);
    if (n < MIN_BLOCK_POINTS || n > MAX_BLOCK_POINTS) continue;
    const start = p + COUNT_OFFSETS[1];
    if (start + n * 4 > limit) continue;
    // The same count must appear again immediately before the array.
    if (dv.getUint32(start - COUNT_OFFSETS[0], true) !== n) continue;
    const values = readF32(dv, start, n);
    if (!isPlausibleTimeAxis(values)) continue;
    return { start, length: n };
  }
  return null;
}

/**
 * Read one block's signal arrays: the time axis at `start`, then one array per
 * remaining signal name at a fixed stride, each verified by the length repeated
 * just before it. Stops early (rather than reading garbage) the moment a
 * verification fails.
 */
export function readBlockArrays(
  dv: DataView,
  bytes: Uint8Array,
  start: number,
  n: number,
  signalCount: number,
): Float64Array[] {
  const arrays: Float64Array[] = [];
  const stride = n * 4 + ARRAY_GAP;
  for (let s = 0; s < signalCount; s++) {
    const arrayStart = start + s * stride;
    if (arrayStart + n * 4 > bytes.length) break;
    if (s > 0 && dv.getUint32(arrayStart - COUNT_OFFSETS[0], true) !== n) break;
    arrays.push(readF32(dv, arrayStart, n));
  }
  return arrays;
}

/** Build the metadata from the parsed header map. */
export function buildTriosMetadata(
  header: Record<string, string>,
  fileName: string,
): TgaMetadata {
  const get = (k: string): string => header[k] ?? "";
  // samplesize is in kg in the header — convert to mg.
  let sampleSizeMg: number | null = null;
  const sizeStr = get("samplesize");
  if (sizeStr) {
    const kg = Number(sizeStr);
    if (Number.isFinite(kg)) sampleSizeMg = kg * 1e6; // kg → mg
  }
  const segmentsStr = get("proceduresegments");
  const methodSteps = segmentsStr
    ? segmentsStr.split(";").map((s) => s.trim()).filter(Boolean)
    : [];
  let gases = "";
  if (/nitrogen|n2/i.test(segmentsStr)) gases = "N2";
  else if (/air|oxygen/i.test(segmentsStr)) gases = "Air";
  return {
    instrument: get("instrumenttype") || "TGA5500",
    operator: get("operator"),
    sampleName: get("samplename") || fileName.replace(/\.[^.]+$/, ""),
    sampleSizeMg,
    pan: get("pantype"),
    methodSteps,
    runDate: get("rundate"),
    gases,
  };
}

/** Parse a TRIOS `.tri` project file into one run. Pure over the byte buffer;
 *  guarded so any decode failure produces a friendly warning instead of a
 *  throw. */
export function parseTriosTri(buffer: ArrayBuffer | Uint8Array, fileName: string): ParsedTgaFile {
  const warnings: string[] = [];
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // 1. Locate the PNG preview and use its start as the header boundary.
  const png = findPngSpan(bytes);
  const pngStart = png ? png.start : bytes.length;
  // 2. Parse the header up to the PNG.
  let header: Record<string, string> = {};
  try {
    header = parseTriosHeader(bytes, pngStart);
  } catch {
    warnings.push(`${fileName}: failed to read the metadata header.`);
  }
  // 3. Proceduresignals names — the value may carry a leading control byte; strip
  //    non-printable chars and split on "; ".
  const signalsRaw = header.proceduresignals ?? "";
  const signalNames = signalsRaw
    .split(";")
    .map((s) => {
      // Strip leading control chars (the first signal may carry a 0x01 prefix).
      let t = s;
      while (t.length > 0 && t.charCodeAt(0) < 32) t = t.slice(1);
      return t.trim();
    })
    .filter(Boolean);

  // 4. Walk every segment block and concatenate. A TRIOS procedure with an
  //    isothermal hold followed by a ramp stores TWO blocks; reading only the
  //    first would report a run that never heats up.
  const signalCount = signalNames.length || 7;
  const blocks: Float64Array[][] = [];
  let cursor = png ? png.end : 0;
  // A generous cap: no real procedure has hundreds of segments, and this keeps
  // a corrupt file from turning the scan into a long loop.
  for (let b = 0; b < 64; b++) {
    const block = findNextBlock(dv, bytes, cursor);
    if (!block) break;
    const arrays = readBlockArrays(dv, bytes, block.start, block.length, signalCount);
    if (arrays.length > 0) blocks.push(arrays);
    // Resume past this block's arrays so the next scan can't re-find them.
    cursor = block.start + Math.max(1, arrays.length) * (block.length * 4 + ARRAY_GAP);
  }

  if (blocks.length === 0) {
    warnings.push(
      `${fileName}: couldn't read the TRIOS binary. Export it from TRIOS as Excel and drop that instead.`,
    );
    return { fileName, runs: [], warnings };
  }

  // 5. Map the signal names to our three core arrays, then concatenate the
  //    blocks in file order (their time axes are already continuous).
  const lower = signalNames.map((s) => s.toLowerCase());
  const indexOfSignal = (prefix: string) => lower.findIndex((s) => s.startsWith(prefix));
  const iTime = indexOfSignal("time");
  const iTemp = indexOfSignal("temp");
  // "Temperature Difference" also starts with "temp", so the weight lookup is
  // the only one that needs no disambiguation; the temperature lookup takes the
  // FIRST match, which is the plain Temperature signal in every file seen.
  const iWeight = indexOfSignal("weight");
  if (iTime < 0 || iTemp < 0 || iWeight < 0) {
    warnings.push(
      `${fileName}: missing a Time/Temperature/Weight signal in the proceduresignals.`,
    );
    return { fileName, runs: [], warnings };
  }

  const usable = blocks.filter(
    (arrays) => arrays.length > Math.max(iTime, iTemp, iWeight),
  );
  if (usable.length === 0) {
    warnings.push(`${fileName}: no complete signal block decoded.`);
    return { fileName, runs: [], warnings };
  }
  if (usable.length < blocks.length) {
    warnings.push(
      `${fileName}: ${blocks.length - usable.length} incomplete segment block(s) skipped.`,
    );
  }

  const total = usable.reduce((sum, arrays) => sum + arrays[iTime].length, 0);
  const timeMin = new Float64Array(total);
  const tempC = new Float64Array(total);
  const weightMg = new Float64Array(total);
  let w = 0;
  let lastTime = -Infinity;
  for (const arrays of usable) {
    const t = arrays[iTime];
    const T = arrays[iTemp];
    const m = arrays[iWeight];
    for (let k = 0; k < t.length; k++) {
      // Time is seconds in the file; weight is kilograms.
      const tMin = t[k] / 60;
      if (tMin <= lastTime) continue; // keep the concatenated axis strictly ascending
      timeMin[w] = tMin;
      tempC[w] = T[k];
      weightMg[w] = m[k] * 1e6;
      lastTime = tMin;
      w++;
    }
  }
  const n = w;

  // Validate ranges: Temperature 0–1500 °C, Weight 0–1e4 mg.
  let outOfRange = false;
  for (let k = 0; k < n; k++) {
    if (tempC[k] < 0 || tempC[k] > 1500 || weightMg[k] < 0 || weightMg[k] > 1e4) {
      outOfRange = true;
      break;
    }
  }
  if (outOfRange) {
    warnings.push(`${fileName}: signal values out of range — the TRIOS binary may be corrupt.`);
  }

  const metadata = buildTriosMetadata(header, fileName);
  const segments: TgaSegment[] = metadata.methodSteps.length
    ? metadata.methodSteps.map((label) => ({ label }))
    : [{ label: "TGA" }];
  const run: ParsedRun = {
    label: metadata.sampleName || fileName.replace(/\.[^.]+$/, ""),
    meta: metadata,
    segments,
    timeMin: timeMin.subarray(0, n),
    tempC: tempC.subarray(0, n),
    weightMg: weightMg.subarray(0, n),
  };
  return { fileName, runs: [run], warnings };
}