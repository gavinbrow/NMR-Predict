import { describe, expect, it } from "vitest";
import {
  comparisonFingerprint,
  comparisonSimilarities,
  comparisonSpectrumLabel,
  comparisonXDomain,
  normalizeComparisonSpectrum,
} from "../comparison";
import type { ComparisonSpectrumItem, MassSpectrum } from "../types";

function spectrum(
  runId: string,
  rtLo: number,
  rtHi: number,
  mz: number[],
  intensity: number[],
): MassSpectrum {
  return {
    runId,
    mz: new Float64Array(mz),
    intensity: new Float64Array(intensity),
    label: "test",
    rtLo,
    rtHi,
    scanCount: rtLo === rtHi ? 1 : 10,
    basePeak: null,
  };
}

function item(id: string, spec: MassSpectrum): ComparisonSpectrumItem {
  return {
    id,
    documentId: `doc-${id}`,
    documentName: `Sample ${id}`,
    sourceSlotId: "sel",
    label: id,
    color: "#000000",
    spectrum: spec,
    peaks: [],
  };
}

describe("comparison helpers", () => {
  it("labels scans and ranges with their source document", () => {
    expect(comparisonSpectrumLabel("Sample A", spectrum("a", 5, 6, [50], [1]))).toBe(
      "Sample A — 5.00–6.00 min",
    );
    expect(comparisonSpectrumLabel("Sample B", spectrum("b", 7.125, 7.125, [50], [1]))).toBe(
      "Sample B — 7.125 min",
    );
  });

  it("uses document and resolved RT bounds for duplicate detection", () => {
    const spec = spectrum("a", 5, 6, [50], [1]);
    expect(comparisonFingerprint("doc-a", spec)).toBe("doc-a:5.000000:6.000000:10");
    expect(comparisonFingerprint("doc-b", spec)).not.toBe(comparisonFingerprint("doc-a", spec));
  });

  it("finds a shared m/z domain across saved spectra", () => {
    const items = [
      item("a", spectrum("a", 5, 6, [45, 100], [1, 2])),
      item("b", spectrum("b", 7, 8, [60, 550], [3, 4])),
    ];
    expect(comparisonXDomain(items)).toEqual([45, 550]);
    expect(comparisonXDomain([])).toBeUndefined();
  });

  it("returns every pairwise cosine similarity", () => {
    const items = [
      item("a", spectrum("a", 5, 6, [50, 100], [1, 2])),
      item("b", spectrum("b", 7, 8, [50, 100], [2, 4])),
      item("c", spectrum("c", 9, 10, [75], [1])),
    ];
    const scores = comparisonSimilarities(items, 0.1);
    expect(scores).toHaveLength(3);
    expect(scores[0]).toMatchObject({ aId: "a", bId: "b" });
    expect(scores[0].score).toBeCloseTo(1);
    expect(scores[1].score).toBe(0);
  });

  it("normalizes a saved spectrum without mutating its snapshot", () => {
    const original = spectrum("a", 5, 6, [50, 100], [2, 8]);
    const normalized = normalizeComparisonSpectrum(original);
    expect(Array.from(normalized.intensity)).toEqual([25, 100]);
    expect(Array.from(original.intensity)).toEqual([2, 8]);
  });
});
