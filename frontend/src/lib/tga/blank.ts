// Blank-run (buoyancy) correction for TGA data. Non-destructive: the raw
// arrays are preserved and a corrected view is produced.

import { interp } from "@/lib/ir/numerics";
import { upperBound } from "./numerics";

export interface BlankCorrection {
  /** Temperature grid shared by sample and interpolated blank, in °C. */
  tempC: Float64Array;
  /** Original sample weight, in mg. */
  sampleWeightMg: Float64Array;
  /** Blank weight interpolated onto the sample temperature grid, in mg. */
  blankWeightMg: Float64Array;
  /** Corrected sample weight = sample − blank, in mg. */
  correctedWeightMg: Float64Array;
  /** Fraction of the sample's temperature range covered by the blank. */
  overlapFraction: number;
  /** Non-fatal warnings. */
  warnings: string[];
}

/** Interpolate the blank's weight onto the sample's temperature grid and
 *  subtract. Warn if the temperature ranges overlap by less than 90 %. */
export function applyBlankCorrection(
  sampleTempC: Float64Array,
  sampleWeightMg: Float64Array,
  blankTempC: Float64Array,
  blankWeightMg: Float64Array,
  overlapThreshold = 0.9,
): BlankCorrection {
  const warnings: string[] = [];

  if (blankTempC.length === 0 || blankWeightMg.length === 0) {
    warnings.push("Blank run has no data; correction skipped.");
    return {
      tempC: Float64Array.from(sampleTempC),
      sampleWeightMg: Float64Array.from(sampleWeightMg),
      blankWeightMg: new Float64Array(sampleTempC.length).fill(NaN),
      correctedWeightMg: Float64Array.from(sampleWeightMg),
      overlapFraction: 0,
      warnings,
    };
  }

  const tSampleMin = sampleTempC[0];
  const tSampleMax = sampleTempC[sampleTempC.length - 1];
  const tBlankMin = blankTempC[0];
  const tBlankMax = blankTempC[blankTempC.length - 1];

  const overlapMin = Math.max(tSampleMin, tBlankMin);
  const overlapMax = Math.min(tSampleMax, tBlankMax);
  const overlap = Math.max(0, overlapMax - overlapMin);
  const sampleSpan = Math.max(0, tSampleMax - tSampleMin);
  const overlapFraction = sampleSpan > 0 ? overlap / sampleSpan : 0;

  if (overlapFraction < overlapThreshold) {
    warnings.push(
      `Blank/sample temperature overlap is only ${(overlapFraction * 100).toFixed(1)}% (${overlapThreshold * 100}% expected); correction may be unreliable.`,
    );
  }

  // Interpolate the blank weight onto the sample temperature grid.
  // The IR interp clamps endpoints, which is acceptable for small extrapolations
  // but should not be trusted far outside the blank range.
  const sampleTempArr = Array.from(sampleTempC);
  const blankTempArr = Array.from(blankTempC);
  const blankWeightArr = Array.from(blankWeightMg);
  const interpBlank = interp(sampleTempArr, blankTempArr, blankWeightArr);

  const n = sampleTempC.length;
  const corrected = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const rawBlank = interpBlank[i];
    // Guard NaN blanks: leave the sample value unchanged rather than propagating NaN.
    corrected[i] = Number.isFinite(rawBlank)
      ? sampleWeightMg[i] - rawBlank
      : sampleWeightMg[i];
  }

  return {
    tempC: Float64Array.from(sampleTempC),
    sampleWeightMg: Float64Array.from(sampleWeightMg),
    blankWeightMg: Float64Array.from(interpBlank),
    correctedWeightMg: corrected,
    overlapFraction,
    warnings,
  };
}

/** Given two ascending arrays, return the first index in `inner` whose value is
 *  within `outer`. Used to report where blank coverage begins/ends on the sample
 *  grid. */
export function coverageBounds(
  inner: Float64Array,
  outer: Float64Array,
): [number, number] {
  const lo = upperBound(outer, inner[0]);
  const hi = Math.max(lo, upperBound(outer, inner[inner.length - 1]));
  return [Math.max(0, lo), Math.min(outer.length, hi)];
}
