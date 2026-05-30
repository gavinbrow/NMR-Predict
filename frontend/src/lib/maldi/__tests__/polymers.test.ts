import { describe, expect, it } from "vitest";
import { BUILTIN_ADDUCTS } from "../adducts";
import { assignSeries, detectRepeatUnits, peaksForRepeat, seriesForRepeat } from "../polymers";
import type { Peak } from "../types";
import { pickPegPeaks, PEG_REPEAT } from "./fixtures";

const pegPeaks = pickPegPeaks;

describe("detectRepeatUnits", () => {
  it("identifies the ~44 Da ethylene-oxide repeat as the top candidate", () => {
    const { peaks } = pegPeaks();
    const candidates = detectRepeatUnits(peaks);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].repeatMass).toBeCloseTo(PEG_REPEAT, 1);
    expect(candidates[0].score).toBe(1); // normalized top score
  });
});

describe("peaksForRepeat", () => {
  it("highlights the oligomer peaks spaced by the repeat unit", () => {
    const { peaks } = pegPeaks();
    const ids = peaksForRepeat(peaks, PEG_REPEAT);
    // The PEG ladder is long, so most analyzable peaks have a ±repeat neighbour.
    expect(ids.size).toBeGreaterThanOrEqual(10);
    const na = BUILTIN_ADDUCTS.find((a) => a.id === "Na")!;
    const seriesIds = new Set(assignSeries(peaks, PEG_REPEAT, [na])[0].members.map((m) => m.peakId));
    // Every assigned-series member is part of the highlighted preview set.
    for (const id of seriesIds) expect(ids.has(id)).toBe(true);
  });

  it("returns nothing for a repeat unit absent from the spectrum", () => {
    const { peaks } = pegPeaks();
    expect(peaksForRepeat(peaks, 13.37).size).toBe(0);
  });
});

describe("seriesForRepeat", () => {
  it("groups the PEG ladder into a single distinct series", () => {
    const { peaks } = pegPeaks();
    const groups = seriesForRepeat(peaks, PEG_REPEAT);
    // The fixture is one +Na ladder, so one connected ladder is expected.
    expect(groups.length).toBe(1);
    expect(groups[0].peakIds.length).toBeGreaterThanOrEqual(10);

    // Every grouped peak is part of the lumped ±repeat preview set.
    const preview = peaksForRepeat(peaks, PEG_REPEAT);
    for (const id of groups[0].peakIds) expect(preview.has(id)).toBe(true);

    // The ladder's offset is the H2O end group modulo the repeat (PEG is +Na).
    const na = BUILTIN_ADDUCTS.find((a) => a.id === "Na")!;
    const naSeries = assignSeries(peaks, PEG_REPEAT, [na])[0];
    for (const m of naSeries.members) expect(groups[0].peakIds).toContain(m.peakId);
  });

  it("separates interleaved ladders that share a repeat but differ in offset", () => {
    // Two clean ladders with the same ~44 Da repeat but well-separated offsets
    // (15.7 Da apart, clear of any k·repeat) — e.g. two different end groups.
    const mk = (id: string, mz: number): Peak => ({ id, mz, intensity: 1000, accepted: true });
    const a = Array.from({ length: 8 }, (_, n) => mk(`a-${n}`, 1000 + n * PEG_REPEAT));
    const b = Array.from({ length: 8 }, (_, n) => mk(`b-${n}`, 1015.7 + n * PEG_REPEAT));
    const groups = seriesForRepeat([...a, ...b], PEG_REPEAT);

    expect(groups.length).toBe(2);
    expect(groups.map((g) => g.peakIds.length).sort()).toEqual([8, 8]);
    // Each ladder stays pure — never mixing the two id spaces.
    for (const g of groups) {
      const fromB = g.peakIds.filter((id) => id.startsWith("b-")).length;
      expect(fromB === 0 || fromB === g.peakIds.length).toBe(true);
    }
  });

  it("returns nothing for a repeat unit absent from the spectrum", () => {
    const { peaks } = pegPeaks();
    expect(seriesForRepeat(peaks, 13.37)).toEqual([]);
  });
});

describe("assignSeries", () => {
  it("builds a consecutive Na series with the correct end group and low error", () => {
    const { peaks } = pegPeaks();
    const na = BUILTIN_ADDUCTS.find((a) => a.id === "Na")!;
    const series = assignSeries(peaks, PEG_REPEAT, [na]);
    expect(series.length).toBeGreaterThanOrEqual(1);

    const best = series[0];
    expect(best.adductId).toBe("Na");
    expect(best.members.length).toBeGreaterThanOrEqual(10);
    expect(best.meanErrorDa).toBeLessThan(0.3);
    // PEG H/OH end groups → residual ≈ H2O (18.0106) modulo the repeat.
    expect(best.endGroupMass).toBeCloseTo(18.0106, 1);
    // A long, unbroken oligomer run is the strongest evidence.
    expect(best.score).toBeGreaterThan(0.5);
  });

  it("returns a separate series for each candidate adduct (overlapping series)", () => {
    const { peaks } = pegPeaks();
    const subset = BUILTIN_ADDUCTS.filter((a) => ["H", "Na", "K"].includes(a.id));
    const series = assignSeries(peaks, PEG_REPEAT, subset);
    const adductIds = new Set(series.map((s) => s.adductId));
    expect(adductIds.size).toBeGreaterThanOrEqual(2);
  });

  it("returns nothing for an implausible repeat with no consecutive run", () => {
    const { peaks } = pegPeaks();
    const series = assignSeries(peaks, 13.37, BUILTIN_ADDUCTS, { minConsecutive: 5 });
    expect(series.length).toBe(0);
  });
});
