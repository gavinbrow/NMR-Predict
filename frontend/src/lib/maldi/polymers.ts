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
  /**
   * Fold candidates that differ from a stronger candidate by ~k isotope steps
   * (¹³C−¹²C ≈ 1.0034 Da) into that candidate, so a single repeat unit measured
   * between different isotopologues doesn't surface as several near-identical
   * "different" repeats. Default true. {@link isotopeStep} and
   * {@link isotopeMergeTol} tune the band. */
  isotopeAware?: boolean;
  /** Isotope spacing used by {@link isotopeAware} merging (Da). Default 1.0033548. */
  isotopeStep?: number;
  /** Tolerance around k·isotopeStep for the merge (Da). Default 0.15. */
  isotopeMergeTol?: number;
}

/** ¹³C − ¹²C mass difference: the spacing between adjacent isotope peaks. */
export const ISOTOPE_STEP = 1.0033548;

/**
 * Fold isotope-shifted duplicates into their parent repeat. Two candidates that
 * differ by ~k·isotopeStep (k ≥ 1) are the *same* repeat unit measured between
 * different isotopologues (e.g. oligomer n's monoisotopic peak to oligomer n+1's
 * A+1 satellite). Iterating strongest-first, each weaker candidate within the
 * isotope band of an already-kept (stronger) one is merged into it — its votes
 * add to the parent's score but the parent's mass (the better-determined one) is
 * preserved. Candidates a non-integer-Da apart (genuinely different repeats) are
 * untouched, so 44 vs 58 vs 224 all survive.
 */
function mergeIsotopeShiftedCandidates(
  candidates: RepeatCandidate[],
  step: number,
  tol: number,
  maxShift = 4,
): RepeatCandidate[] {
  const byScore = [...candidates].sort((a, b) => b.score - a.score);
  const kept: RepeatCandidate[] = [];
  for (const cand of byScore) {
    const parent = kept.find((k) => {
      const diff = Math.abs(k.repeatMass - cand.repeatMass);
      if (diff < step - tol) return false; // same bin, not an isotope shift
      const ratio = diff / step;
      const nearest = Math.round(ratio);
      return nearest >= 1 && nearest <= maxShift && Math.abs(diff - nearest * step) <= tol;
    });
    if (parent) {
      parent.count += cand.count;
      parent.score += cand.score;
    } else {
      kept.push({ ...cand });
    }
  }
  return kept;
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
 * Heuristic: does the spectrum look like unit (integer) m/z resolution? Linear-mode
 * MALDI of a polymer is often exported at unit resolution, so every m/z is an
 * integer-rounded value. That rounding (±0.5 Da per peak) smears a ladder's
 * residual-mod-repeat across a ~1 Da band and can make adjacent rungs differ by a
 * full Dalton — which the tight high-res tolerance (0.5 Da) reads as *two* series,
 * silently dropping members. We detect the case so callers can widen tolerance.
 */
export function looksUnitResolution(peaks: Peak[]): boolean {
  const pts = analyzablePeaks(peaks);
  if (pts.length < 3) return false;
  let near = 0;
  for (const p of pts) {
    const m = peakMz(p);
    if (Math.abs(m - Math.round(m)) < 0.06) near += 1;
  }
  return near / pts.length >= 0.8;
}

/**
 * Effective spacing/clustering tolerance for series & end-group work. For ordinary
 * (high-res) data the caller's tolerance is used as-is; for unit-resolution data it
 * is widened to ≥1.1 Da so a single rounding-drifted ladder links/clusters as one
 * series instead of fragmenting. Distinct end groups sit many Da apart, so the
 * wider band does not merge genuinely different ladders.
 */
export function seriesTolerance(peaks: Peak[], baseTol: number): number {
  return looksUnitResolution(peaks) ? Math.max(baseTol, 1.1) : baseTol;
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
  const isotopeAware = options.isotopeAware ?? true;
  const isotopeStep = options.isotopeStep ?? ISOTOPE_STEP;
  const isotopeMergeTol = options.isotopeMergeTol ?? 0.15;

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

  const merged = isotopeAware
    ? mergeIsotopeShiftedCandidates(candidates, isotopeStep, isotopeMergeTol)
    : candidates;
  merged.sort((a, b) => b.score - a.score);
  const top = merged.slice(0, maxCandidates);
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
  const tol = seriesTolerance(peaks, toleranceDa);
  const pts = analyzablePeaks(peaks)
    .slice()
    .sort((a, b) => peakMz(a) - peakMz(b));
  for (let i = 0; i < pts.length; i += 1) {
    for (let j = i + 1; j < pts.length; j += 1) {
      const delta = peakMz(pts[j]) - peakMz(pts[i]);
      if (delta > repeatMass + tol) break;
      if (Math.abs(delta - repeatMass) <= tol) {
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
/**
 * Link peaks into homologous ladders by *m/z spacing*: two peaks join when their
 * m/z differ by ~k·repeat (k = 1..maxGap+1, so one missing rung doesn't break a
 * ladder). The connected components are the ladders. Linking by spacing — rather
 * than by residual-mod-repeat — is what makes this robust on unit-resolution data:
 * a wide tolerance can't chain unrelated peaks together (they must actually sit a
 * repeat apart), so rounding drift is bridged without merging different ladders.
 * `pts` must be sorted ascending by m/z; each returned component is too.
 */
export function linkByRepeat(
  pts: Peak[],
  repeatMass: number,
  tol: number,
  maxGap: number,
): Peak[][] {
  const n = pts.length;
  if (n === 0 || !(repeatMass > 0)) return [];
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
  for (let i = 0; i < n; i += 1) {
    const mzi = peakMz(pts[i]);
    for (let j = i + 1; j < n; j += 1) {
      const delta = peakMz(pts[j]) - mzi;
      if (delta > maxSpacing) break; // sorted: no further j can be in range
      const k = Math.round(delta / repeatMass);
      if (k >= 1 && k <= maxGap + 1 && Math.abs(delta - k * repeatMass) <= tol) union(i, j);
    }
  }
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const r = find(i);
    const arr = byRoot.get(r);
    if (arr) arr.push(i);
    else byRoot.set(r, [i]);
  }
  return [...byRoot.values()].map((idxs) => idxs.map((i) => pts[i]));
}

export function seriesForRepeat(
  peaks: Peak[],
  repeatMass: number,
  options: RepeatSeriesOptions = {},
): RepeatSeriesGroup[] {
  const tol = seriesTolerance(peaks, options.toleranceDa ?? 0.3);
  const minMembers = options.minMembers ?? 3;
  const maxGap = options.maxGap ?? 1;
  if (!(repeatMass > 0)) return [];

  const pts = analyzablePeaks(peaks)
    .slice()
    .sort((a, b) => peakMz(a) - peakMz(b));
  if (pts.length < minMembers) return [];

  const components = linkByRepeat(pts, repeatMass, tol, maxGap);

  const groups: RepeatSeriesGroup[] = [];
  for (const members of components) {
    if (members.length < minMembers) continue;
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
  /** Bridge up to this many missing rungs when linking a ladder. Default 1. */
  maxGap?: number;
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
  const tol = seriesTolerance(peaks, options.toleranceDa ?? 0.5);
  const minMembers = options.minMembers ?? 3;
  const minConsecutive = options.minConsecutive ?? 3;
  const maxSeries = options.maxSeries ?? 12;
  const maxGap = options.maxGap ?? 1;
  if (!(repeatMass > 0) || adducts.length === 0) return [];

  const pts = analyzablePeaks(peaks)
    .slice()
    .sort((a, b) => peakMz(a) - peakMz(b));
  if (pts.length < minMembers) return [];

  // Ladders are defined by m/z spacing and are adduct-independent (the adduct only
  // shifts the end-group residual and the absolute oligomer numbering). Linking by
  // spacing — not residual-mod — is robust on unit-resolution data where rounding
  // drifts the residual a full Dalton across the mass range.
  const components = linkByRepeat(pts, repeatMass, tol, maxGap);
  const out: Series[] = [];

  for (const adduct of adducts) {
    for (const component of components) {
      if (component.length < minMembers) continue;
      const items = component
        .map((peak) => ({ peak, neutral: neutralMass(peakMz(peak), adduct) }))
        .filter((x) => x.neutral > 0)
        .sort((a, b) => a.neutral - b.neutral);
      if (items.length < minMembers) continue;

      // Assign oligomer numbers from the spacing; keep the most intense peak per n.
      const base = items[0].neutral;
      const byN = new Map<number, { peak: Peak; neutral: number }>();
      for (const it of items) {
        const n = Math.round((it.neutral - base) / repeatMass);
        const existing = byN.get(n);
        if (!existing || it.peak.intensity > existing.peak.intensity) byN.set(n, it);
      }
      if (byN.size < minMembers) continue;
      const longestRun = longestConsecutiveRun([...byN.keys()]);
      if (longestRun < minConsecutive) continue;

      // End group = Y-intercept (mean of neutral − n·repeat) reduced modulo repeat.
      let interceptSum = 0;
      for (const [n, it] of byN) interceptSum += it.neutral - n * repeatMass;
      const intercept = interceptSum / byN.size;
      const endGroup = ((intercept % repeatMass) + repeatMass) % repeatMass;
      let sse = 0;
      for (const [n, it] of byN) {
        const err = it.neutral - (intercept + n * repeatMass);
        sse += err * err;
      }
      const meanErrorDa = Math.sqrt(sse / byN.size);
      // Re-base n onto absolute oligomer indices consistent with the end group.
      const n0 = Math.max(0, Math.round((base - endGroup) / repeatMass));
      const members2: { peakId: string; n: number }[] = [...byN.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([n, it]) => ({ peakId: it.peak.id, n: n + n0 }));

      const score = scoreSeries(byN.size, longestRun, meanErrorDa, tol);
      const r2 = regressionR2([...byN.keys()], [...byN.values()].map((it) => it.neutral));
      out.push({
        id: seriesId(),
        label: `${adduct.label} · ${repeatMass.toFixed(2)} Da`,
        repeatMass,
        endGroupMass: endGroup,
        adductId: adduct.id,
        members: members2,
        score,
        meanErrorDa,
        r2,
      });
    }
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, maxSeries);
}

export interface LadderFit {
  /** End-group mass (Y-intercept of neutral mass vs n) reduced modulo the repeat. */
  endGroupMass: number;
  /** RMS deviation of the members from the fitted ladder (Da). */
  meanErrorDa: number;
  /** 0..1 quality score (count + consecutive run, penalised by fit error). */
  score: number;
  /** R² of the neutral-mass-vs-n regression. */
  r2: number;
  /** The members with their assigned oligomer number n, ascending. */
  members: { peakId: string; n: number }[];
}

/**
 * Fit a homologous ladder from an explicit set of member peaks — used after the
 * user manually adds/removes a member on the plot. Oligomer numbers n are assigned
 * from the spacing, and the end group is the regression intercept of neutral mass
 * vs n with the slope fixed at the repeat (mean of neutral − n·repeat), reduced
 * modulo the repeat: exactly the "Y-intercept" reading the report uses. Returns
 * null if no member resolves to a positive neutral mass.
 */
export function fitLadder(
  peaks: Peak[],
  peakIds: Iterable<string>,
  repeatMass: number,
  adduct: Adduct,
): LadderFit | null {
  if (!(repeatMass > 0)) return null;
  const byId = new Map(peaks.map((p) => [p.id, p] as const));
  const items: { peakId: string; neutral: number }[] = [];
  for (const id of peakIds) {
    const p = byId.get(id);
    if (!p) continue;
    const neutral = neutralMass(peakMz(p), adduct);
    if (neutral > 0) items.push({ peakId: id, neutral });
  }
  if (items.length === 0) return null;
  items.sort((a, b) => a.neutral - b.neutral);
  const base = items[0].neutral;
  const withN = items.map((it) => ({ ...it, n: Math.round((it.neutral - base) / repeatMass) }));
  const intercept = withN.reduce((s, it) => s + (it.neutral - it.n * repeatMass), 0) / withN.length;
  const endGroupMass = ((intercept % repeatMass) + repeatMass) % repeatMass;
  let sse = 0;
  for (const it of withN) {
    const err = it.neutral - (intercept + it.n * repeatMass);
    sse += err * err;
  }
  const meanErrorDa = Math.sqrt(sse / withN.length);
  // Re-base n onto absolute oligomer indices consistent with the end group.
  const n0 = Math.max(0, Math.round((base - endGroupMass) / repeatMass));
  const members = withN
    .map((it) => ({ peakId: it.peakId, n: it.n + n0 }))
    .sort((a, b) => a.n - b.n);
  const longestRun = longestConsecutiveRun(members.map((m) => m.n));
  const score = scoreSeries(members.length, longestRun, meanErrorDa, seriesTolerance(peaks, 0.5));
  const r2 = regressionR2(withN.map((it) => it.n), withN.map((it) => it.neutral));
  return { endGroupMass, meanErrorDa, score, r2, members };
}

/** R² of an ordinary least-squares fit of ys on xs (1 if degenerate). Used to show
 *  how cleanly a ladder obeys neutral mass = endGroup + n·repeat. */
function regressionR2(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 1;
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
  if (syy <= 0) return 1;
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = ybar - slope * xbar;
  let ssRes = 0;
  for (let i = 0; i < n; i += 1) ssRes += (ys[i] - (intercept + slope * xs[i])) ** 2;
  return Math.max(0, 1 - ssRes / syy);
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
