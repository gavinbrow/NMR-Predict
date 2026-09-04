// Segment classification, ordinal/cycle numbering, and default-segment choice
// (§WP1.4 of the plan). Pure over the run's flattened arrays and index ranges
// — no parser-specific knowledge here, so both `triosTri.ts` and
// `triosXls.ts` (and, later, the generic/TA importers) build their
// `DscSegment[]` through the same path.

import type { DscSegment, SegmentKind } from "./types";

/** Temperature span below which a segment counts as isothermal, in °C. */
const ISOTHERMAL_SPAN_C = 1;

/** Human-readable noun for each `SegmentKind`, used by `segmentDisplayName`. */
const KIND_NAME: Record<SegmentKind, string> = {
  heat: "Heat",
  cool: "Cool",
  isothermal: "Isothermal",
  unknown: "Segment",
};

/**
 * The one canonical short display name for a segment, e.g. "Heat 1",
 * "Cool 2", "Isothermal 1". Every place that shows a segment to the user —
 * the segment-picker chips, and the "all segments" trace legend in both
 * `plot.ts` and `figure.ts` — derives its label from this, so a heat/cool
 * cycle can never be numbered one way in the picker and another way in the
 * legend. `kind: "unknown"` still gets a number (segments of that kind are
 * counted the same way as any other), rendered as "Segment N" rather than a
 * bare ordinal.
 */
export function segmentDisplayName(segment: Pick<DscSegment, "kind" | "ordinal">): string {
  return `${KIND_NAME[segment.kind]} ${segment.ordinal}`;
}

/**
 * Classify one segment from its temperature/time span:
 *  - `|span| < 1 °C` → `"isothermal"`, rate `null`.
 *  - `duration <= 0` → `"unknown"`, rate `null`.
 *  - otherwise `"heat"` (span > 0) or `"cool"` (span < 0), with
 *    `rateCPerMin = |span| / duration`, rounded to 2 dp.
 */
export function classifySegment(
  tempC: Float64Array,
  timeMin: Float64Array,
  start: number,
  end: number,
): { kind: SegmentKind; rateCPerMin: number | null } {
  if (end - start < 2 || start < 0 || end > tempC.length || end > timeMin.length) {
    return { kind: "unknown", rateCPerMin: null };
  }
  const span = tempC[end - 1] - tempC[start];
  const duration = timeMin[end - 1] - timeMin[start];
  if (duration <= 0) return { kind: "unknown", rateCPerMin: null };
  if (Math.abs(span) < ISOTHERMAL_SPAN_C) return { kind: "isothermal", rateCPerMin: null };
  const kind: SegmentKind = span > 0 ? "heat" : "cool";
  const rateCPerMin = Math.round((Math.abs(span) / duration) * 100) / 100;
  return { kind, rateCPerMin };
}

/**
 * Fill `ordinal` (1-based, counted within segments of the same `kind`, in
 * order) and `cycle` (1-based heat/cool cycle) on an already-classified list
 * of segments. A cycle is one heat followed by one cool: the cycle counter
 * advances the next time a `"heat"` segment is seen after a `"cool"` has
 * already been seen in the current cycle — so `heat, cool, heat, cool` numbers
 * as cycles `1, 1, 2, 2`, and an isothermal hold in between does not itself
 * advance the cycle.
 */
export function numberSegments(segments: DscSegment[]): DscSegment[] {
  const kindCounts: Partial<Record<SegmentKind, number>> = {};
  let cycle = 1;
  let sawCoolInCycle = false;
  return segments.map((seg) => {
    if (seg.kind === "heat") {
      if (sawCoolInCycle) {
        cycle += 1;
        sawCoolInCycle = false;
      }
    } else if (seg.kind === "cool") {
      sawCoolInCycle = true;
    }
    const ordinal = (kindCounts[seg.kind] ?? 0) + 1;
    kindCounts[seg.kind] = ordinal;
    return { ...seg, ordinal, cycle };
  });
}

/**
 * The segment a freshly-imported run should show by default: the 2nd heat
 * (`kind === "heat" && ordinal === 2`) if present — TRIOS's first heat is
 * usually still settling from the initial equilibration — else the 1st heat,
 * else the first non-isothermal segment, else segment 0. Returns `null` for
 * an empty list.
 */
export function defaultSegmentId(segments: DscSegment[]): string | null {
  if (segments.length === 0) return null;
  const secondHeat = segments.find((s) => s.kind === "heat" && s.ordinal === 2);
  if (secondHeat) return secondHeat.id;
  const firstHeat = segments.find((s) => s.kind === "heat");
  if (firstHeat) return firstHeat.id;
  const firstNonIsothermal = segments.find((s) => s.kind !== "isothermal");
  if (firstNonIsothermal) return firstNonIsothermal.id;
  return segments[0].id;
}

/** One raw segment block: an index range into the run's arrays plus the
 *  label the parser resolved for it (from `proceduresegments`, a sheet name,
 *  or a positional fallback). */
export interface SegmentBlock {
  start: number;
  end: number;
  label: string;
}

/**
 * Build a run's full `DscSegment[]` from raw blocks: classify each block's
 * kind/rate, stamp its boundary temperatures/times, assign a stable id
 * (`${runId}:seg${i}`), then number ordinals and cycles. Shared by every
 * parser that discovers segments as index ranges over concatenated arrays.
 */
export function buildSegments(
  runId: string,
  tempC: Float64Array,
  timeMin: Float64Array,
  blocks: SegmentBlock[],
): DscSegment[] {
  const withoutNumbering: DscSegment[] = blocks.map((block, i) => {
    const { kind, rateCPerMin } = classifySegment(tempC, timeMin, block.start, block.end);
    const last = Math.max(block.start, block.end - 1);
    return {
      id: `${runId}:seg${i}`,
      label: block.label,
      kind,
      rateCPerMin,
      ordinal: 1, // filled by numberSegments below
      cycle: 1,
      start: block.start,
      end: block.end,
      tStartC: tempC[block.start] ?? NaN,
      tEndC: tempC[last] ?? NaN,
      timeStartMin: timeMin[block.start] ?? NaN,
      timeEndMin: timeMin[last] ?? NaN,
    };
  });
  return numberSegments(withoutNumbering);
}
