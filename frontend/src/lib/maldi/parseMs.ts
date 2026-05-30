// mzML / mzXML / MGF parsing (Phase 4), pure-JS and worker-safe.
//
// These open formats wrap the spectrum in XML (mzML/mzXML) or a text peak list
// (MGF). The XML variants store the m/z and intensity arrays as base64-encoded,
// optionally zlib-compressed IEEE-754 floats. Crucially this runs in the Web
// Worker, where there is no DOMParser — so we extract the relevant blocks with a
// light tag scan rather than a full DOM, decode base64 with `atob`, and inflate
// with the native DecompressionStream. No third-party parser is bundled.

import type { SpectrumData } from "./types";

export type MsFormat = "mzml" | "mzxml" | "mgf";

export interface MsParseMeta {
  format: MsFormat;
  /** Number of spectra found in the file. */
  spectrumCount: number;
  /** Index of the spectrum we returned. */
  selectedIndex: number;
  /** Float precision of the decoded arrays (32 or 64), when known. */
  precisionBits?: number;
  /** Whether the binary arrays were zlib-compressed. */
  compressed?: boolean;
  pointCount: number;
  resorted: boolean;
}

export interface MsParseResult {
  spectrum: SpectrumData;
  meta: MsParseMeta;
}

// --- shared helpers ----------------------------------------------------------

function detectFormat(fileName: string, text: string): MsFormat {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".mgf")) return "mgf";
  if (lower.endsWith(".mzxml")) return "mzxml";
  if (lower.endsWith(".mzml")) return "mzml";
  const head = text.slice(0, 4000);
  if (/BEGIN\s+IONS/i.test(head)) return "mgf";
  if (/<\s*mzML|indexedmzML/i.test(head)) return "mzml";
  if (/<\s*mzXML|<\s*msRun/i.test(head)) return "mzxml";
  throw new Error("Unrecognized file: expected mzML, mzXML, or MGF.");
}

/** Decode a (possibly whitespace-laden) base64 string into bytes. */
function decodeBase64(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Inflate zlib-compressed bytes using the native DecompressionStream. */
async function inflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress zlib mzML/mzXML data.");
  }
  const stream = new Response(
    new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate")),
  );
  const out = await stream.arrayBuffer();
  return new Uint8Array(out);
}

/** Read interleaved or flat IEEE-754 floats into a JS number array. */
function readFloats(bytes: Uint8Array, precisionBits: number, littleEndian: boolean): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = precisionBits === 64 ? 8 : 4;
  const n = Math.floor(bytes.byteLength / size);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = precisionBits === 64
      ? view.getFloat64(i * size, littleEndian)
      : view.getFloat32(i * size, littleEndian);
  }
  return out;
}

function finalize(mz: number[], intensity: number[]): { spectrum: SpectrumData; resorted: boolean } {
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
    const it = new Float64Array(n);
    order.forEach((src, dst) => {
      m[dst] = mz[src];
      it[dst] = intensity[src];
    });
    return { spectrum: { mz: m, intensity: it }, resorted };
  }
  return {
    spectrum: { mz: Float64Array.from(mz.slice(0, n)), intensity: Float64Array.from(intensity.slice(0, n)) },
    resorted,
  };
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? m[1] : undefined;
}

// --- MGF ---------------------------------------------------------------------

function parseMgf(text: string): MsParseResult {
  const blocks: { mz: number[]; intensity: number[] }[] = [];
  let cur: { mz: number[]; intensity: number[] } | null = null;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (/^BEGIN\s+IONS/i.test(line)) {
      cur = { mz: [], intensity: [] };
      continue;
    }
    if (/^END\s+IONS/i.test(line)) {
      if (cur && cur.mz.length) blocks.push(cur);
      cur = null;
      continue;
    }
    if (!cur || !line) continue;
    if (/^[A-Z]+=/.test(line)) continue; // metadata (PEPMASS=, CHARGE=, …)
    const parts = line.split(/\s+/);
    const mz = Number(parts[0]);
    const intensity = parts.length > 1 ? Number(parts[1]) : 1;
    if (Number.isFinite(mz) && Number.isFinite(intensity)) {
      cur.mz.push(mz);
      cur.intensity.push(intensity);
    }
  }
  if (blocks.length === 0) throw new Error("No ion blocks found in MGF file.");
  // Pick the richest block (typically the survey/MS1 list).
  let bestIdx = 0;
  for (let i = 1; i < blocks.length; i += 1) {
    if (blocks[i].mz.length > blocks[bestIdx].mz.length) bestIdx = i;
  }
  const { spectrum, resorted } = finalize(blocks[bestIdx].mz, blocks[bestIdx].intensity);
  return {
    spectrum,
    meta: {
      format: "mgf",
      spectrumCount: blocks.length,
      selectedIndex: bestIdx,
      pointCount: spectrum.mz.length,
      resorted,
    },
  };
}

// --- mzXML -------------------------------------------------------------------

async function parseMzXml(text: string): Promise<MsParseResult> {
  // Each <peaks …>BASE64</peaks> holds interleaved m/z–intensity pairs.
  const peakBlocks = [...text.matchAll(/<peaks\b([^>]*)>([^<]*)<\/peaks>/gi)];
  if (peakBlocks.length === 0) throw new Error("No <peaks> data found in mzXML.");

  // Prefer the first MS-level-1 scan; fall back to the first block.
  const scanLevels = [...text.matchAll(/<scan\b([^>]*)>/gi)].map((m) => Number(attr(m[1], "msLevel") ?? "1"));
  let chosen = 0;
  for (let i = 0; i < peakBlocks.length; i += 1) {
    if ((scanLevels[i] ?? 1) === 1) {
      chosen = i;
      break;
    }
  }

  const tagAttrs = peakBlocks[chosen][1];
  const b64 = peakBlocks[chosen][2];
  const precisionBits = Number(attr(tagAttrs, "precision") ?? "32");
  const byteOrder = attr(tagAttrs, "byteOrder") ?? "network";
  const compression = (attr(tagAttrs, "compressionType") ?? "none").toLowerCase();
  const littleEndian = byteOrder.toLowerCase() !== "network";

  let bytes = decodeBase64(b64);
  const compressed = compression === "zlib";
  if (compressed) bytes = await inflateZlib(bytes);

  const flat = readFloats(bytes, precisionBits, littleEndian);
  const mz: number[] = [];
  const intensity: number[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    mz.push(flat[i]);
    intensity.push(flat[i + 1]);
  }
  if (mz.length === 0) throw new Error("mzXML peaks decoded to zero points.");

  const { spectrum, resorted } = finalize(mz, intensity);
  return {
    spectrum,
    meta: {
      format: "mzxml",
      spectrumCount: peakBlocks.length,
      selectedIndex: chosen,
      precisionBits,
      compressed,
      pointCount: spectrum.mz.length,
      resorted,
    },
  };
}

// --- mzML --------------------------------------------------------------------

interface BinaryArray {
  kind: "mz" | "intensity" | "other";
  precisionBits: number;
  compressed: boolean;
  b64: string;
}

async function parseMzMl(text: string): Promise<MsParseResult> {
  const arrays: BinaryArray[] = [];
  for (const m of text.matchAll(/<binaryDataArray\b[^>]*>([\s\S]*?)<\/binaryDataArray>/gi)) {
    const block = m[1];
    const kind: BinaryArray["kind"] = /MS:1000514/.test(block)
      ? "mz"
      : /MS:1000515/.test(block)
        ? "intensity"
        : "other";
    const precisionBits = /MS:1000523/.test(block) ? 64 : 32;
    const compressed = /MS:1000574/.test(block);
    const bin = block.match(/<binary>([\s\S]*?)<\/binary>/i);
    arrays.push({ kind, precisionBits, compressed, b64: bin ? bin[1] : "" });
  }
  if (arrays.length === 0) throw new Error("No <binaryDataArray> data found in mzML.");

  // Pair the first m/z array with the next intensity array (the first spectrum).
  const mzIdx = arrays.findIndex((a) => a.kind === "mz" && a.b64.trim().length > 0);
  if (mzIdx < 0) throw new Error("mzML has no m/z array.");
  const intIdx = arrays.findIndex((a, i) => i > mzIdx && a.kind === "intensity" && a.b64.trim().length > 0);
  if (intIdx < 0) throw new Error("mzML has no intensity array.");

  const decode = async (a: BinaryArray): Promise<number[]> => {
    let bytes = decodeBase64(a.b64);
    if (a.compressed) bytes = await inflateZlib(bytes);
    return readFloats(bytes, a.precisionBits, true); // mzML binary is little-endian
  };

  const [mz, intensity] = await Promise.all([decode(arrays[mzIdx]), decode(arrays[intIdx])]);
  if (mz.length === 0) throw new Error("mzML m/z array decoded to zero points.");

  const spectrumCount = (text.match(/<spectrum\b/gi) || []).length || 1;
  const { spectrum, resorted } = finalize(mz, intensity);
  return {
    spectrum,
    meta: {
      format: "mzml",
      spectrumCount,
      selectedIndex: 0,
      precisionBits: arrays[mzIdx].precisionBits,
      compressed: arrays[mzIdx].compressed,
      pointCount: spectrum.mz.length,
      resorted,
    },
  };
}

// --- entry point -------------------------------------------------------------

/** Parse an mzML/mzXML/MGF file (by extension, falling back to content sniffing). */
export async function parseMsFile(buffer: ArrayBuffer, fileName: string): Promise<MsParseResult> {
  const text = new TextDecoder("utf-8").decode(buffer);
  const format = detectFormat(fileName, text);
  switch (format) {
    case "mgf":
      return parseMgf(text);
    case "mzxml":
      return parseMzXml(text);
    case "mzml":
      return parseMzMl(text);
  }
}
