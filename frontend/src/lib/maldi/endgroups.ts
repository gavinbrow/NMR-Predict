// End-group analysis.
//
// Once a repeat unit and adduct are known, the part of each oligomer's mass that
// is NOT explained by whole repeat units and the adduct is the end-group mass
// (α + ω termini). Peaks in a series share this residual, so clustering residuals
// modulo the repeat — for each candidate adduct — yields candidate end-group
// masses, which we match against a small library of common termini.

import { neutralMass } from "./adducts";
import { linkByRepeat, seriesTolerance } from "./polymers";
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
  /** Bridge up to this many missing rungs when linking a ladder. Default 1. */
  maxGap?: number;
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
  /** The peaks supporting this end group, with their oligomer number n. Used to
   *  highlight the ladder in the viewer and to regress mass vs n for the report. */
  members: { peakId: string; n: number }[];
  /** End-group neutral mass read as the Y-intercept of a least-squares fit of
   *  neutral mass vs oligomer number n (slope ≈ the repeat). This is the value the
   *  report regresses; surfaced here so the panel can show the same number. */
  endGroupFit?: number;
  /** Coefficient of determination (0..1) of that mass-vs-n fit. */
  r2?: number;
}

/** Ordinary least squares of y on x, returning slope, intercept and R². */
function linearFit(xs: number[], ys: number[]): { slope: number; intercept: number; r2: number } {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, r2: 1 };
  const xbar = xs.reduce((a, b) => a + b, 0) / n;
  const ybar = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - xbar;
    const dy = ys[i] - ybar;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = ybar - slope * xbar;
  let ssRes = 0;
  for (let i = 0; i < n; i += 1) ssRes += (ys[i] - (intercept + slope * xs[i])) ** 2;
  const r2 = syy > 0 ? Math.max(0, 1 - ssRes / syy) : 1;
  return { slope, intercept, r2 };
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
  const tol = seriesTolerance(peaks, options.toleranceDa ?? 0.5);
  const minOligomers = options.minOligomers ?? 3;
  const libTol = options.libraryToleranceDa ?? 0.3;
  const maxCandidates = options.maxCandidates ?? 12;
  const maxGap = options.maxGap ?? 1;
  if (!(repeatMass > 0) || adducts.length === 0) return [];

  const pts = peaks
    .filter((p) => p.accepted !== false && !p.ignored && p.flag !== "isotope")
    .slice()
    .sort((a, b) => peakMz(a) - peakMz(b));
  if (pts.length < minOligomers) return [];

  // Ladders are linked by m/z spacing (adduct-independent and robust to unit-
  // resolution rounding drift); the adduct only sets the end-group residual.
  const components = linkByRepeat(pts, repeatMass, tol, maxGap);
  const out: EndGroupCandidate[] = [];

  for (const adduct of adducts) {
    for (const component of components) {
      if (component.length < minOligomers) continue;
      const items = component
        .map((peak) => ({ peak, neutral: neutralMass(peakMz(peak), adduct) }))
        .filter((x) => x.neutral > 0)
        .sort((a, b) => a.neutral - b.neutral);
      if (items.length < minOligomers) continue;

      // Assign an oligomer number n from the spacing; keep the most intense peak
      // per n so isotope/duplicate peaks don't double-count a rung.
      const base = items[0].neutral;
      const byN = new Map<number, { peak: Peak; neutral: number }>();
      for (const it of items) {
        const n = Math.round((it.neutral - base) / repeatMass);
        const existing = byN.get(n);
        if (!existing || it.peak.intensity > existing.peak.intensity) byN.set(n, it);
      }
      if (byN.size < minOligomers) continue;

      // Estimate the end-group residual from the (0-based) spacing so we can recover
      // the ABSOLUTE oligomer number of each rung.
      let residSum = 0;
      for (const [n, it] of byN) residSum += it.neutral - n * repeatMass;
      const residual0 = (((residSum / byN.size) % repeatMass) + repeatMass) % repeatMass;
      const n0 = Math.max(0, Math.round((base - residual0) / repeatMass));

      // Y-intercept reading: least-squares fit of neutral mass vs the ABSOLUTE
      // oligomer number n (slope ≈ repeat). The intercept is then the end-group
      // neutral mass itself — exactly the value the user reads off their plot — and
      // R² gauges how cleanly mass = endGroup + n·repeat holds.
      const relNs = [...byN.keys()];
      const xs = relNs.map((n) => n + n0);
      const ys = relNs.map((n) => byN.get(n)!.neutral);
      const fit = linearFit(xs, ys);
      const residualMass = ((fit.intercept % repeatMass) + repeatMass) % repeatMass;
      let sse = 0;
      for (let i = 0; i < xs.length; i += 1) {
        const err = ys[i] - (fit.intercept + fit.slope * xs[i]);
        sse += err * err;
      }
      const meanErrorDa = Math.sqrt(sse / xs.length);
      const members = [...byN.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([n, m]) => ({ peakId: m.peak.id, n: n + n0 }));

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

      const supportTerm = byN.size / (byN.size + 3);
      const errorTerm = Math.max(0, 1 - meanErrorDa / tol);
      const confidence = Number((supportTerm * errorTerm).toFixed(4));

      out.push({
        id: candidateId(),
        residualMass,
        adductId: adduct.id,
        matchedOligomers: byN.size,
        meanErrorDa,
        libraryMatch,
        confidence,
        members,
        endGroupFit: fit.intercept,
        r2: fit.r2,
      });
    }
  }

  out.sort((a, b) => b.confidence - a.confidence || b.matchedOligomers - a.matchedOligomers);
  return out.slice(0, maxCandidates);
}
