// MALDI-apparent molecular-weight statistics for polymer distributions.
//
// Average molecular weights are computed from peak masses weighted by peak
// intensity, which in MALDI is only a *qualitative* proxy for molar abundance
// (mass-dependent desorption/ionization and detector response distort it). Every
// value this module returns is therefore labelled "MALDI-apparent" in the UI —
// it is not a quantitative SEC/light-scattering measurement.
//
// Masses are pure arithmetic over arrays already in memory, so this runs on the
// main thread (instant recompute as the user changes the source subset).

import { neutralMass } from "./adducts";
import type { Adduct, Peak, Series } from "./types";

/** Which peaks to include in the average. */
export type MolWeightSource = "all" | "series" | "selected" | "threshold";

export interface MolWeightOptions {
  /** Repeat unit (Da) — enables DPn/DPw. */
  repeatMass?: number;
  /** End-group mass (Da) subtracted before dividing by the repeat for DP. */
  endGroupMass?: number;
  /** When set, convert observed m/z to neutral mass with this adduct. */
  adduct?: Adduct;
  /** Relative intensity cutoff (0..1 of base peak) for the "threshold" source. */
  intensityThreshold?: number;
  /** Peak ids for the "selected" source. */
  selectedPeakIds?: Set<string>;
  /** Restrict the "series" source to one series id (else all series members). */
  seriesId?: string;
}

export interface MolWeightStats {
  /** Number-average molecular weight (MALDI-apparent). */
  mn: number;
  /** Weight-average molecular weight (MALDI-apparent). */
  mw: number;
  /** z-average molecular weight (MALDI-apparent). */
  mz: number;
  /** Dispersity Đ = Mw/Mn. */
  dispersity: number;
  /** Mass at the most intense included peak. */
  peakMaxMass: number;
  /** Number-average degree of polymerization (only when a repeat is given). */
  dpn?: number;
  /** Weight-average degree of polymerization. */
  dpw?: number;
  /** Number of peaks contributing. */
  count: number;
  /** Whether masses are neutral (adduct removed) or raw m/z. */
  massBasis: "neutral" | "m/z";
}

/** The mass used for a peak: neutral (adduct removed) when an adduct is given. */
export function peakMassValue(peak: Peak, adduct?: Adduct): number {
  const mz = peak.centroid ?? peak.mz;
  return adduct ? neutralMass(mz, adduct) : mz;
}

/** Peaks eligible by default: accepted, not ignored, not isotope/background. */
function isAnalyte(peak: Peak): boolean {
  return (
    peak.accepted !== false &&
    !peak.ignored &&
    peak.flag !== "isotope" &&
    peak.flag !== "matrix" &&
    peak.flag !== "matrixCluster" &&
    peak.flag !== "salt"
  );
}

/** Select the contributing peaks for a given source. */
export function selectPeaks(
  peaks: Peak[],
  series: Series[],
  source: MolWeightSource,
  options: MolWeightOptions,
): Peak[] {
  const analyte = peaks.filter(isAnalyte);
  switch (source) {
    case "all":
      return analyte;
    case "series": {
      const ids = new Set<string>();
      for (const s of series) {
        if (options.seriesId && s.id !== options.seriesId) continue;
        for (const m of s.members) ids.add(m.peakId);
      }
      return analyte.filter((p) => ids.has(p.id));
    }
    case "selected": {
      const sel = options.selectedPeakIds ?? new Set<string>();
      return analyte.filter((p) => sel.has(p.id));
    }
    case "threshold": {
      const base = analyte.reduce((m, p) => Math.max(m, p.intensity), 0) || 1;
      const cut = (options.intensityThreshold ?? 0.05) * base;
      return analyte.filter((p) => p.intensity >= cut);
    }
  }
}

/** Core moment statistics from (mass, intensity) pairs. */
export function molecularWeightStats(
  items: { mass: number; intensity: number }[],
  options: MolWeightOptions = {},
): MolWeightStats {
  const massBasis = options.adduct ? "neutral" : "m/z";
  const valid = items.filter((it) => it.mass > 0 && it.intensity > 0);
  if (valid.length === 0) {
    return { mn: 0, mw: 0, mz: 0, dispersity: 0, peakMaxMass: 0, count: 0, massBasis };
  }

  let sI = 0; // Σ I
  let sIM = 0; // Σ I·M
  let sIM2 = 0; // Σ I·M²
  let sIM3 = 0; // Σ I·M³
  let peakMaxMass = valid[0].mass;
  let peakMaxInt = -Infinity;
  for (const { mass, intensity } of valid) {
    sI += intensity;
    sIM += intensity * mass;
    sIM2 += intensity * mass * mass;
    sIM3 += intensity * mass * mass * mass;
    if (intensity > peakMaxInt) {
      peakMaxInt = intensity;
      peakMaxMass = mass;
    }
  }

  const mn = sIM / sI;
  const mw = sIM2 / sIM;
  const mz = sIM3 / sIM2;
  const dispersity = mn > 0 ? mw / mn : 0;

  const stats: MolWeightStats = {
    mn,
    mw,
    mz,
    dispersity,
    peakMaxMass,
    count: valid.length,
    massBasis,
  };

  if (options.repeatMass && options.repeatMass > 0) {
    const end = options.endGroupMass ?? 0;
    stats.dpn = (mn - end) / options.repeatMass;
    stats.dpw = (mw - end) / options.repeatMass;
  }
  return stats;
}

/** Convenience: select peaks for a source and compute the apparent MW stats. */
export function summarizeMolWeight(
  peaks: Peak[],
  series: Series[],
  source: MolWeightSource,
  options: MolWeightOptions = {},
): MolWeightStats {
  const selected = selectPeaks(peaks, series, source, options);
  const items = selected.map((p) => ({
    mass: peakMassValue(p, options.adduct),
    intensity: p.intensity,
  }));
  return molecularWeightStats(items, options);
}
