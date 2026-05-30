// Kendrick mass analysis.
//
// Kendrick scaling stretches the mass axis so a chosen repeat unit becomes an
// exact integer. Members of one homologous series (differing only by whole repeat
// units) then share the same Kendrick mass *defect* (KMD) and line up on a
// horizontal row in a KMD-vs-nominal-mass scatter — a fast, assignment-free way
// to see how many series are present and which peaks belong together.

import type { Peak } from "./types";

export interface KendrickPoint {
  peakId: string;
  mz: number;
  intensity: number;
  /** mz scaled so the base repeat unit is an integer. */
  kendrickMass: number;
  /** Kendrick mass defect = round(KM) − KM. Equal within a homologous series. */
  kmd: number;
  /** Nominal (rounded) m/z, the x-axis of the KMD plot. */
  nominalMass: number;
}

/** Compute Kendrick mass and defect for every peak given a base repeat unit. */
export function kendrickAnalysis(peaks: Peak[], baseRepeat: number): KendrickPoint[] {
  if (!(baseRepeat > 0)) return [];
  const nominalRepeat = Math.round(baseRepeat);
  const factor = nominalRepeat / baseRepeat;
  return peaks
    .filter((p) => p.accepted !== false && !p.ignored)
    .map((p) => {
      const mz = p.centroid ?? p.mz;
      const kendrickMass = mz * factor;
      return {
        peakId: p.id,
        mz,
        intensity: p.intensity,
        kendrickMass,
        kmd: Math.round(kendrickMass) - kendrickMass,
        nominalMass: Math.round(mz),
      };
    });
}

export interface KendrickCluster {
  /** Mean KMD of the cluster. */
  kmd: number;
  members: KendrickPoint[];
}

/**
 * Group Kendrick points into horizontal rows (shared KMD) — each row is a
 * candidate homologous series. Used to link a clicked KMD cluster back to the
 * matching peaks in the spectrum.
 */
export function clusterByKmd(points: KendrickPoint[], tolerance = 0.01): KendrickCluster[] {
  const sorted = [...points].sort((a, b) => a.kmd - b.kmd);
  const clusters: KendrickCluster[] = [];
  let current: KendrickPoint[] = [];
  for (const point of sorted) {
    if (current.length === 0 || point.kmd - current[current.length - 1].kmd <= tolerance) {
      current.push(point);
    } else {
      clusters.push(finalizeCluster(current));
      current = [point];
    }
  }
  if (current.length) clusters.push(finalizeCluster(current));
  // Only rows with ≥2 members are meaningful series; sort by size.
  return clusters.filter((c) => c.members.length >= 2).sort((a, b) => b.members.length - a.members.length);
}

function finalizeCluster(members: KendrickPoint[]): KendrickCluster {
  const kmd = members.reduce((sum, m) => sum + m.kmd, 0) / members.length;
  return { kmd, members };
}
