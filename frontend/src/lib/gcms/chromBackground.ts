// Chromatogram-domain (RT) background subtraction: subtract a blank run's
// trace from a sample run's trace, aligned by RT (not by index). Pure and
// total — never throws, never mutates its inputs. Separate from the m/z-
// domain spectrum background subtraction in `subtractBackground`
// (lib/gcms/chrom.ts), which subtracts one mass spectrum from another.

import { nearestIndex } from "./numerics";
import type { ChromTrace } from "./types";

/**
 * Subtract `blank` from `sample` point-by-point: for each sample RT, find
 * the nearest blank RT via `nearestIndex`, subtract that blank intensity,
 * clamp the result to ≥0. Returns a NEW derived `ChromTrace` (kind
 * `"TIC-bg"`, id `${sample.id}-bg`, colour inherited from the sample,
 * `visible:true`). Aligns by RT, not by index-equality, so two runs whose
 * scan grids don't line up still subtract sanely. Pure: never throws and
 * never mutates either input.
 */
export function subtractChromBackground(sample: ChromTrace, blank: ChromTrace): ChromTrace {
  const n = sample.rtMin.length;
  const outI = new Float64Array(n);
  const blankRt = blank.rtMin;
  const blankI = blank.intensity;
  for (let i = 0; i < n; i += 1) {
    const j = nearestIndex(blankRt, sample.rtMin[i]);
    let v = sample.intensity[i];
    if (j >= 0) {
      v -= blankI[j];
      if (v < 0) v = 0;
    }
    outI[i] = v;
  }
  return {
    id: `${sample.id}-bg`,
    runId: sample.runId,
    kind: "TIC-bg",
    label: `${sample.label} − bg`,
    rtMin: sample.rtMin,
    intensity: outI,
    color: sample.color,
    visible: true,
    offset: 0,
    scale: 1,
  };
}