// ANDI-MS (netCDF) parser (GC/MS workspace, WP2). Synchronous.
//
// Maps the ANDI-MS conventions onto MsRun using readNetcdf. ANDI-MS variables:
//   scan_acquisition_time  (SECONDS -> /60)   -> rtMin
//   total_intensity                            -> tic
//   scan_index                                 -> scan offsets (prepend nothing;
//                                                 scan_index IS each scan's start
//                                                 offset; append mass_values.length
//                                                 as the final element)
//   point_count                                -> cross-check the offsets, warn
//   mass_values                                -> mz
//   intensity_values                           -> intensity
//   mass_range_min / mass_range_max            -> mzRange fallback
// Global attributes -> meta mapping described in the spec.

import type { MsRun, RunMeta } from "../types";
import { readNetcdf, type NetcdfFile } from "./netcdf";

export function isAndiMs(f: NetcdfFile): boolean {
  const sat = f.getVariable("scan_acquisition_time");
  const mv = f.getVariable("mass_values");
  return sat !== null && mv !== null;
}

function emptyRun(opts: { name?: string; sourcePath?: string }, warnings: string[]): MsRun {
  return {
    id: crypto.randomUUID(),
    name: opts.name ?? "",
    sourcePath: opts.sourcePath ?? "",
    format: "andi",
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

function getFloat64(f: NetcdfFile, name: string): Float64Array | null {
  const v = f.getVariable(name);
  if (v === null) return null;
  if (typeof v === "string") return null;
  return v as Float64Array;
}

function ionizationMode(mode: string | undefined): RunMeta["ionization"] {
  if (!mode) return undefined;
  const m = mode.toLowerCase();
  if (m.includes("electron impact")) return "EI";
  if (m.includes("chemical")) return "CI";
  if (m.includes("esi")) return "ESI";
  if (m.includes("apci")) return "APCI";
  return "unknown";
}

export function parseAndiMs(
  buffer: ArrayBuffer,
  opts?: { name?: string; sourcePath?: string },
): MsRun {
  const warnings: string[] = [];
  const file = readNetcdf(buffer);
  if (!isAndiMs(file)) {
    warnings.push("ANDI-MS: required variables scan_acquisition_time and/or mass_values are missing.");
    return emptyRun(opts ?? {}, warnings);
  }

  const sat = getFloat64(file, "scan_acquisition_time");
  const tic = getFloat64(file, "total_intensity");
  const scanIndex = getFloat64(file, "scan_index");
  const pointCount = getFloat64(file, "point_count");
  const massValues = getFloat64(file, "mass_values");
  const intensityValues = getFloat64(file, "intensity_values");
  const massMin = getFloat64(file, "mass_range_min");
  const massMax = getFloat64(file, "mass_range_max");

  if (massValues === null || intensityValues === null) {
    warnings.push("ANDI-MS: mass_values or intensity_values missing.");
    return emptyRun(opts ?? {}, warnings);
  }
  if (scanIndex === null) {
    warnings.push("ANDI-MS: scan_index missing; cannot determine scan boundaries.");
    return emptyRun(opts ?? {}, warnings);
  }

  const scanCount = scanIndex.length;
  // scan offsets: scanIndex IS the start offset of each scan; append the total.
  const scanOffset = new Uint32Array(scanCount + 1);
  for (let i = 0; i < scanCount; i += 1) {
    scanOffset[i] = scanIndex[i];
  }
  scanOffset[scanCount] = massValues.length;

  // Cross-check point_count vs the offset differences.
  if (pointCount !== null && pointCount.length === scanCount) {
    for (let i = 0; i < scanCount; i += 1) {
      const expected = scanOffset[i + 1] - scanOffset[i];
      if (pointCount[i] !== expected) {
        warnings.push(
          `ANDI-MS: scan ${i} point_count=${pointCount[i]} differs from offset-derived count=${expected}.`,
        );
      }
    }
  } else if (pointCount !== null) {
    warnings.push("ANDI-MS: point_count length does not match scan_count; cross-check skipped.");
  }

  // Sort each scan ascending by m/z, into flat typed arrays.
  const mzFlat = new Float64Array(massValues.length);
  const intFlat = new Float32Array(intensityValues.length);
  const rtMinArr = new Float64Array(scanCount);
  const ticArr = new Float64Array(scanCount);
  const basePeakMz = new Float64Array(scanCount);
  const basePeakIntensity = new Float64Array(scanCount);
  const msLevelArr = new Uint8Array(scanCount);

  let mzLo = Infinity;
  let mzHi = -Infinity;
  let rtLo = Infinity;
  let rtHi = -Infinity;
  let ticLo = Infinity;
  let ticHi = -Infinity;

  for (let s = 0; s < scanCount; s += 1) {
    const lo = scanOffset[s];
    const hi = scanOffset[s + 1];
    const len = hi - lo;
    // collect (mz,int) and sort ascending by mz
    const idx = new Array<number>(len);
    for (let k = 0; k < len; k += 1) idx[k] = k;
    const mzSlice = massValues.subarray(lo, hi);
    idx.sort((a, b) => mzSlice[a] - mzSlice[b]);
    let sum = 0;
    let bpIdx = -1;
    let bpVal = -Infinity;
    for (let k = 0; k < len; k += 1) {
      const src = idx[k];
      const mz = mzSlice[src];
      const it = intensityValues[lo + src];
      mzFlat[lo + k] = mz;
      intFlat[lo + k] = it;
      sum += it;
      if (it > bpVal) {
        bpVal = it;
        bpIdx = k;
      }
    }
    if (len > 0) {
      if (mzFlat[lo] < mzLo) mzLo = mzFlat[lo];
      if (mzFlat[hi - 1] > mzHi) mzHi = mzFlat[hi - 1];
    }
    const rt = sat !== null && s < sat.length ? sat[s] / 60 : 0;
    rtMinArr[s] = Number.isFinite(rt) ? rt : 0;
    const ticVal = tic !== null && s < tic.length ? tic[s] : sum;
    ticArr[s] = Number.isFinite(ticVal) ? ticVal : sum;
    basePeakMz[s] = bpIdx >= 0 ? mzFlat[lo + bpIdx] : 0;
    basePeakIntensity[s] = bpIdx >= 0 ? bpVal : 0;
    msLevelArr[s] = 1;
    if (rtMinArr[s] < rtLo) rtLo = rtMinArr[s];
    if (rtMinArr[s] > rtHi) rtHi = rtMinArr[s];
    if (ticArr[s] < ticLo) ticLo = ticArr[s];
    if (ticArr[s] > ticHi) ticHi = ticArr[s];
  }

  // mzRange fallback from mass_range_min/max (per-scan arrays) if no points.
  if (!Number.isFinite(mzLo)) {
    if (massMin !== null && massMin.length > 0) {
      mzLo = Math.min(...massMin);
      mzHi = Math.max(...(massMax ?? massMin));
    } else {
      mzLo = 0;
      mzHi = 0;
    }
  }

  const meta: RunMeta = {};
  const g = file.attrs;
  if (typeof g.experiment_title === "string") meta.sample = g.experiment_title;
  if (typeof g.operator_name === "string") meta.operator = g.operator_name;
  if (typeof g.experiment_date_time_stamp === "string") meta.acquiredDate = g.experiment_date_time_stamp;
  meta.ionization = ionizationMode(typeof g.test_ionization_mode === "string" ? g.test_ionization_mode : undefined);
  if (typeof g.test_detector_type === "string") meta.instrument = g.test_detector_type;

  return {
    id: crypto.randomUUID(),
    name: opts?.name ?? "",
    sourcePath: opts?.sourcePath ?? "",
    format: "andi",
    detector: "ms",
    rtMin: rtMinArr,
    tic: ticArr,
    basePeakMz,
    basePeakIntensity,
    msLevel: msLevelArr,
    scanOffset,
    mz: mzFlat,
    intensity: intFlat,
    scanCount,
    pointCount: massValues.length,
    mzRange: [mzLo, mzHi],
    rtRange: [Number.isFinite(rtLo) ? rtLo : 0, Number.isFinite(rtHi) ? rtHi : 0],
    ticRange: [Number.isFinite(ticLo) ? ticLo : 0, Number.isFinite(ticHi) ? ticHi : 0],
    meta,
    warnings,
  };
}