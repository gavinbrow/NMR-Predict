// Textual GC/MS parsers (GC/MS workspace, WP2). Synchronous.
//
// CSV/TSV: auto-detect delimiter (comma, tab or semicolon), skip an optional
// header row. Two numeric columns -> a chromatogram-only run (detector "fid",
// scanCount = 0, only rtMin + tic filled, empty CSR arrays). More than two
// columns where the first row is a list of m/z values -> a scan matrix
// (row = scan, col 0 = RT, remaining cols = intensity at the header's m/z).
//
// JCAMP-DX: use the installed `jcampconverter` package. Take the first block's
// XY data as a chromatogram-only run, or the spectra when the file is a mass-
// spectrum JCAMP (`##DATA TYPE= MASS SPECTRUM`).

import { convert } from "jcampconverter";
import type { MsRun, RunMeta } from "../types";

interface ParseOpts {
  name?: string;
  sourcePath?: string;
}

function emptyRun(
  opts: ParseOpts,
  warnings: string[],
  format: MsRun["format"],
  detector: MsRun["detector"],
): MsRun {
  return {
    id: crypto.randomUUID(),
    name: opts.name ?? "",
    sourcePath: opts.sourcePath ?? "",
    format,
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
    mzRange: [Infinity, -Infinity],
    rtRange: [Infinity, -Infinity],
    ticRange: [Infinity, -Infinity],
    meta: {},
    warnings,
  };
}

function detectDelimiter(line: string): string {
  if (line.includes("\t")) return "\t";
  if (line.includes(";")) return ";";
  return ",";
}

function isNumeric(s: string): boolean {
  if (s === "") return false;
  return Number.isFinite(Number(s));
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

function finalizeRanges(
  rtMin: Float64Array,
  tic: Float64Array,
  mz: Float64Array,
  scanOffset: Uint32Array,
): { mzRange: [number, number]; rtRange: [number, number]; ticRange: [number, number] } {
  let mzLo = Infinity;
  let mzHi = -Infinity;
  let rtLo = Infinity;
  let rtHi = -Infinity;
  let ticLo = Infinity;
  let ticHi = -Infinity;
  for (let i = 0; i < rtMin.length; i += 1) {
    if (rtMin[i] < rtLo) rtLo = rtMin[i];
    if (rtMin[i] > rtHi) rtHi = rtMin[i];
  }
  for (let i = 0; i < tic.length; i += 1) {
    if (tic[i] < ticLo) ticLo = tic[i];
    if (tic[i] > ticHi) ticHi = tic[i];
  }
  for (let s = 0; s < scanOffset.length - 1; s += 1) {
    const lo = scanOffset[s];
    const hi = scanOffset[s + 1];
    if (hi > lo) {
      if (mz[lo] < mzLo) mzLo = mz[lo];
      if (mz[hi - 1] > mzHi) mzHi = mz[hi - 1];
    }
  }
  if (!Number.isFinite(mzLo)) mzLo = 0;
  if (!Number.isFinite(mzHi)) mzHi = 0;
  if (!Number.isFinite(rtLo)) rtLo = 0;
  if (!Number.isFinite(rtHi)) rtHi = 0;
  if (!Number.isFinite(ticLo)) ticLo = 0;
  if (!Number.isFinite(ticHi)) ticHi = 0;
  return { mzRange: [mzLo, mzHi], rtRange: [rtLo, rtHi], ticRange: [ticLo, ticHi] };
}

export function sniffTextual(text: string): "csv" | "jcamp" | null {
  const head = text.slice(0, 4000);
  if (/^\s*##/.test(head) || /##DATA TYPE/i.test(head) || /##TITLE/i.test(head)) return "jcamp";
  // CSV heuristic: at least one line with a delimiter and numeric-ish content.
  const firstLine = head.split(/\r\n|\r|\n/).find((l) => l.trim().length > 0);
  if (firstLine) {
    const delim = detectDelimiter(firstLine);
    if (delim !== "," || firstLine.includes(",")) {
      // require at least one numeric field somewhere in the first few lines
      const lines = head.split(/\r\n|\r|\n/).slice(0, 5).filter((l) => l.trim().length > 0);
      const hasNumber = lines.some((l) => l.split(delim).some((tok) => isNumeric(tok.trim())));
      if (hasNumber) return "csv";
    }
  }
  return null;
}

export function parseCsvChromatogram(text: string, opts?: ParseOpts): MsRun {
  const warnings: string[] = [];
  const rawLines = text.split(/\r\n|\r|\n/);
  // find first non-blank line to detect delimiter
  let firstIdx = 0;
  while (firstIdx < rawLines.length && rawLines[firstIdx].trim() === "") firstIdx += 1;
  if (firstIdx >= rawLines.length) {
    warnings.push("CSV: file is empty.");
    return emptyRun(opts ?? {}, warnings, "csv", "fid");
  }
  const delim = detectDelimiter(rawLines[firstIdx]);

  // Parse rows into arrays of trimmed string cells.
  const rows: string[][] = [];
  for (let i = firstIdx; i < rawLines.length; i += 1) {
    const line = rawLines[i].trim();
    if (!line) continue;
    rows.push(line.split(delim).map((c) => c.trim()));
  }
  if (rows.length === 0) {
    warnings.push("CSV: no data rows.");
    return emptyRun(opts ?? {}, warnings, "csv", "fid");
  }

  const ncols = rows[0].length;

  // Two-column chromatogram OR matrix-with-header. Decide whether row 0 is a
  // header (non-numeric first cell, or non-numeric beyond the first).
  if (ncols === 2) {
    // Two numeric columns -> chromatogram only. Optionally skip a header row.
    let startRow = 0;
    const r0 = rows[0];
    if (!isNumeric(r0[0]) || !isNumeric(r0[1])) {
      startRow = 1;
    }
    const n = rows.length - startRow;
    if (n <= 0) {
      warnings.push("CSV: two columns but no numeric data rows.");
      return emptyRun(opts ?? {}, warnings, "csv", "fid");
    }
    const rtMin = new Float64Array(n);
    const tic = new Float64Array(n);
    let lo = Infinity;
    let hi = -Infinity;
    let ticLo = Infinity;
    let ticHi = -Infinity;
    let k = 0;
    for (let i = startRow; i < rows.length; i += 1, k += 1) {
      const rt = Number(rows[i][0]);
      const v = Number(rows[i][1]);
      rtMin[k] = Number.isFinite(rt) ? rt : 0;
      tic[k] = Number.isFinite(v) ? v : 0;
      if (rtMin[k] < lo) lo = rtMin[k];
      if (rtMin[k] > hi) hi = rtMin[k];
      if (tic[k] < ticLo) ticLo = tic[k];
      if (tic[k] > ticHi) ticHi = tic[k];
    }
    return {
      id: crypto.randomUUID(),
      name: opts?.name ?? "",
      sourcePath: opts?.sourcePath ?? "",
      format: "csv",
      detector: "fid",
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
      mzRange: [Infinity, -Infinity],
      rtRange: [Number.isFinite(lo) ? lo : 0, Number.isFinite(hi) ? hi : 0],
      ticRange: [Number.isFinite(ticLo) ? ticLo : 0, Number.isFinite(ticHi) ? ticHi : 0],
      meta: {},
      warnings,
    };
  }

  // More than two columns: detect a header row whose first cell is non-numeric
  // and whose remaining cells are m/z values. Then each subsequent row is a
  // scan: col 0 = RT, cols 1.. = intensity at the header m/z.
  let headerRow = -1;
  if (!isNumeric(rows[0][0]) && ncols > 2) {
    // check the rest of the row are numeric m/z values
    let allNumeric = true;
    for (let c = 1; c < ncols; c += 1) {
      if (!isNumeric(rows[0][c])) {
        allNumeric = false;
        break;
      }
    }
    if (allNumeric) headerRow = 0;
  }

  if (headerRow >= 0) {
    const mzHeader = new Float64Array(ncols - 1);
    for (let c = 1; c < ncols; c += 1) mzHeader[c - 1] = Number(rows[0][c]);
    const dataRows = rows.slice(headerRow + 1);
    const scanCount = dataRows.length;
    if (scanCount === 0) {
      warnings.push("CSV: matrix header but no data rows.");
      return emptyRun(opts ?? {}, warnings, "csv", "ms");
    }
    // sort the header m/z ascending and remember the permutation so each row
    // is reordered to match.
    const order = Array.from({ length: mzHeader.length }, (_, i) => i).sort((a, b) => mzHeader[a] - mzHeader[b]);
    const sortedMz = new Float64Array(mzHeader.length);
    for (let c = 0; c < mzHeader.length; c += 1) sortedMz[c] = mzHeader[order[c]];

    const rtMin = new Float64Array(scanCount);
    const tic = new Float64Array(scanCount);
    const basePeakMz = new Float64Array(scanCount);
    const basePeakIntensity = new Float64Array(scanCount);
    const msLevel = new Uint8Array(scanCount);
    const scanOffset = new Uint32Array(scanCount + 1);
    const pointsPerScan = mzHeader.length;
    const mzFlat = new Float64Array(scanCount * pointsPerScan);
    const intFlat = new Float32Array(scanCount * pointsPerScan);
    for (let s = 0; s < scanCount; s += 1) {
      const row = dataRows[s];
      const rt = Number(row[0]);
      rtMin[s] = Number.isFinite(rt) ? rt : 0;
      let sum = 0;
      let bpIdx = -1;
      let bpVal = -Infinity;
      const base = s * pointsPerScan;
      for (let c = 0; c < pointsPerScan; c += 1) {
        const srcCol = order[c] + 1;
        const v = srcCol < row.length ? Number(row[srcCol]) : NaN;
        const iv = Number.isFinite(v) ? v : 0;
        mzFlat[base + c] = sortedMz[c];
        intFlat[base + c] = iv;
        sum += iv;
        if (iv > bpVal) {
          bpVal = iv;
          bpIdx = c;
        }
      }
      scanOffset[s] = base;
      tic[s] = sum;
      basePeakMz[s] = bpIdx >= 0 ? sortedMz[bpIdx] : 0;
      basePeakIntensity[s] = bpIdx >= 0 ? bpVal : 0;
      msLevel[s] = 1;
    }
    scanOffset[scanCount] = scanCount * pointsPerScan;
    const ranges = finalizeRanges(rtMin, tic, mzFlat, scanOffset);
    return {
      id: crypto.randomUUID(),
      name: opts?.name ?? "",
      sourcePath: opts?.sourcePath ?? "",
      format: "csv",
      detector: "ms",
      rtMin,
      tic,
      basePeakMz,
      basePeakIntensity,
      msLevel,
      scanOffset,
      mz: mzFlat,
      intensity: intFlat,
      scanCount,
      pointCount: mzFlat.length,
      mzRange: ranges.mzRange,
      rtRange: ranges.rtRange,
      ticRange: ranges.ticRange,
      meta: {},
      warnings,
    };
  }

  // Fallback: treat as a chromatogram using the first two columns.
  warnings.push("CSV: more than two columns but no m/z header detected; using columns 0 and 1 as a chromatogram.");
  const n = rows.length;
  const rtMin = new Float64Array(n);
  const tic = new Float64Array(n);
  let lo = Infinity;
  let hi = -Infinity;
  let ticLo = Infinity;
  let ticHi = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const rt = Number(rows[i][0]);
    const v = Number(rows[i][1]);
    rtMin[i] = Number.isFinite(rt) ? rt : 0;
    tic[i] = Number.isFinite(v) ? v : 0;
    if (rtMin[i] < lo) lo = rtMin[i];
    if (rtMin[i] > hi) hi = rtMin[i];
    if (tic[i] < ticLo) ticLo = tic[i];
    if (tic[i] > ticHi) ticHi = tic[i];
  }
  return {
    id: crypto.randomUUID(),
    name: opts?.name ?? "",
    sourcePath: opts?.sourcePath ?? "",
    format: "csv",
    detector: "fid",
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
    mzRange: [Infinity, -Infinity],
    rtRange: [Number.isFinite(lo) ? lo : 0, Number.isFinite(hi) ? hi : 0],
    ticRange: [Number.isFinite(ticLo) ? ticLo : 0, Number.isFinite(ticHi) ? ticHi : 0],
    meta: {},
    warnings,
  };
}

export function parseJcamp(text: string, opts?: ParseOpts): MsRun {
  const warnings: string[] = [];
  let result;
  try {
    result = convert(text, { keepRecordsRegExp: /.*/ });
  } catch (e) {
    warnings.push(`JCAMP: parse failed: ${e instanceof Error ? e.message : String(e)}`);
    return emptyRun(opts ?? {}, warnings, "jcamp", "fid");
  }
  const entries = result.flatten ?? result.entries;
  if (!entries || entries.length === 0) {
    warnings.push("JCAMP: no entries parsed.");
    return emptyRun(opts ?? {}, warnings, "jcamp", "fid");
  }

  const first = entries[0];
  const dataType = (first.dataType ?? first.info?.dataType ?? "").toString().toUpperCase();
  const isMass = dataType.includes("MASS SPECTRUM") || dataType.includes("MASS");

  if (isMass) {
    // Build scans from each entry's spectra.
    const rtMin: number[] = [];
    const tic: number[] = [];
    const basePeakMz: number[] = [];
    const basePeakIntensity: number[] = [];
    const msLevel: number[] = [];
    const mzParts: number[][] = [];
    const intParts: number[][] = [];
    for (const entry of entries) {
      const spectra = entry.spectra ?? [];
      for (const sp of spectra) {
        const data = sp.data;
        // jcampconverter returns {x:[], y:[]} or {x:..} depending on label.
        const x: number[] = data.x ?? data[0] ?? [];
        const y: number[] = data.y ?? data[1] ?? [];
        if (!x || !y || x.length === 0) continue;
        const sorted = sortScanAsc(x, y);
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
        rtMin.push(0);
        tic.push(sum);
        basePeakMz.push(bpIdx >= 0 ? sorted.mz[bpIdx] : 0);
        basePeakIntensity.push(bpIdx >= 0 ? bpVal : 0);
        msLevel.push(1);
        mzParts.push(Array.from(sorted.mz));
        intParts.push(Array.from(sorted.intensity));
      }
    }
    const n = mzParts.length;
    if (n === 0) {
      warnings.push("JCAMP: mass spectrum declared but no XY data found.");
      return emptyRun(opts ?? {}, warnings, "jcamp", "ms");
    }
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
    const ranges = finalizeRanges(Float64Array.from(rtMin), Float64Array.from(tic), mzFlat, scanOffset);
    return {
      id: crypto.randomUUID(),
      name: opts?.name ?? "",
      sourcePath: opts?.sourcePath ?? "",
      format: "jcamp",
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
      mzRange: ranges.mzRange,
      rtRange: ranges.rtRange,
      ticRange: ranges.ticRange,
      meta: {},
      warnings,
    };
  }

  // Chromatogram-only: take the first block's XY data.
  const spectra = first.spectra ?? [];
  if (spectra.length === 0) {
    warnings.push("JCAMP: no XY data in the first entry.");
    return emptyRun(opts ?? {}, warnings, "jcamp", "fid");
  }
  const sp0 = spectra[0];
  const data = sp0.data;
  const x: number[] = data.x ?? data[0] ?? [];
  const y: number[] = data.y ?? data[1] ?? [];
  if (!x || !y || x.length === 0) {
    warnings.push("JCAMP: first entry has empty XY data.");
    return emptyRun(opts ?? {}, warnings, "jcamp", "fid");
  }
  const n = x.length;
  const rtMin = new Float64Array(n);
  const tic = new Float64Array(n);
  let lo = Infinity;
  let hi = -Infinity;
  let ticLo = Infinity;
  let ticHi = -Infinity;
  for (let i = 0; i < n; i += 1) {
    rtMin[i] = x[i];
    tic[i] = y[i];
    if (rtMin[i] < lo) lo = rtMin[i];
    if (rtMin[i] > hi) hi = rtMin[i];
    if (tic[i] < ticLo) ticLo = tic[i];
    if (tic[i] > ticHi) ticHi = tic[i];
  }
  return {
    id: crypto.randomUUID(),
    name: opts?.name ?? "",
    sourcePath: opts?.sourcePath ?? "",
    format: "jcamp",
    detector: "fid",
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
    mzRange: [Infinity, -Infinity],
    rtRange: [Number.isFinite(lo) ? lo : 0, Number.isFinite(hi) ? hi : 0],
    ticRange: [Number.isFinite(ticLo) ? ticLo : 0, Number.isFinite(ticHi) ? ticHi : 0],
    meta: {},
    warnings,
  };
}