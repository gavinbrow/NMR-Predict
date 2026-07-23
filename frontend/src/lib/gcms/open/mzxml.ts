// mzXML parser (GC/MS workspace, WP2). Worker-safe: no DOMParser.
//
// CRITICAL: parse <scan> elements STRUCTURALLY. mzXML nests MS2 <scan> inside
// MS1 <scan>, and each <scan> has its own nested <peaks> child. We must NOT
// collect all <scan> attributes and all <peaks> bodies into parallel arrays
// and pair them by index (that is the bug in the old gpc/parseMs.ts — it loses
// the nesting and silently mismatches scans with peaks).
//
// We walk the text as a tree of <scan>...</scan> regions, and for each scan we
// read ITS OWN nearest <peaks> child (the one inside that scan but before any
// nested <scan>). byteOrder "network" = BIG-ENDIAN (mzXML default, differs from
// mzML). <peaks> holds INTERLEAVED m/z-intensity pairs.

import type { MsRun, RunMeta } from "../types";

export function isMzxml(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, Math.min(bytes.length, 4096));
  const needle = stringBytes("<mzXML");
  return containsBytes(head, needle);
}

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

function decodeBase64(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function inflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("DecompressionStream unavailable; cannot inflate zlib mzXML data.");
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

// Parse retentionTime="PT123.45S" -> minutes. Also handle PT#M and PT#H.
// A bare number with NO unit is conventionally MINUTES in mzXML files in the
// wild; we treat it as minutes and push a one-time warning to the supplied
// `warnings` array (deduplicated) so the caller knows the unit was assumed.
function parseRetentionTime(rt: string | undefined, warnings: string[]): number {
  if (rt === undefined) return NaN;
  const trimmed = rt.trim();
  // ISO-8601 duration: optional "P", optional "T", a number, then a unit.
  // Accept seconds (S), minutes (M), or hours (H), case-insensitive. Also
  // tolerate forms like "PT2H30M" / "PT1H2M3S" by summing the components.
  const iso = trimmed.match(/^P(?:T)?([0-9]+(?:\.[0-9]+)?)([SMH])(?![0-9.])/i);
  if (iso) {
    const num = Number(iso[1]);
    const unit = iso[2].toUpperCase();
    if (unit === "S") return num / 60;
    if (unit === "M") return num;
    if (unit === "H") return num * 60;
    return NaN;
  }
  // Compound ISO-8601 duration like "PT1H2M3S" — sum components.
  const compound = trimmed.match(/^P(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (compound && (compound[1] || compound[2] || compound[3])) {
    const h = compound[1] ? Number(compound[1]) : 0;
    const m = compound[2] ? Number(compound[2]) : 0;
    const s = compound[3] ? Number(compound[3]) : 0;
    return h * 60 + m + s / 60;
  }
  // Bare number with no unit: conventionally MINUTES in mzXML files in the wild.
  const num = Number(trimmed);
  if (Number.isFinite(num)) {
    const warn =
      "mzXML: retentionTime has no unit; assumed minutes for one or more scans.";
    if (!warnings.includes(warn)) warnings.push(warn);
    return num;
  }
  return NaN;
}

interface ScanNode {
  attrs: string;
  peaksAttrs: string;
  peaksB64: string;
  children: ScanNode[];
  startIndex: number;
}

// Find the index of the next occurrence of `needle` in `text` at/after `from`.
function indexOf(text: string, needle: string, from: number): number {
  return text.indexOf(needle, from);
}

// Parse a <scan>...</scan> region starting at the `<scan` at text position `start`.
// Returns the node and the index just past the closing </scan>.
function parseScan(text: string, start: number): { node: ScanNode; end: number } | null {
  // start points at '<scan'. Find the end of the open tag.
  const tagEnd = indexOf(text, ">", start);
  if (tagEnd < 0) return null;
  const isSelfClose = text[tagEnd - 1] === "/";
  const attrs = text.slice(start + 5, tagEnd - (isSelfClose ? 1 : 0));
  const node: ScanNode = {
    attrs,
    peaksAttrs: "",
    peaksB64: "",
    children: [],
    startIndex: 0,
  };
  if (isSelfClose) {
    return { node, end: tagEnd + 1 };
  }
  let pos = tagEnd + 1;
  // We are inside the scan body. Walk until we hit either a nested <scan,
  // a <peaks, or the matching </scan>. Because mzXML nests scans, we must
  // balance <scan>...</scan> ourselves rather than using the first </scan>.
  const childStack: ScanNode[] = [node];
  while (pos < text.length) {
    const nextScan = indexOf(text, "<scan", pos);
    const nextPeaks = indexOf(text, "<peaks", pos);
    const nextClose = indexOf(text, "</scan", pos);

    // Pick the earliest of the three that is >= pos.
    let next = -1;
    let kind: "scan" | "peaks" | "close" = "close";
    for (const [idx, k] of [
      [nextScan, "scan"],
      [nextPeaks, "peaks"],
      [nextClose, "close"],
    ] as const) {
      if (idx >= pos && (next === -1 || idx < next)) {
        next = idx;
        kind = k as "scan" | "peaks" | "close";
      }
    }
    if (next < 0) {
      // ran off the end; treat as end of this scan
      return { node, end: text.length };
    }

    if (kind === "scan") {
      const child = parseScan(text, next);
      if (!child) return { node, end: text.length };
      childStack[childStack.length - 1].children.push(child.node);
      pos = child.end;
    } else if (kind === "peaks") {
      // attach to the innermost currently-open scan
      const owner = childStack[childStack.length - 1];
      const peaksTagEnd = indexOf(text, ">", next);
      if (peaksTagEnd < 0) return { node, end: text.length };
      const peaksSelfClose = text[peaksTagEnd - 1] === "/";
      const peaksAttrs = text.slice(next + 6, peaksTagEnd - (peaksSelfClose ? 1 : 0));
      owner.peaksAttrs = peaksAttrs;
      if (peaksSelfClose) {
        owner.peaksB64 = "";
        pos = peaksTagEnd + 1;
      } else {
        const peaksClose = indexOf(text, "</peaks", peaksTagEnd);
        if (peaksClose < 0) return { node, end: text.length };
        owner.peaksB64 = text.slice(peaksTagEnd + 1, peaksClose);
        const gt = indexOf(text, ">", peaksClose);
        pos = gt < 0 ? text.length : gt + 1;
      }
    } else {
      // </scan> closes the innermost scan
      const gt = indexOf(text, ">", next);
      if (gt < 0) return { node, end: text.length };
      childStack.pop();
      pos = gt + 1;
      if (childStack.length === 0) {
        return { node, end: pos };
      }
    }
  }
  return { node, end: text.length };
}

interface FlatScan {
  attrs: string;
  peaksAttrs: string;
  peaksB64: string;
  depth: number;
}

function flatten(node: ScanNode, depth: number, out: FlatScan[]): void {
  out.push({ attrs: node.attrs, peaksAttrs: node.peaksAttrs, peaksB64: node.peaksB64, depth });
  for (const c of node.children) flatten(c, depth + 1, out);
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
    format: "mzxml",
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

const MAX_SCANS = 200_000;
const MAX_POINTS = 50_000_000;

export async function parseMzxml(
  buffer: ArrayBuffer,
  opts?: { name?: string; sourcePath?: string; onProgress?: (f: number) => void },
): Promise<MsRun> {
  const warnings: string[] = [];
  const bytes = new Uint8Array(buffer);
  const text = new TextDecoder("utf-8").decode(bytes);

  // Find the first <scan ...> in the file. mzXML wraps scans in <msRun>, but
  // we only care about the <scan> tree itself.
  const firstScan = indexOf(text, "<scan", 0);
  if (firstScan < 0) {
    warnings.push("mzXML: no <scan> elements found.");
    return emptyRun(opts ?? {}, warnings);
  }

  const root = parseScan(text, firstScan);
  if (!root) {
    warnings.push("mzXML: could not parse the <scan> tree.");
    return emptyRun(opts ?? {}, warnings);
  }

  const flat: FlatScan[] = [];
  flatten(root.node, 0, flat);

  if (flat.length === 0) {
    warnings.push("mzXML: no <scan> elements found.");
    return emptyRun(opts ?? {}, warnings);
  }

  let scanCount = flat.length;
  if (scanCount > MAX_SCANS) {
    warnings.push(`mzXML: ${scanCount} scans exceeds the ${MAX_SCANS} cap; truncating.`);
    flat.length = MAX_SCANS;
    scanCount = MAX_SCANS;
  }

  const rtMin: number[] = [];
  const tic: number[] = [];
  const basePeakMz: number[] = [];
  const basePeakIntensity: number[] = [];
  const msLevel: number[] = [];
  const mzParts: number[][] = [];
  const intParts: number[][] = [];
  let pointCount = 0;

  for (let s = 0; s < flat.length; s += 1) {
    if (opts?.onProgress && s % 200 === 0 && s > 0) opts.onProgress(s / flat.length);
    const sc = flat[s];
    const level = Number(attr(sc.attrs, "msLevel") ?? "1");
    const levelNum = Number.isFinite(level) ? level : 1;
    const rt = parseRetentionTime(attr(sc.attrs, "retentionTime"), warnings);
    const ticVal = Number(attr(sc.attrs, "totIonCurrent") ?? "NaN");
    const bpmz = Number(attr(sc.attrs, "basePeakMz") ?? "NaN");
    const bpint = Number(attr(sc.attrs, "basePeakIntensity") ?? "NaN");
    const polAttr = (attr(sc.attrs, "polarity") ?? "").toUpperCase();
    void polAttr;

    const mzArr: number[] = [];
    const intArr: number[] = [];
    if (sc.peaksB64 && sc.peaksB64.trim().length > 0) {
      try {
        const precision = Number(attr(sc.peaksAttrs, "precision") ?? "32");
        const precisionBits = precision === 64 ? 64 : 32;
        const byteOrder = (attr(sc.peaksAttrs, "byteOrder") ?? "network").toLowerCase();
        const littleEndian = byteOrder !== "network";
        const compression = (attr(sc.peaksAttrs, "compressionType") ?? "none").toLowerCase();
        let bytes = decodeBase64(sc.peaksB64);
        if (compression === "zlib") bytes = await inflateZlib(bytes);
        const flat2 = readFloats(bytes, precisionBits, littleEndian);
        for (let k = 0; k + 1 < flat2.length; k += 2) {
          mzArr.push(flat2[k]);
          intArr.push(flat2[k + 1]);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        warnings.push(`mzXML: scan ${s}: ${msg}; empty peaks.`);
      }
    }

    const sorted = sortScanAsc(mzArr, intArr);
    if (sorted.resorted) warnings.push(`mzXML: scan ${s} m/z array was unsorted and got re-sorted.`);

    rtMin.push(Number.isFinite(rt) ? rt : 0);
    tic.push(Number.isFinite(ticVal) ? ticVal : 0);
    basePeakMz.push(Number.isFinite(bpmz) ? bpmz : 0);
    basePeakIntensity.push(Number.isFinite(bpint) ? bpint : 0);
    msLevel.push(levelNum);
    mzParts.push(Array.from(sorted.mz));
    intParts.push(Array.from(sorted.intensity));
    pointCount += sorted.mz.length;

    if (pointCount > MAX_POINTS) {
      warnings.push(`mzXML: exceeded ${MAX_POINTS} total points; truncating remaining scans.`);
      // trim trailing
      rtMin.length = s + 1;
      tic.length = s + 1;
      basePeakMz.length = s + 1;
      basePeakIntensity.length = s + 1;
      msLevel.length = s + 1;
      mzParts.length = s + 1;
      intParts.length = s + 1;
      break;
    }
  }

  const n = mzParts.length;
  const scanOffset = new Uint32Array(n + 1);
  let acc = 0;
  for (let s = 0; s < n; s += 1) {
    scanOffset[s] = acc;
    acc += mzParts[s].length;
  }
  scanOffset[n] = acc;

  const mzFlat = new Float64Array(acc);
  const intFlat = new Float32Array(acc);
  let off = 0;
  for (let s = 0; s < n; s += 1) {
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
  for (let s = 0; s < n; s += 1) {
    if (rtMin[s] < rtLo) rtLo = rtMin[s];
    if (rtMin[s] > rtHi) rtHi = rtMin[s];
    if (tic[s] < ticLo) ticLo = tic[s];
    if (tic[s] > ticHi) ticHi = tic[s];
  }
  for (let s = 0; s < n; s += 1) {
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
  if (opts?.onProgress) opts.onProgress(1);

  return {
    id: crypto.randomUUID(),
    name: opts?.name ?? "",
    sourcePath: opts?.sourcePath ?? "",
    format: "mzxml",
    detector: "ms",
    rtMin: Float64Array.from(rtMin),
    tic: Float64Array.from(tic),
    basePeakMz: Float64Array.from(basePeakMz),
    basePeakIntensity: Float64Array.from(basePeakIntensity),
    msLevel: Uint8Array.from(msLevel),
    scanOffset,
    mz: mzFlat,
    intensity: intFlat,
    scanCount: n,
    pointCount: acc,
    mzRange: [mzLo, mzHi],
    rtRange: [rtLo, rtHi],
    ticRange: [ticLo, ticHi],
    meta,
    warnings,
  };
}