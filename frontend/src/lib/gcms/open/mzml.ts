// mzML parser (GC/MS workspace, WP2). Worker-safe: no DOMParser, no document.
//
// We scan the bytes for `<spectrum` / `</spectrum>` boundaries and decode ONE
// spectrum block at a time with TextDecoder, so a 300 MB file never materializes
// as a single string. Base64 via `atob`, zlib via native `DecompressionStream`.
//
// Only MS1 scans are retained; MS2+ scans are counted and reported in warnings.
// Numpress and integer array encodings are explicitly rejected (warned, skipped)
// rather than being silently reinterpreted as 32-bit floats.

import type { MsRun, RunMeta } from "../types";

export function isMzml(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, Math.min(bytes.length, 4096));
  // search for "<mzML" or "<indexedmzML"
  return containsBytes(head, MZML_OPEN) || containsBytes(head, INDEXED_MZML_OPEN);
}

const MZML_OPEN = stringBytes("<mzML");
const INDEXED_MZML_OPEN = stringBytes("<indexedmzML");

function stringBytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 1) out.push(s.charCodeAt(i));
  return out;
}

function containsBytes(hay: Uint8Array, needle: number[]): boolean {
  outer: for (let i = 0; i <= hay.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

// Find the next occurrence of a byte needle starting at `from` in `bytes`.
function findBytes(bytes: Uint8Array, needle: number[], from: number): number {
  outer: for (let i = from; i <= bytes.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const SPEC_OPEN = stringBytes("<spectrum");
const SPEC_CLOSE = stringBytes("</spectrum>");
const SELF_CLOSE = stringBytes("/>");

function decodeBase64(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function inflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("DecompressionStream unavailable; cannot inflate zlib mzML data.");
  }
  const stream = new Response(
    new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate")),
  );
  const out = await stream.arrayBuffer();
  return new Uint8Array(out);
}

function readFloats(bytes: Uint8Array, precisionBits: number, littleEndian: boolean): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = precisionBits === 64 ? 8 : 4;
  const n = Math.floor(bytes.byteLength / size);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = precisionBits === 64 ? view.getFloat64(i * size, littleEndian) : view.getFloat32(i * size, littleEndian);
  }
  return out;
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? m[1] : undefined;
}

function cvValue(block: string, accession: string): string | undefined {
  const re = new RegExp(`<cvParam\\s+[^>]*accession\\s*=\\s*"${accession}"[^>]*>`, "i");
  const m = block.match(re);
  if (!m) return undefined;
  const v = attr(m[0], "value");
  return v;
}

function hasCvParam(block: string, accession: string): boolean {
  const re = new RegExp(`<cvParam\\s+[^>]*accession\\s*=\\s*"${accession}"`, "i");
  return re.test(block);
}

// Accessions we explicitly refuse (numpress / integer arrays).
const NUMPRESS = new Set(["MS:1002312", "MS:1002313", "MS:1002314"]);
const INT_ARRAYS = new Set(["MS:1000519", "MS:1000522"]);

interface SpecArrays {
  mz: number[];
  intensity: number[];
}

async function decodeBinaryArrays(spectrumBlock: string, defaultArrayLength: number): Promise<SpecArrays | null> {
  // collect each <binaryDataArray>...</binaryDataArray>
  const bdaRe = /<binaryDataArray\b[^>]*>([\s\S]*?)<\/binaryDataArray>/gi;
  let mzArr: number[] | null = null;
  let intArr: number[] | null = null;
  let m: RegExpExecArray | null;
  while ((m = bdaRe.exec(spectrumBlock)) !== null) {
    const block = m[1];
    // Detect unsupported encodings on this array.
    let unsupported: string | null = null;
    for (const acc of NUMPRESS) {
      if (hasCvParam(block, acc)) {
        unsupported = acc;
        break;
      }
    }
    if (!unsupported) {
      for (const acc of INT_ARRAYS) {
        if (hasCvParam(block, acc)) {
          unsupported = acc;
          break;
        }
      }
    }
    if (unsupported) {
      throw new Error(`unsupported binary encoding ${unsupported} on a <binaryDataArray>`);
    }
    const isMz = hasCvParam(block, "MS:1000514");
    const isInt = hasCvParam(block, "MS:1000515");
    if (!isMz && !isInt) continue;
    const precisionBits = hasCvParam(block, "MS:1000523") ? 64 : 32;
    const compressed = hasCvParam(block, "MS:1000574");
    const bin = block.match(/<binary>([\s\S]*?)<\/binary>/i);
    if (!bin) continue;
    let bytes = decodeBase64(bin[1]);
    if (compressed) bytes = await inflateZlib(bytes);
    const floats = readFloats(bytes, precisionBits, true);
    if (isMz) mzArr = floats;
    else intArr = floats;
  }
  if (mzArr === null || intArr === null) {
    if (defaultArrayLength === 0) return { mz: [], intensity: [] };
    return null;
  }
  return { mz: mzArr, intensity: intArr };
}

function sortScanAsc(mz: number[], intensity: number[]): { mz: Float64Array; intensity: Float32Array; resorted: boolean } {
  const n = Math.min(mz.length, intensity.length);
  let resorted = false;
  for (let i = 1; i < n; i += 1) {
    if (mz[i] < mz[i - 1]) {
      resorted = true;
      break;
    }
  }
  if (resorted) {
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => mz[a] - mz[b]);
    const m = new Float64Array(n);
    const it = new Float32Array(n);
    for (let d = 0; d < n; d += 1) {
      m[d] = mz[order[d]];
      it[d] = intensity[order[d]];
    }
    return { mz: m, intensity: it, resorted };
  }
  return { mz: Float64Array.from(mz.slice(0, n)), intensity: Float32Array.from(intensity.slice(0, n)), resorted };
}

function emptyRun(opts: { name?: string; sourcePath?: string }, warnings: string[]): MsRun {
  return {
    id: crypto.randomUUID(),
    name: opts.name ?? "",
    sourcePath: opts.sourcePath ?? "",
    format: "mzml",
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
    meta: {},
    warnings,
  };
}

export async function parseMzml(
  buffer: ArrayBuffer,
  opts?: { name?: string; sourcePath?: string; onProgress?: (f: number) => void },
): Promise<MsRun> {
  const warnings: string[] = [];
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder("utf-8");

  // Walk the file for <spectrum ...> ... </spectrum> blocks. Handle self-closing
  // <spectrum .../> (no data) by skipping them.
  const scanBlocks: { block: string; start: number }[] = [];
  let i = 0;
  while (true) {
    const open = findBytes(bytes, SPEC_OPEN, i);
    if (open < 0) break;
    // Is it self-closing? Find the next '>' after the open tag.
    const gt = findBytes(bytes, [0x3e], open); // '>'
    if (gt < 0) break;
    if (gt >= 1 && bytes[gt - 1] === 0x2f /* '/' */) {
      // self-closing <spectrum .../> — skip
      i = gt + 1;
      continue;
    }
    const close = findBytes(bytes, SPEC_CLOSE, gt);
    if (close < 0) {
      warnings.push("mzML: a <spectrum> was not closed; ignoring the rest of the file.");
      break;
    }
    const end = close + SPEC_CLOSE.length;
    const sub = bytes.subarray(open, end);
    scanBlocks.push({ block: decoder.decode(sub), start: open });
    i = end;
  }

  if (scanBlocks.length === 0) {
    warnings.push("mzML: no <spectrum> elements found.");
    return emptyRun(opts ?? {}, warnings);
  }

  const MAX_SCANS = 200_000;
  const MAX_POINTS = 50_000_000;
  if (scanBlocks.length > MAX_SCANS) {
    warnings.push(`mzML: ${scanBlocks.length} spectra exceeds the ${MAX_SCANS} scan cap; truncating.`);
    scanBlocks.length = MAX_SCANS;
  }

  const rtMin: number[] = [];
  const tic: number[] = [];
  const basePeakMz: number[] = [];
  const basePeakIntensity: number[] = [];
  const msLevel: number[] = [];
  const mzParts: number[][] = [];
  const intParts: number[][] = [];
  let pointCount = 0;
  let ms2Count = 0;

  for (let s = 0; s < scanBlocks.length; s += 1) {
    if (opts?.onProgress && s % 200 === 0 && s > 0) {
      opts.onProgress(s / scanBlocks.length);
    }
    const block = scanBlocks[s].block;
    // extract the opening tag attributes
    const openTagMatch = block.match(/<spectrum\b([^>]*)>/i);
    const openTag = openTagMatch ? openTagMatch[1] : "";
    const defaultArrayLength = Number(attr(openTag, "defaultArrayLength") ?? "0");

    // ms level
    const msLevelStr = cvValue(block, "MS:1000511");
    const level = msLevelStr !== undefined ? Number(msLevelStr) : 1;
    const levelNum = Number.isFinite(level) ? level : 1;

    // polarity
    // (read but only used for meta if we ever fill it; keep simple)
    // scan start time
    let rtMinVal = NaN;
    const sst = cvValue(block, "MS:1000016");
    if (sst !== undefined) {
      const num = Number(sst);
      if (Number.isFinite(num)) {
        // unit: look for unitName attribute on the same cvParam
        const re = new RegExp(`<cvParam\\s+[^>]*accession\\s*=\\s*"MS:1000016"[^>]*>`, "i");
        const cm = block.match(re);
        const unit = cm ? attr(cm[0], "unitName") : undefined;
        if (unit && /second/i.test(unit)) rtMinVal = num / 60;
        else rtMinVal = num; // minute (default) or anything else treated as minute
      }
    }

    const ticStr = cvValue(block, "MS:1000285");
    const ticVal = ticStr !== undefined ? Number(ticStr) : NaN;
    const bpmzStr = cvValue(block, "MS:1000504");
    const bpmzVal = bpmzStr !== undefined ? Number(bpmzStr) : NaN;
    const bpintStr = cvValue(block, "MS:1000505");
    const bpintVal = bpintStr !== undefined ? Number(bpintStr) : NaN;

    // Decode arrays
    let arrays: SpecArrays | null = null;
    try {
      arrays = await decodeBinaryArrays(block, defaultArrayLength);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`mzML: spectrum ${s}: ${msg}; skipped.`);
      continue;
    }
    if (!arrays) {
      warnings.push(`mzML: spectrum ${s}: could not find both m/z and intensity arrays; skipped.`);
      continue;
    }

    if (levelNum >= 2) {
      ms2Count += 1;
      continue;
    }

    // sort ascending
    const sorted = sortScanAsc(arrays.mz, arrays.intensity);
    if (sorted.resorted) warnings.push(`mzML: scan ${s} m/z array was unsorted and got re-sorted.`);

    rtMin.push(Number.isFinite(rtMinVal) ? rtMinVal : 0);
    tic.push(Number.isFinite(ticVal) ? ticVal : 0);
    basePeakMz.push(Number.isFinite(bpmzVal) ? bpmzVal : 0);
    basePeakIntensity.push(Number.isFinite(bpintVal) ? bpintVal : 0);
    msLevel.push(1);
    mzParts.push(Array.from(sorted.mz));
    intParts.push(Array.from(sorted.intensity));
    pointCount += sorted.mz.length;

    if (pointCount > MAX_POINTS) {
      warnings.push(`mzML: exceeded ${MAX_POINTS} total points; truncating remaining spectra.`);
      break;
    }
  }

  if (ms2Count > 0) {
    warnings.push(`mzML: ${ms2Count} MS2+ spectra were excluded (only MS1 retained).`);
  }

  const scanCount = mzParts.length;
  const scanOffset = new Uint32Array(scanCount + 1);
  let acc = 0;
  for (let s = 0; s < scanCount; s += 1) {
    scanOffset[s] = acc;
    acc += mzParts[s].length;
  }
  scanOffset[scanCount] = acc;

  const mzFlat = new Float64Array(acc);
  const intFlat = new Float32Array(acc);
  let off = 0;
  for (let s = 0; s < scanCount; s += 1) {
    mzFlat.set(mzParts[s], off);
    intFlat.set(intParts[s], off);
    off += mzParts[s].length;
  }

  let mzLo = Infinity;
  let mzHi = -Infinity;
  let rtLo = Infinity;
  let rtHi = -Infinity;
  let ticLo = Infinity;
  let ticHi = -Infinity;
  for (let s = 0; s < scanCount; s += 1) {
    if (rtMin[s] < rtLo) rtLo = rtMin[s];
    if (rtMin[s] > rtHi) rtHi = rtMin[s];
    if (tic[s] < ticLo) ticLo = tic[s];
    if (tic[s] > ticHi) ticHi = tic[s];
  }
  for (let s = 0; s < scanCount; s += 1) {
    const lo = scanOffset[s];
    const hi = scanOffset[s + 1];
    if (hi > lo) {
      if (mzFlat[lo] < mzLo) mzLo = mzFlat[lo];
      if (mzFlat[hi - 1] > mzHi) mzHi = mzFlat[hi - 1];
    }
  }
  if (!Number.isFinite(mzLo)) mzLo = 0;
  if (!Number.isFinite(mzHi)) mzHi = 0;
  if (!Number.isFinite(rtLo)) rtLo = 0;
  if (!Number.isFinite(rtHi)) rtHi = 0;
  if (!Number.isFinite(ticLo)) ticLo = 0;
  if (!Number.isFinite(ticHi)) ticHi = 0;

  const meta: RunMeta = {};
  // (Minimal meta extraction; mzML instrument/run tags vary widely.)

  if (opts?.onProgress) opts.onProgress(1);

  return {
    id: crypto.randomUUID(),
    name: opts?.name ?? "",
    sourcePath: opts?.sourcePath ?? "",
    format: "mzml",
    detector: "ms",
    rtMin: Float64Array.from(rtMin),
    tic: Float64Array.from(tic),
    basePeakMz: Float64Array.from(basePeakMz),
    basePeakIntensity: Float64Array.from(basePeakIntensity),
    msLevel: Uint8Array.from(msLevel),
    scanOffset,
    mz: mzFlat,
    intensity: intFlat,
    scanCount,
    pointCount: acc,
    mzRange: [mzLo, mzHi],
    rtRange: [rtLo, rtHi],
    ticRange: [ticLo, ticHi],
    meta,
    warnings,
  };
}