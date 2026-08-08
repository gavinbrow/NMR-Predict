import { describe, expect, it } from "vitest";
import { BUILTIN_ADDUCTS } from "../adducts";
import { interpretSpectrum } from "../interpret";
import type { Peak, Series } from "../types";

/** PEG and PMMA — two library repeat units far enough apart to tell apart. */
const PEG = 44.026215;
const PMMA = 100.05243;

function peaks(n: number): Peak[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    mz: 500 + i * PEG,
    intensity: 100 - i,
    accepted: true,
  }));
}

function series(id: string, repeatMass: number, memberIds: string[]): Series {
  return {
    id,
    repeatMass,
    endGroupMass: 18.0106,
    adductId: "Na",
    members: memberIds.map((peakId, i) => ({ peakId, n: i + 5 })),
    score: 0.8,
    meanErrorDa: 0.004,
    endGroupLocked: true,
  };
}

const text = (findings: { text: string }[]) => findings.map((f) => f.text).join("\n");

describe("interpretSpectrum — repeat units", () => {
  it("looks up every repeat unit in play, not just the dominant spacing", () => {
    const findings = interpretSpectrum({
      peaks: peaks(8),
      series: [series("s1", PEG, ["p0", "p1", "p2"]), series("s2", PMMA, ["p3", "p4"])],
      adducts: BUILTIN_ADDUCTS,
      repeatMasses: [PEG, PMMA],
    });
    const all = text(findings);
    expect(all).toContain("Repeat unit 1 of 2");
    expect(all).toContain("Repeat unit 2 of 2");
    // Both are named from the library — the whole point of the two-polymer case.
    expect(all).toContain("Ethylene oxide (PEG/PEO)");
    expect(all).toContain("Methyl methacrylate (PMMA)");
    expect(all).toContain("2 repeat units are in play");
  });

  it("counts each repeat unit's own series and peaks", () => {
    const findings = interpretSpectrum({
      peaks: peaks(8),
      series: [series("s1", PEG, ["p0", "p1", "p2"]), series("s2", PMMA, ["p3", "p4"])],
      adducts: BUILTIN_ADDUCTS,
      repeatMasses: [PEG, PMMA],
    });
    const peg = findings.find((f) => f.text.includes("Ethylene oxide"))!.text;
    const pmma = findings.find((f) => f.text.includes("Methyl methacrylate"))!.text;
    expect(peg).toContain("1 assigned series, 3 peaks");
    expect(pmma).toContain("1 assigned series, 2 peaks");
  });

  it("does not count a superseded adduct reading as another series", () => {
    // The same ladder read as [M+K]+ once [M+Na]+ was confirmed — one polymer,
    // not two, which is what every other view shows.
    const confirmed = series("s1", PEG, ["p0", "p1", "p2"]);
    const shadow = { ...series("s1k", PEG, ["p0", "p1", "p2"]), adductId: "K", supersededBy: "s1" };
    const findings = interpretSpectrum({
      peaks: peaks(4),
      series: [confirmed, shadow],
      adducts: BUILTIN_ADDUCTS,
      repeatMasses: [PEG],
    });
    expect(findings.find((f) => f.text.includes("Ethylene oxide"))!.text).toContain(
      "1 assigned series, 3 peaks",
    );
  });

  it("says so when a selected repeat unit has no series and no library match", () => {
    const findings = interpretSpectrum({
      peaks: peaks(4),
      series: [],
      adducts: BUILTIN_ADDUCTS,
      repeatMasses: [77.7],
    });
    const line = findings.find((f) => f.text.includes("77.700"))!;
    expect(line.text).toContain("no library match");
    expect(line.text).toContain("no series assigned to it yet");
    // One repeat unit gets no "N of M" counter.
    expect(line.text).toContain("Repeat unit ≈");
  });

  it("falls back to the detected spacing while nothing is selected", () => {
    const findings = interpretSpectrum({
      peaks: peaks(6),
      series: [],
      adducts: BUILTIN_ADDUCTS,
      repeatCandidates: [{ repeatMass: PEG, score: 0.9, count: 5 }],
    });
    const all = text(findings);
    expect(all).toContain("Dominant repeat spacing");
    expect(all).toContain("Ethylene oxide (PEG/PEO)");
    expect(all).not.toContain("Repeat unit");
  });

  it("warns when neither a selection nor a detected spacing exists", () => {
    const findings = interpretSpectrum({
      peaks: peaks(3),
      series: [],
      adducts: BUILTIN_ADDUCTS,
      repeatMasses: [0],
    });
    expect(text(findings)).toContain("No clear repeating spacing detected");
  });
});
