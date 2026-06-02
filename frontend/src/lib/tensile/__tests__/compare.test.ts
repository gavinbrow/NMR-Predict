import { describe, expect, it } from "vitest";
import {
  buildBars,
  buildCurves,
  buildDistribution,
  buildScatter,
  decimateCurve,
} from "../compare";
import { DEFAULT_PARAMS, extractRun } from "../compute";
import type { MaterialView, RawRun, Specimen } from "../types";

/** A rising-then-falling synthetic curve, enough to compute real properties. */
function rawRun(): RawRun {
  const strain: number[] = [];
  const stress: number[] = [];
  for (let i = 0; i <= 50; i += 1) {
    const e = (i / 50) * 5;
    strain.push(e);
    stress.push(40 * (e / 2) * Math.exp(1 - e / 2));
  }
  return { sheet: "S", label: "S", strainCol: 0, stressCol: 1, firstRow: 1, lastRow: 51, strain, stress, strainIsPercent: true };
}

function specimen(id: string, excluded = false): Specimen {
  const raw = rawRun();
  return {
    id,
    label: id,
    sheet: id,
    fileId: "f1",
    fileName: "f.xlsx",
    raw,
    excluded,
    props: extractRun(raw.strain, raw.stress, true, DEFAULT_PARAMS),
  };
}

function material(id: string, specimens: Specimen[]): MaterialView {
  const included = specimens.filter((s) => !s.excluded);
  return {
    id,
    name: id,
    specimenIds: specimens.map((s) => s.id),
    color: "#2563eb",
    specimens,
    includedSpecimens: included,
    // Minimal stats: only the keys the tests read.
    stats: {
      E_MPa: { mean: 10, sd: 2, cv: 20, n: included.length, min: 8, max: 12 },
      uts_MPa: { mean: 40, sd: 1, cv: 2.5, n: included.length, min: 39, max: 41 },
    },
  };
}

describe("decimateCurve", () => {
  it("keeps short curves intact and caps long ones at the first/last point", () => {
    expect(decimateCurve([0, 1, 2], [0, 5, 10])).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 5 },
      { x: 2, y: 10 },
    ]);
    const n = 5000;
    const s = Array.from({ length: n }, (_, i) => i);
    const out = decimateCurve(s, s);
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out[out.length - 1]).toEqual({ x: n - 1, y: n - 1 });
  });
});

describe("compare builders", () => {
  const sA = specimen("a1");
  const sB = specimen("a2", true); // excluded
  const mat = material("Mat A", [sA, sB]);

  it("buildCurves produces one series per specimen, colored and flagged", () => {
    const series = buildCurves([mat], [sA, sB], DEFAULT_PARAMS);
    expect(series).toHaveLength(2);
    expect(series[0].color).toBe("#2563eb");
    expect(series.find((c) => c.id === "a2")?.excluded).toBe(true);
    expect(series[0].data.length).toBeGreaterThan(2);
  });

  it("buildBars reports the material's stat for the chosen property", () => {
    const bars = buildBars([mat], "E_MPa");
    expect(bars).toHaveLength(1);
    expect(bars[0].mean).toBe(10);
    expect(bars[0].sd).toBe(2);
    // Only the included specimen contributes individual points.
    expect(bars[0].points).toHaveLength(1);
  });

  it("buildScatter emits one point per included specimen with finite x/y", () => {
    const pts = buildScatter([mat], "E_MPa", "uts_MPa");
    expect(pts).toHaveLength(1); // a2 is excluded
    expect(Number.isFinite(pts[0].x)).toBe(true);
    expect(Number.isFinite(pts[0].y)).toBe(true);
    expect(pts[0].materialName).toBe("Mat A");
  });

  it("buildDistribution summarizes included values per material", () => {
    const dist = buildDistribution([mat], "uts_MPa");
    expect(dist).toHaveLength(1);
    expect(dist[0].values).toHaveLength(1);
    expect(Number.isFinite(dist[0].mean)).toBe(true);
  });
});
