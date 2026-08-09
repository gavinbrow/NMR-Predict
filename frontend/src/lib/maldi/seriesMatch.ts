import type { EndGroupCandidate } from "./endgroups";
import type { Peak, Series } from "./types";

/** Peak ids explained by any assigned series (a peak belongs to a series when it
 *  is one of its ladder members). */
export function explainedPeakIds(series: Series[]): Set<string> {
  const ids = new Set<string>();
  for (const s of series) for (const m of s.members) ids.add(m.peakId);
  return ids;
}

/** Peaks not explained by any series and still in play (accepted, not ignored,
 *  not flagged) — the leftover peaks an analyst triages / labels / deletes. */
export function unexplainedPeaks(peaks: Peak[], series: Series[]): Peak[] {
  const explained = explainedPeakIds(series);
  return peaks.filter(
    (p) => p.accepted !== false && !p.ignored && !p.flag && !explained.has(p.id),
  );
}

/** Find the series an end-group candidate belongs to: same adduct and at least
 *  one overlapping member peak. Returns null when no series matches. */
export function matchSeriesForEndGroup(
  series: Series[],
  candidate: EndGroupCandidate,
): Series | null {
  for (const s of series) {
    if (s.adductId !== candidate.adductId) continue;
    if (s.members.some((m) => candidate.members.some((cm) => cm.peakId === m.peakId))) {
      return s;
    }
  }
  return null;
}
/** Fraction of the smaller member set two series share (by peak id). 1 = identical
 *  ladders, 0 = disjoint. Alternative adduct readings of the same peaks score ~1. */
export function seriesMemberOverlap(a: Series, b: Series): number {
  const setA = new Set(a.members.map((m) => m.peakId));
  let shared = 0;
  for (const m of b.members) if (setA.has(m.peakId)) shared += 1;
  const denom = Math.min(a.members.length, b.members.length);
  return denom > 0 ? shared / denom : 0;
}

/** Member-overlap above which two series are treated as the same ladder read under
 *  different adducts. Shared by `sameLadderSiblings` (which hides the losers once
 *  one is confirmed) and the report's collapse of never-confirmed readings, so the
 *  two never disagree about what "the same ladder" means. */
export const SAME_LADDER_OVERLAP = 0.6;

/** Pending series that are alternative adduct readings of the SAME peak ladder as
 *  `target` (they share most of their member peaks). Excludes `target`, already-
 *  confirmed series (endGroupLocked), and already-superseded series. */
export function sameLadderSiblings(series: Series[], target: Series, minOverlap = SAME_LADDER_OVERLAP): Series[] {
  return series.filter(
    (s) =>
      s.id !== target.id &&
      !s.endGroupLocked &&
      !s.supersededBy &&
      seriesMemberOverlap(s, target) >= minOverlap,
  );
}
