// MGF parser (GC/MS workspace, WP2). Synchronous, plain text.
//
// EVERY `BEGIN IONS` ... `END IONS` block becomes ONE SCAN (the old parser kept
// only the largest block — we do not do that). Reads TITLE, PEPMASS (m/z and
// optional intensity), CHARGE, RTINSECONDS (-> /60), SCANS. Peak lines are
// `mz intensity` separated by whitespace; blank and comment lines (#, ;, !, /)
// are ignored. When RTINSECONDS is absent, use the block index as rtMin and
// push a warning. msLevel 2 unless the block says otherwise.

import type { MsRun, RunMeta } from "../types";

export function isMgf(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, Math.min(bytes.length, 4096));
  const needle = stringBytes("BEGIN IONS");
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

interface MgfBlock {
  title: string;
  pepmassMz: number;
  pepmassInt: number;
  charge: string;
  rtMin: number;
  rtGiven: boolean;
  scans: string;
  msLevel: number;
  mz: number[];
  intensity: number[];
}

function sortScanAsc(
  mz: number[],
  intensity: number[],
): { mz: Float64Array; intensity: Float32Array; resorted: boolean } {
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
    format: "mgf",
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

export function parseMgf(
  text: string,
  opts?: { name?: string; sourcePath?: string },
): MsRun {
  const warnings: string[] = [];
  const blocks: MgfBlock[] = [];
  let cur: MgfBlock | null = null;
  const lines = text.split(/\r\n|\r|\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (/^BEGIN\s+IONS/i.test(line)) {
      cur = {
        title: "",
        pepmassMz: NaN,
        pepmassInt: NaN,
        charge: "",
        rtMin: NaN,
        rtGiven: false,
        scans: "",
        msLevel: 2,
        mz: [],
        intensity: [],
      };
      continue;
    }
    if (/^END\s+IONS/i.test(line)) {
      if (cur) blocks.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    if (!line) continue;
    // comments
    if (line[0] === "#" || line[0] === ";" || line[0] === "!" || line[0] === "/") continue;

    // metadata key=value
    const eq = line.indexOf("=");
    if (eq > 0) {
      const key = line.slice(0, eq).trim().toUpperCase();
      const val = line.slice(eq + 1).trim();
      if (key === "TITLE") {
        cur.title = val;
      } else if (key === "PEPMASS") {
        const parts = val.split(/\s+/);
        cur.pepmassMz = Number(parts[0]);
        if (parts.length > 1) cur.pepmassInt = Number(parts[1]);
      } else if (key === "CHARGE") {
        cur.charge = val;
      } else if (key === "RTINSECONDS") {
        const num = Number(val);
        if (Number.isFinite(num)) {
          cur.rtMin = num / 60;
          cur.rtGiven = true;
        }
      } else if (key === "SCANS") {
        cur.scans = val;
      } else if (key === "MSLEVEL") {
        const num = Number(val);
        if (Number.isFinite(num)) cur.msLevel = num;
      }
      continue;
    }

    // peak line: mz intensity
    const parts = line.split(/\s+/);
    if (parts.length < 1) continue;
    const mz = Number(parts[0]);
    const intensity = parts.length > 1 ? Number(parts[1]) : 1;
    if (Number.isFinite(mz) && Number.isFinite(intensity)) {
      cur.mz.push(mz);
      cur.intensity.push(intensity);
    }
  }
  if (cur) {
    // unterminated last block — keep it
    blocks.push(cur);
  }

  if (blocks.length === 0) {
    warnings.push("MGF: no BEGIN IONS blocks found.");
    return emptyRun(opts ?? {}, warnings);
  }

  const rtMin: number[] = [];
  const tic: number[] = [];
  const basePeakMz: number[] = [];
  const basePeakIntensity: number[] = [];
  const msLevel: number[] = [];
  const mzParts: number[][] = [];
  const intParts: number[][] = [];
  let pointCount = 0;

  for (let b = 0; b < blocks.length; b += 1) {
    const blk = blocks[b];
    if (!blk.rtGiven) {
      blk.rtMin = b;
      warnings.push(`MGF: block ${b} (${blk.title || "untitled"}) has no RTINSECONDS; using block index as rtMin.`);
    }

    const sorted = sortScanAsc(blk.mz, blk.intensity);

    // TIC = sum of intensities; base peak = max
    let sum = 0;
    let bpIdx = -1;
    let bpVal = -Infinity;
    for (let k = 0; k < sorted.intensity.length; k += 1) {
      sum += sorted.intensity[k];
      if (sorted.intensity[k] > bpVal) {
        bpVal = sorted.intensity[k];
        bpIdx = k;
      }
    }
    rtMin.push(blk.rtMin);
    tic.push(sum);
    basePeakMz.push(bpIdx >= 0 ? sorted.mz[bpIdx] : 0);
    basePeakIntensity.push(bpIdx >= 0 ? bpVal : 0);
    msLevel.push(blk.msLevel);
    mzParts.push(Array.from(sorted.mz));
    intParts.push(Array.from(sorted.intensity));
    pointCount += sorted.mz.length;
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
  if (blocks.length > 0 && blocks[0].title) meta.sample = blocks[0].title;

  return {
    id: crypto.randomUUID(),
    name: opts?.name ?? "",
    sourcePath: opts?.sourcePath ?? "",
    format: "mgf",
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