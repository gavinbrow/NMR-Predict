// Decode the key/data records of a parsed `.ispd` Berkeley DB (see bdb.ts) into
// a usable IR `Spectrum`. A Shimadzu file holds several "objects", each with a
// set of descriptor/data records keyed `"<objectId> <code> "`:
//   - 100001  axis descriptor (x-unit label + wavenumber range)
//   - 100003  y-unit descriptor
//   - 100008  the float64 data array
// We pick the object whose x-axis is in wavenumbers (cm⁻¹), ignoring the raw
// interferogram object (x-unit "cm").
//
// IMPORTANT: every numeric value in the scientific payload (the data array, the
// range doubles, the descriptor counts) is little-endian regardless of the
// database's own byte order. We read it LE here unconditionally.

import { parseBdb } from "./bdb";
import { linspace } from "./numerics";
import type { Spectrum } from "./types";

/** Acceptable x-unit labels (lowercased, whitespace removed) for a wavenumber axis. */
const WAVENUMBER_UNITS = new Set(["cm-1", "1/cm", "cm^-1"]);

/** Strip trailing NUL bytes from a latin1 key (avoids a control-char regex). */
function stripTrailingNuls(rawKey: string): string {
  let end = rawKey.length;
  while (end > 0 && rawKey.charCodeAt(end - 1) === 0) end -= 1;
  return rawKey.slice(0, end);
}

/** Strip trailing NULs and split the latin1 key on whitespace into its parts. */
function keyParts(rawKey: string): string[] {
  return stripTrailingNuls(rawKey).trim().split(/\s+/).filter(Boolean);
}

/**
 * Index the records by `"<id> <code>"` and list the object ids that carry a
 * 100008 data array (in discovery order — the first matching object wins later).
 */
function indexRecords(records: Map<string, Uint8Array>): {
  index: Map<string, Uint8Array>;
  dataObjectIds: string[];
} {
  const index = new Map<string, Uint8Array>();
  const dataObjectIds: string[] = [];
  for (const [rawKey, data] of records) {
    const parts = keyParts(rawKey);
    if (parts.length !== 2) continue;
    const [id, code] = parts;
    index.set(`${id} ${code}`, data);
    if (code === "100008") dataObjectIds.push(id);
  }
  return { index, dataObjectIds };
}

/**
 * Decode a unit descriptor (100001 / 100003): three u32 fields, then a
 * NUL-terminated latin1 label starting at byte 12. Shorter than 13 bytes → "".
 */
function decodeUnitLabel(data: Uint8Array): string {
  if (data.length < 13) return "";
  let s = "";
  for (let i = 12; i < data.length; i += 1) {
    if (data[i] === 0) break;
    s += String.fromCharCode(data[i]);
  }
  return s;
}

/** Normalize a unit label for matching (lowercase, whitespace removed). */
function normalizeUnit(label: string): string {
  return label.toLowerCase().replace(/\s+/g, "");
}

/** Read `floor(byteLength / 8)` little-endian float64 values. */
function readFloat64ArrayLE(data: Uint8Array): number[] {
  const n = Math.floor(data.byteLength / 8);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i += 1) out[i] = view.getFloat64(i * 8, true);
  return out;
}

/**
 * Locate the wavenumber range inside a 100001 descriptor. Scan byte-by-byte for
 * a u32 equal to the point count `n`; at that offset read xmin (@+20), xmax
 * (@+36), and interval (@+52) as little-endian float64. Accept the first offset
 * where all are finite, `20 < xmin < xmax < 9000`, `interval > 0`, and the
 * interval matches the implied spacing within 1%.
 */
function findWavenumberRange(
  desc: Uint8Array,
  n: number,
): { xmin: number; xmax: number; interval: number } {
  const view = new DataView(desc.buffer, desc.byteOffset, desc.byteLength);
  const length = desc.byteLength;
  for (let pos = 0; pos + 4 <= length; pos += 1) {
    if (view.getUint32(pos, true) !== n) continue;
    if (pos + 60 > length) continue;
    const xmin = view.getFloat64(pos + 20, true);
    const xmax = view.getFloat64(pos + 36, true);
    const interval = view.getFloat64(pos + 52, true);
    if (!Number.isFinite(xmin) || !Number.isFinite(xmax) || !Number.isFinite(interval)) continue;
    if (!(xmin > 20 && xmin < xmax && xmax < 9000)) continue;
    if (!(interval > 0)) continue;
    const step = (xmax - xmin) / (n - 1);
    if (step > 0 && Math.abs(interval - step) / step < 0.01) {
      return { xmin, xmax, interval };
    }
  }
  throw new Error("Could not locate a valid wavenumber axis.");
}

/** NaN-safe maximum over an array (loop, to avoid spread limits on big arrays). */
function arrayMax(values: number[]): number {
  let m = -Infinity;
  for (const v of values) if (Number.isFinite(v) && v > m) m = v;
  return m;
}

/**
 * Turn a parsed BDB record map into a `Spectrum`. Throws with a human-readable
 * message ("No wavenumber spectrum found.", "Could not locate a valid
 * wavenumber axis.") on the expected failure modes.
 */
export function recordsToSpectrum(records: Map<string, Uint8Array>, name: string): Spectrum {
  const { index, dataObjectIds } = indexRecords(records);

  // Pick the first data object whose x-unit (from its 100001 descriptor) reads
  // as wavenumbers; skip the "cm" interferogram object and anything else.
  let objectId: string | null = null;
  for (const id of dataObjectIds) {
    const desc = index.get(`${id} 100001`);
    if (!desc) continue;
    if (WAVENUMBER_UNITS.has(normalizeUnit(decodeUnitLabel(desc)))) {
      objectId = id;
      break;
    }
  }
  if (objectId === null) throw new Error("No wavenumber spectrum found.");

  const dataBytes = index.get(`${objectId} 100008`);
  const desc100001 = index.get(`${objectId} 100001`);
  if (!dataBytes || !desc100001) throw new Error("No wavenumber spectrum found.");

  const y = readFloat64ArrayLE(dataBytes);
  const n = y.length;
  if (n < 2) throw new Error("Spectrum has too few points.");

  const { xmin, xmax } = findWavenumberRange(desc100001, n);

  // Data is stored low-cm⁻¹ first; build the axis directly (do NOT reverse),
  // then argsort ascending and reorder both axes together.
  const x = linspace(xmin, xmax, n);
  const order = x.map((_, i) => i).sort((a, b) => x[a] - x[b]);
  const wavenumber = order.map((i) => x[i]);
  const yOrdered = order.map((i) => y[i]);

  // Decide whether the data is %T or absorbance from the 100003 y-unit (or a
  // magnitude heuristic), then derive the other axis.
  const desc100003 = index.get(`${objectId} 100003`);
  const rawYUnit = desc100003 ? decodeUnitLabel(desc100003) : "";
  const looksLikeTransmittance = rawYUnit.toLowerCase().includes("t") || arrayMax(yOrdered) > 5;

  let absorbance: number[];
  let transmittance: number[];
  if (looksLikeTransmittance) {
    transmittance = yOrdered;
    absorbance = yOrdered.map((v) => 2 - Math.log10(Math.max(v, 1e-6)));
  } else {
    absorbance = yOrdered;
    transmittance = yOrdered.map((v) => 100 * Math.pow(10, -v));
  }

  return {
    wavenumber,
    absorbance,
    transmittance,
    name,
    rawYUnit,
    meta: { nPoints: n, xmin, xmax },
  };
}

// ---------------------------------------------------------------------------
// Per-file loader (browser File → Spectrum) with a content-keyed cache.
// ---------------------------------------------------------------------------

const spectrumCache = new Map<string, Spectrum>();

/** FNV-1a 32-bit hash of the file bytes, for the content cache key. */
function contentHash(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Strip a trailing file extension (e.g. `.ispd`) for the display name. */
function stripExtension(filename: string): string {
  return filename.replace(/\.[^./\\]+$/, "");
}

/**
 * Load and decode a batch of `.ispd` files entirely in the browser. Files are
 * read into ArrayBuffers and never modified. Per-file failures are collected as
 * `"<filename>: <message>"` strings so one bad file doesn't sink the batch.
 * Successful results are cached by filename + content hash.
 */
export async function loadSpectra(
  files: File[] | FileList,
): Promise<{ spectra: Spectrum[]; errors: string[] }> {
  const spectra: Spectrum[] = [];
  const errors: string[] = [];
  for (const file of Array.from(files)) {
    try {
      const buffer = await file.arrayBuffer();
      const cacheKey = `${file.name}:${buffer.byteLength}:${contentHash(buffer)}`;
      let spectrum = spectrumCache.get(cacheKey);
      if (!spectrum) {
        const db = parseBdb(buffer);
        spectrum = recordsToSpectrum(db.records, stripExtension(file.name));
        spectrumCache.set(cacheKey, spectrum);
      }
      spectra.push(spectrum);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${file.name}: ${message}`);
    }
  }
  return { spectra, errors };
}
