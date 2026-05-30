// Polymer repeat-unit detection and oligomer-series assignment — the core
// MALDI-interpretation differentiator.
//
// Two stages:
//   1. detectRepeatUnits: a pairwise Δm histogram over the picked peaks surfaces
//      the spacings that recur most (intensity-weighted) → candidate repeat units.
//   2. assignSeries: for a given repeat unit and a set of candidate adducts, group
//      peaks by their residual mass modulo the repeat (after removing the adduct).
//      Peaks sharing a residual form a homologous series m/z ≈ endGroup + n·repeat
//      + adduct. This naturally yields multiple overlapping series (different end
//      groups) and multiple adduct series for the same polymer.
//
// Everything is scored and reversible; nothing is assigned without series-level
// evidence (a guardrail), and the user can supply their own repeat unit.

import { adductById, neutralMass } from "./adducts";
import type { Adduct, Peak, Series } from "./types";

export interface RepeatCandidate {
  /** Intensity-weighted mean spacing of the cluster. */
  repeatMass: number;
  /** Number of peak pairs separated by ~this spacing. */
  count: number;
  /** Relative score (count × intensity weighting), normalized to the top = 1. */
  score: number;
}

export interface RepeatDetectOptions {
  /** Smallest spacing to consider (Da). Default 20 (excludes isotope spacing). */
  minRepeat?: number;
  /** Largest spacing to consider (Da). Default 400. */
  maxRepeat?: number;
  /** Histogram bin width (Da). Default 0.05. */
  binWidth?: number;
  /** Max candidates to return. Default 8. */
  maxCandidates?: number;
}

/** Peaks eligible for analysis: accepted, not ignored, not flagged background. */
function analyzablePeaks(peaks: Peak[]): Peak[] {
  return peaks.filter(
    (p) =>
      p.accepted !== false &&
      !p.ignored &&
      p.flag !== "isotope" &&
      p.flag !== "matrix" &&
      p.flag !== "matrixCluster" &&
      p.flag !== "salt",
  );
}

function peakMz(p: Peak): number {
  return p.centroid ?? p.mz;
}

/**
 * Detect candidate repeat units from the pairwise Δm distribution. Each pair of
 * peaks within [minRepeat, maxRepeat] votes (weighted by the geometric mean of
 * the two intensities) into a histogram; clusters of votes become candidates.
 */
export function detectRepeatUnits(
  peaks: Peak[],
  options: RepeatDetectOptions = {},
): RepeatCandidate[] {
  const minRepeat = options.minRepeat ?? 20;
  const maxRepeat = options.maxRepeat ?? 400;
  const binWidth = options.binWidth ?? 0.05;
  const maxCandidates = options.maxCandidates ?? 8;

  const pts = analyzablePeaks(peaks)
    .slice()
    .sort((a, b) => peakMz(a) - peakMz(b));
  if (pts.length < 3) return [];

  // Accumulate weighted votes and weighted Δ sums per bin so we can recover the
  // precise mean spacing of each cluster rather than the bin center.
  const binCount = new Map<number, number>();
  const binWeight = new Map<number, number>();
  const binDeltaSum = new Map<number, number>();

  for (let i = 0; i < pts.length; i += 1) {
    for (let j = i + 1; j < pts.length; j += 1) {
      const delta = peakMz(pts[j]) - peakMz(pts[i]);
      if (delta < minRepeat) continue;
      if (delta > maxRepeat) break; // sorted: no further j can be in range
      const weight = Math.sqrt(Math.max(pts[i].intensity, 0) * Math.max(pts[j].intensity, 0)) || 1;
      const bin = Math.round(delta / binWidth);
      binCount.set(bin, (binCount.get(bin) ?? 0) + 1);
      binWeight.set(bin, (binWeight.get(bin) ?? 0) + weight);
      binDeltaSum.set(bin, (binDeltaSum.get(bin) ?? 0) + delta * weight);
    }
  }
  if (binCount.size === 0) return [];

  // Merge each bin with its immediate neighbors (a spacing can straddle a bin
  // edge) into local-maximum clusters.
  const bins = [...binWeight.keys()].sort((a, b) => a - b);
  const used = new Set<number>();
  const candidates: RepeatCandidate[] = [];

  for (const bin of bins) {
    if (used.has(bin)) continue;
    const w = binWeight.get(bin) ?? 0;
    const wPrev = binWeight.get(bin - 1) ?? 0;
    const wNext = binWeight.get(bin + 1) ?? 0;
    if (w < wPrev || w < wNext) continue; // keep only local maxima

    let count = 0;
    let weight = 0;
    let deltaSum = 0;
    for (let b = bin - 1; b <= bin + 1; b += 1) {
      if (used.has(b)) continue;
      used.add(b);
      count += binCount.get(b) ?? 0;
      weight += binWeight.get(b) ?? 0;
      deltaSum += binDeltaSum.get(b) ?? 0;
    }
    if (count < 2 || weight <= 0) continue;
    candidates.push({ repeatMass: deltaSum / weight, count, score: weight });
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, maxCandidates);
  const maxScore = top.length ? top[0].score : 1;
  return top.map((c) => ({ ...c, score: c.score / maxScore }));
}

/**
 * Peak ids that take part in at least one ~`repeatMass` spacing — i.e. the peaks
 * that could belong to a homologous series with this repeat unit. Used to preview
 * a candidate repeat in the viewer the moment it is clicked, before a full series
 * assignment (which additionally needs the chosen adducts). Only analyzable peaks
 * are considered; the early `break` keeps the sorted scan near-linear.
 */
export function peaksForRepeat(
  peaks: Peak[],
  repeatMass: number,
  toleranceDa = 0.3,
): Set<string> {
  const ids = new Set<string>();
  if (!(repeatMass > 0)) return ids;
  const pts = analyzablePeaks(peaks)
    .slice()
    .sort((a, b) => peakMz(a) - peakMz(b));
  for (let i = 0; i < pts.length; i += 1) {
    for (let j = i + 1; j < pts.length; j += 1) {
      const delta = peakMz(pts[j]) - peakMz(pts[i]);
      if (delta > repeatMass + toleranceDa) break;
      if (Math.abs(delta - repeatMass) <= toleranceDa) {
        ids.add(pts[i].id);
        ids.add(pts[j].id);
      }
    }
  }
  return ids;
}

export interface RepeatSeriesGroup {
  /** Residual mass (Da) modulo the repeat that identifies this ladder. Peaks with
   *  a different end group or adduct land on a different residual, hence a
   *  different ladder. */
  offset: number;
  /** Member peak ids, ascending m/z. */
  peakIds: string[];
  /** m/z of the lightest and heaviest ladder member (for display/sorting). */
  startMz: number;
  endMz: number;
}

export interface RepeatSeriesOptions {
  /** Spacing match tolerance (Da). Default 0.3. */
  toleranceDa?: number;
  /** Minimum members for a reported ladder. Default 3. */
  minMembers?: number;
  /** Bridge up to this many missing rungs when linking a ladder. Default 1. */
  maxGap?: number;
}

/**
 * Group the analyzable peaks into the distinct homologous series (ladders) that
 * share a `repeatMass` spacing. A single repeat unit usually produces several
 * interleaved ladders — different end groups or adducts each sit on their own
 * offset — and this separates them so the viewer can colour each one apart,
 * rather than lumping every spaced peak into a single highlight.
 *
 * Two peaks are linked when their m/z differ by ~k·repeat (k up to `maxGap`+1, so
 * one missing oligomer doesn't break a ladder); the connected components are the
 * ladders. Unlike {@link assignSeries} this is adduct-agnostic and works on m/z
 * directly, so it is an instant preview the moment a repeat unit is picked.
 */
export function seriesForRepeat(
  peaks: Peak[],
  repeatMass: number,
  options: RepeatSeriesOptions = {},
): RepeatSeriesGroup[] {
  const tol = options.toleranceDa ?? 0.3;
  const minMembers = options.minMembers ?? 3;
  const maxGap = options.maxGap ?? 1;
  if (!(repeatMass > 0)) return [];

  const pts = analyzablePeaks(peaks)
    .slice()
    .sort((a, b) => peakMz(a) - peakMz(b));
  if (pts.length < minMembers) return [];

  // Union–find: link peaks separated by ~k·repeat (k = 1..maxGap+1).
  const parent = pts.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) {
      const next = parent[i];
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const maxSpacing = (maxGap + 1) * repeatMass + tol;
  for (let i = 0; i < pts.length; i += 1) {
    const mzi = peakMz(pts[i]);
    for (let j = i + 1; j < pts.length; j += 1) {
      const delta = peakMz(pts[j]) - mzi;
      if (delta > maxSpacing) break; // sorted: no further j can be in range
      const k = Math.round(delta / repeatMass);
      if (k >= 1 && k <= maxGap + 1 && Math.abs(delta - k * repeatMass) <= tol) {
        union(i, j);
      }
    }
  }

  // Gather connected components (peak indices stay ascending in m/z).
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < pts.length; i += 1) {
    const r = find(i);
    const arr = byRoot.get(r);
    if (arr) arr.push(i);
    else byRoot.set(r, [i]);
  }

  const groups: RepeatSeriesGroup[] = [];
  for (const idxs of byRoot.values()) {
    if (idxs.length < minMembers) continue;
    const members = idxs.map((i) => pts[i]);
    const startMz = peakMz(members[0]);
    const endMz = peakMz(members[members.length - 1]);
    const offset = ((startMz % repeatMass) + repeatMass) % repeatMass;
    groups.push({ offset, peakIds: members.map((p) => p.id), startMz, endMz });
  }
  // Largest ladders first, then by ascending start mass.
  groups.sort((a, b) => b.peakIds.length - a.peakIds.length || a.startMz - b.startMz);
  return groups;
}

export interface AssignOptions {
  /** Match tolerance for assigning a peak to a series (Da). Default 0.5. */
  toleranceDa?: number;
  /** Minimum members for a reported series. Default 3. */
  minMembers?: number;
  /** Minimum longest consecutive run (in n) for a reported series. Default 3. */
  minConsecutive?: number;
  /** Maximum number of series to return. Default 12. */
  maxSeries?: number;
}

interface ResidualMember {
  peak: Peak;
  neutral: number;
  residual: number;
}

let seriesCounter = 0;
function seriesId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  seriesCounter += 1;
  return `series-${Date.now()}-${seriesCounter}`;
}

/** Longest run of consecutive integers present in a set of n values. */
function longestConsecutiveRun(ns: number[]): number {
  const set = new Set(ns);
  let best = 0;
  for (const n of set) {
    if (set.has(n - 1)) continue; // only start counting at run beginnings
    let len = 1;
    while (set.has(n + len)) len += 1;
    best = Math.max(best, len);
  }
  return best;
}

/**
 * Assign oligomer series for one repeat unit across the given adducts. For each
 * adduct, peaks are converted to neutral mass and grouped by residual modulo the
 * repeat; each well-populated residual cluster with a consecutive run becomes a
 * series. Series are scored and returned best-first.
 */
export function assignSeries(
  peaks: Peak[],
  repeatMass: number,
  adducts: Adduct[],
  options: AssignOptions = {},
): Series[] {
  const tol = options.toleranceDa ?? 0.5;
  const minMembers = options.minMembers ?? 3;
  const minConsecutive = options.minConsecutive ?? 3;
  const maxSeries = options.maxSeries ?? 12;
  if (!(repeatMass > 0) || adducts.length === 0) return [];

  const pts = analyzablePeaks(peaks);
  if (pts.length < minMembers) return [];

  const out: Series[] = [];

  for (const adduct of adducts) {
    const members: ResidualMember[] = [];
    for (const peak of pts) {
      const neutral = neutralMass(peakMz(peak), adduct);
      if (neutral <= 0) continue;
      const residual = neutral - Math.floor(neutral / repeatMass) * repeatMass;
      members.push({ peak, neutral, residual });
    }
    if (members.length < minMembers) continue;

    // Cluster residuals on a circle of circumference `repeatMass`.
    members.sort((a, b) => a.residual - b.residual);
    const clusters: ResidualMember[][] = [];
    let current: ResidualMember[] = [];
    for (const m of members) {
      if (current.length === 0) {
        current.push(m);
        continue;
      }
      if (m.residual - current[current.length - 1].residual <= tol) {
        current.push(m);
      } else {
        clusters.push(current);
        current = [m];
      }
    }
    if (current.length) clusters.push(current);
    // Wraparound: a residual just below `repeatMass` and one just above 0 belong
    // to the same series, so merge the last cluster into the first if the gap
    // across the 0/repeatMass seam is within tolerance.
    if (clusters.length > 1) {
      const last = clusters[clusters.length - 1];
      const first = clusters[0];
      const seamGap = repeatMass - last[last.length - 1].residual + first[0].residual;
      if (seamGap <= tol) {
        clusters.pop();
        clusters[0] = [...last, ...first];
      }
    }

    for (const cluster of clusters) {
      if (cluster.length < minMembers) continue;

      // Reference residual (median) to assign integer oligomer counts.
      const residuals = cluster.map((m) => m.residual).sort((a, b) => a - b);
      const refResidual = residuals[residuals.length >> 1];
      const endGroup = refResidual;

      // Assign n; keep the most intense peak per n.
      const byN = new Map<number, ResidualMember>();
      for (const m of cluster) {
        const n = Math.round((m.neutral - endGroup) / repeatMass);
        if (n < 0) continue;
        const existing = byN.get(n);
        if (!existing || m.peak.intensity > existing.peak.intensity) byN.set(n, m);
      }
      if (byN.size < minMembers) continue;

      const ns = [...byN.keys()].sort((a, b) => a - b);
      const longestRun = longestConsecutiveRun(ns);
      if (longestRun < minConsecutive) continue;

      // Residual error of the fit (Da, RMS).
      let sse = 0;
      for (const [n, m] of byN) {
        const predicted = endGroup + n * repeatMass;
        const err = m.neutral - predicted;
        sse += err * err;
      }
      const meanErrorDa = Math.sqrt(sse / byN.size);

      const members2: { peakId: string; n: number }[] = [...byN.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([n, m]) => ({ peakId: m.peak.id, n }));

      const score = scoreSeries(byN.size, longestRun, meanErrorDa, tol);
      out.push({
        id: seriesId(),
        label: `${adduct.label} · ${repeatMass.toFixed(2)} Da`,
        repeatMass,
        endGroupMass: endGroup,
        adductId: adduct.id,
        members: members2,
        score,
        meanErrorDa,
      });
    }
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, maxSeries);
}

/** Combine matched count, consecutive run, and fit error into a 0..1 score. */
function scoreSeries(
  matched: number,
  longestRun: number,
  meanErrorDa: number,
  tol: number,
): number {
  // Reward more matched peaks and longer unbroken runs; penalize fit error so a
  // tight, long, well-populated series scores near 1 and a loose one near 0.
  const errorTerm = Math.max(0, 1 - meanErrorDa / Math.max(tol, 1e-6));
  const runTerm = longestRun / (longestRun + 2);
  const countTerm = matched / (matched + 3);
  return Number(((0.5 * countTerm + 0.5 * runTerm) * errorTerm).toFixed(4));
}

/** Resolve the adduct label for a series (for display). */
export function seriesAdductLabel(series: Series, adducts: Adduct[]): string {
  return adductById(adducts, series.adductId).label;
}

// ---------------------------------------------------------------------------
// Copolymer / alternating repeat detection (Phase 4)
// ---------------------------------------------------------------------------

export interface CopolymerOptions {
  /** Candidate repeat masses (Da). The two strongest pairwise spacings if omitted. */
  repeatA?: number;
  repeatB?: number;
  /** Match tolerance for a peak fitting the 2-D lattice (Da). Default 0.5. */
  toleranceDa?: number;
  /** Minimum lattice points to report a copolymer family. Default 6. */
  minMembers?: number;
  /** Maximum n,m to consider per repeat. Default 80. */
  maxIndex?: number;
  /** Max families returned. Default 6. */
  maxSeries?: number;
}

export interface CopolymerSeries {
  id: string;
  label: string;
  repeatA: number;
  repeatB: number;
  endGroupMass: number;
  adductId: string;
  /** Peak ids on the 2-D lattice with their (a, b) composition. */
  members: { peakId: string; a: number; b: number }[];
  score: number;
  meanErrorDa: number;
}

/**
 * Detect a two-monomer (copolymer / alternating) family: m/z ≈ endGroup +
 * a·repeatA + b·repeatB + adduct. For each adduct we take the analyzable peaks'
 * neutral masses and, for every (a, b) within bounds, test whether a peak sits at
 * endGroup + a·A + b·B. The end group is estimated from the lowest-mass peak.
 * This is a coarse, evidence-first detector — multiple end groups would surface as
 * separate families. Defaults derive A and B from the two strongest spacings.
 */
export function detectCopolymer(
  peaks: Peak[],
  adducts: Adduct[],
  options: CopolymerOptions = {},
): CopolymerSeries[] {
  const tol = options.toleranceDa ?? 0.5;
  const minMembers = options.minMembers ?? 6;
  const maxIndex = options.maxIndex ?? 80;
  const maxSeries = options.maxSeries ?? 6;

  const pts = analyzablePeaks(peaks);
  if (pts.length < minMembers || adducts.length === 0) return [];

  let repeatA = options.repeatA;
  let repeatB = options.repeatB;
  if (!(repeatA && repeatA > 0) || !(repeatB && repeatB > 0)) {
    const top = detectRepeatUnits(peaks, { maxCandidates: 4 });
    if (top.length < 2) return [];
    repeatA = repeatA && repeatA > 0 ? repeatA : top[0].repeatMass;
    repeatB = repeatB && repeatB > 0 ? repeatB : top[1].repeatMass;
  }
  if (Math.abs(repeatA - repeatB) < 1e-6) return [];

  const out: CopolymerSeries[] = [];

  for (const adduct of adducts) {
    const neutrals = pts
      .map((p) => ({ peak: p, neutral: neutralMass(peakMz(p), adduct) }))
      .filter((x) => x.neutral > 0)
      .sort((a, b) => a.neutral - b.neutral);
    if (neutrals.length < minMembers) continue;

    // Estimate the end group from the lightest peak modulo the two repeats.
    const m0 = neutrals[0].neutral;
    const endGroup = m0 - Math.floor(m0 / Math.min(repeatA, repeatB)) * Math.min(repeatA, repeatB);

    const members: { peakId: string; a: number; b: number; err: number }[] = [];
    const usedPeaks = new Set<string>();
    for (let a = 0; a <= maxIndex; a += 1) {
      const baseA = endGroup + a * repeatA;
      if (baseA > neutrals[neutrals.length - 1].neutral + tol) break;
      for (let b = 0; b <= maxIndex; b += 1) {
        const target = baseA + b * repeatB;
        if (target > neutrals[neutrals.length - 1].neutral + tol) break;
        // Find the nearest peak to this lattice point.
        let best: { peakId: string; err: number } | null = null;
        for (const { peak, neutral } of neutrals) {
          const err = Math.abs(neutral - target);
          if (err <= tol && (!best || err < Math.abs(best.err))) {
            best = { peakId: peak.id, err: neutral - target };
          }
        }
        if (best && !usedPeaks.has(best.peakId)) {
          usedPeaks.add(best.peakId);
          members.push({ peakId: best.peakId, a, b, err: best.err });
        }
      }
    }

    // Require genuine 2-D structure (both monomers vary), not just one homopolymer.
    const aVals = new Set(members.map((m) => m.a));
    const bVals = new Set(members.map((m) => m.b));
    if (members.length < minMembers || aVals.size < 2 || bVals.size < 2) continue;

    const sse = members.reduce((s, m) => s + m.err * m.err, 0);
    const meanErrorDa = Math.sqrt(sse / members.length);
    const coverage = members.length / pts.length;
    const errorTerm = Math.max(0, 1 - meanErrorDa / tol);
    const score = Number((coverage * errorTerm).toFixed(4));

    out.push({
      id: seriesId(),
      label: `${adduct.label} · ${repeatA.toFixed(1)}/${repeatB.toFixed(1)} Da`,
      repeatA,
      repeatB,
      endGroupMass: endGroup,
      adductId: adduct.id,
      members: members
        .sort((x, y) => x.a - y.a || x.b - y.b)
        .map(({ peakId, a, b }) => ({ peakId, a, b })),
      score,
      meanErrorDa,
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, maxSeries);
}
