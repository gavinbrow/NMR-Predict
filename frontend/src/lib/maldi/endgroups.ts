// End-group analysis.
//
// Once a repeat unit and adduct are known, the part of each oligomer's mass that
// is NOT explained by whole repeat units and the adduct is the end-group mass
// (α + ω termini). Peaks in a series share this residual, so clustering residuals
// modulo the repeat — for each candidate adduct — yields candidate end-group
// masses, which we match against a small library of common termini.

import { neutralMass } from "./adducts";
import type { Adduct, Peak } from "./types";

export interface EndGroupLibraryEntry {
  id: string;
  label: string;
  /** Combined monoisotopic mass of the α + ω end groups (Da). */
  mass: number;
}

/**
 * Common polymer end-group combinations (α + ω). Values are monoisotopic masses
 * of the atoms beyond the repeat backbone (e.g. PEG with H/OH termini carries an
 * extra H2O = 18.0106). This is a starter set the user can extend.
 */
export const END_GROUP_LIBRARY: EndGroupLibraryEntry[] = [
  { id: "h-oh", label: "H / OH (e.g. PEG diol)", mass: 18.0106 },
  { id: "h-h", label: "H / H", mass: 2.0157 },
  { id: "oh-oh", label: "OH / OH", mass: 34.0055 },
  { id: "me-oh", label: "CH3O / H (methyl ether / NaOMe init.)", mass: 32.0262 },
  { id: "me-h", label: "CH3 / H", mass: 16.0313 },
  { id: "bu-oh", label: "C4H9 / OH (butyl, hydroxyl)", mass: 74.0732 },
  { id: "h2o-na-formate", label: "(none / OH)", mass: 17.0027 },
  // Alkoxide-base initiators (anionic ROP). For an RO⁻-initiated, H-terminated
  // chain the combined α+ω residual equals the parent alcohol's mass.
  { id: "etoh", label: "EtO / H (NaOEt init.)", mass: 46.0419 },
  { id: "iproh", label: "iPrO / H (NaOiPr init.)", mass: 60.0575 },
  { id: "tbuoh", label: "tBuO / H (KOtBu init.)", mass: 74.0732 },
  { id: "tamoh", label: "tAmO / H (KOtAm init.)", mass: 88.0888 },
  { id: "bnoh", label: "BnO / H (benzyl alkoxide init.)", mass: 108.0575 },
  { id: "phoh", label: "PhO / H (phenolate init.)", mass: 94.0419 },
];

export interface EndGroupOptions {
  /** Residual clustering tolerance (Da). Default 0.5. */
  toleranceDa?: number;
  /** Minimum oligomers supporting a candidate. Default 3. */
  minOligomers?: number;
  /** Library match tolerance (Da). Default 0.3. */
  libraryToleranceDa?: number;
  /** Max candidates returned. Default 12. */
  maxCandidates?: number;
}

export interface EndGroupCandidate {
  id: string;
  /** Residual end-group mass (Da), modulo the repeat unit. */
  residualMass: number;
  adductId: string;
  /** Number of oligomers (consecutive members) supporting this residual. */
  matchedOligomers: number;
  /** RMS error of the residual cluster (Da). */
  meanErrorDa: number;
  /** Nearest library label within tolerance, if any. */
  libraryMatch?: string;
  /** 0..1 confidence from support count and fit error. */
  confidence: number;
}

let candidateCounter = 0;
function candidateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  candidateCounter += 1;
  return `endgroup-${Date.now()}-${candidateCounter}`;
}

function peakMz(p: Peak): number {
  return p.centroid ?? p.mz;
}

/**
 * Solve candidate end-group masses for a known repeat unit across the given
 * adducts. Returns candidates best-supported first, each annotated with the
 * nearest library end group where one matches.
 */
export function solveEndGroups(
  peaks: Peak[],
  repeatMass: number,
  adducts: Adduct[],
  options: EndGroupOptions = {},
): EndGroupCandidate[] {
  const tol = options.toleranceDa ?? 0.5;
  const minOligomers = options.minOligomers ?? 3;
  const libTol = options.libraryToleranceDa ?? 0.3;
  const maxCandidates = options.maxCandidates ?? 12;
  if (!(repeatMass > 0) || adducts.length === 0) return [];

  const pts = peaks.filter((p) => p.accepted !== false && !p.ignored && p.flag !== "isotope");
  const out: EndGroupCandidate[] = [];

  for (const adduct of adducts) {
    const residuals: number[] = [];
    for (const peak of pts) {
      const neutral = neutralMass(peakMz(peak), adduct);
      if (neutral <= 0) continue;
      residuals.push(neutral - Math.floor(neutral / repeatMass) * repeatMass);
    }
    if (residuals.length < minOligomers) continue;
    residuals.sort((a, b) => a - b);

    // Cluster residuals (with wraparound across the 0/repeat seam).
    const clusters: number[][] = [];
    let current: number[] = [];
    for (const r of residuals) {
      if (current.length === 0 || r - current[current.length - 1] <= tol) current.push(r);
      else {
        clusters.push(current);
        current = [r];
      }
    }
    if (current.length) clusters.push(current);
    if (clusters.length > 1) {
      const last = clusters[clusters.length - 1];
      const first = clusters[0];
      if (repeatMass - last[last.length - 1] + first[0] <= tol) {
        clusters.pop();
        clusters[0] = [...last.map((v) => v - repeatMass), ...first];
      }
    }

    for (const cluster of clusters) {
      if (cluster.length < minOligomers) continue;
      const mean = cluster.reduce((s, v) => s + v, 0) / cluster.length;
      const residualMass = ((mean % repeatMass) + repeatMass) % repeatMass;
      const variance = cluster.reduce((s, v) => s + (v - mean) ** 2, 0) / cluster.length;
      const meanErrorDa = Math.sqrt(variance);

      let libraryMatch: string | undefined;
      let bestDelta = libTol;
      for (const entry of END_GROUP_LIBRARY) {
        const delta = Math.abs(((entry.mass % repeatMass) + repeatMass) % repeatMass - residualMass);
        const wrapped = Math.min(delta, repeatMass - delta);
        if (wrapped <= bestDelta) {
          bestDelta = wrapped;
          libraryMatch = entry.label;
        }
      }

      const supportTerm = cluster.length / (cluster.length + 3);
      const errorTerm = Math.max(0, 1 - meanErrorDa / tol);
      const confidence = Number((supportTerm * errorTerm).toFixed(4));

      out.push({
        id: candidateId(),
        residualMass,
        adductId: adduct.id,
        matchedOligomers: cluster.length,
        meanErrorDa,
        libraryMatch,
        confidence,
      });
    }
  }

  out.sort((a, b) => b.confidence - a.confidence || b.matchedOligomers - a.matchedOligomers);
  return out.slice(0, maxCandidates);
}
