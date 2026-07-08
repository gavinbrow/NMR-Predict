import { seriesMemberOverlap } from "./seriesMatch";
import type { Series } from "./types";

/** Shared positional palette for series ladders (plot, sidebar, table). */
export const SERIES_COLORS = [
  "#d946ef", "#0ea5e9", "#22c55e", "#f59e0b", "#ef4444",
  "#8b5cf6", "#14b8a6", "#ec4899", "#65a30d", "#f97316",
];

/**
 * Colour every series by the distinct peak ladder it belongs to. Different adduct
 * readings of the SAME ladder share (almost) all of their member peaks, so they
 * land in one group and get one colour — [M+H]⁺ and [M+Na]⁺ of a polymer read as
 * the same colour. Distinct ladders have disjoint peaks and get distinct colours.
 *
 * Grouping is greedy in first-seen order (a series joins the first earlier group it
 * overlaps, else opens a new one), so a colour is stable as the list grows and a
 * confirmed series keeps the colour of its still-pending siblings. Returns a map of
 * series id → colour; a manual `series.color` is applied by the caller and wins.
 */
export function buildLadderColorMap(series: Series[], minOverlap = 0.6): Map<string, string> {
  const colorById = new Map<string, string>();
  const groupReps: Series[] = [];
  for (const s of series) {
    let groupIdx = groupReps.findIndex((rep) => seriesMemberOverlap(rep, s) >= minOverlap);
    if (groupIdx === -1) {
      groupReps.push(s);
      groupIdx = groupReps.length - 1;
    }
    colorById.set(s.id, SERIES_COLORS[groupIdx % SERIES_COLORS.length]);
  }
  return colorById;
}
