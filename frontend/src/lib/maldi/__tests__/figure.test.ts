import { describe, expect, it } from "vitest";
import { buildMaldiFigureData, type MaldiFigureSpectrum } from "../figure";
import type { Peak, SpectrumData } from "../types";

function spectrum(mz: number[], intensity: number[]): SpectrumData {
  return { mz: Float64Array.from(mz), intensity: Float64Array.from(intensity) };
}

function primary(): MaldiFigureSpectrum {
  return { id: "active", name: "sample A", spectrum: spectrum([100, 200, 300], [10, 20, 30]) };
}

function peak(id: string, mz: number, intensity: number, extra: Partial<Peak> = {}): Peak {
  return { id, mz, intensity, ...extra };
}

describe("buildMaldiFigureData", () => {
  it("emits a profile line series on the spectrum's own m/z grid", () => {
    const data = buildMaldiFigureData({
      spectra: [primary()],
      peaks: [],
      showProfile: true,
      showSticks: false,
      labelPeaks: false,
      sourceName: "sample A",
    });
    expect(data.series).toHaveLength(1);
    const profile = data.series[0];
    expect(profile.id).toBe("profile:active");
    expect(profile.x).toEqual([100, 200, 300]);
    expect(profile.y).toEqual([10, 20, 30]);
    expect(profile.styleHints?.kind).toBe("line");
    expect(data.xLabel).toBe("m/z");
    expect(data.yLabel).toBe("Intensity");
    expect(data.reversedX).toBe(false);
  });

  it("adds a stick series and m/z labels from the peaks (centroid preferred)", () => {
    const peaks = [peak("p1", 150, 5, { centroid: 150.05 }), peak("p2", 250, 8)];
    const data = buildMaldiFigureData({
      spectra: [primary()],
      peaks,
      showProfile: true,
      showSticks: true,
      labelPeaks: true,
      sourceName: "sample A",
    });
    const sticks = data.series.find((s) => s.id === "sticks");
    expect(sticks).toBeDefined();
    expect(sticks?.styleHints?.kind).toBe("sticks");
    expect(sticks?.x).toEqual([150.05, 250]); // centroid used when present
    expect(sticks?.y).toEqual([5, 8]);

    expect(data.peakLabels).toHaveLength(2);
    expect(data.peakLabels?.[0]).toMatchObject({ id: "p1", x: 150.05, y: 5, text: "150.05" });
    expect(data.peakLabels?.[1]).toMatchObject({ id: "p2", x: 250, y: 8, text: "250.00" });
  });

  it("omits the profile and/or sticks when their flags are off", () => {
    const data = buildMaldiFigureData({
      spectra: [primary()],
      peaks: [peak("p1", 150, 5)],
      showProfile: false,
      showSticks: false,
      labelPeaks: false,
      sourceName: "sample A",
    });
    expect(data.series).toHaveLength(0);
    expect(data.peakLabels).toEqual([]);
  });

  it("always supplies peakLabels (possibly empty) so the labels controls appear", () => {
    const data = buildMaldiFigureData({
      spectra: [primary()],
      peaks: [],
      showProfile: true,
      showSticks: false,
      labelPeaks: true,
      sourceName: "sample A",
    });
    expect(data.peakLabels).toEqual([]);
    expect(data.peakLabels).not.toBeUndefined();
  });

  it("overlays extra spectra as their own line series, primary first", () => {
    const other: MaldiFigureSpectrum = {
      id: "doc2",
      name: "sample B",
      spectrum: spectrum([100, 400], [1, 2]),
    };
    const data = buildMaldiFigureData({
      spectra: [primary(), other],
      peaks: [],
      showProfile: true,
      showSticks: false,
      labelPeaks: false,
      sourceName: "sample A",
    });
    expect(data.series.map((s) => s.id)).toEqual(["profile:active", "profile:doc2"]);
    // The primary gets the dark trace hint; overlays fall back to the palette.
    expect(data.series[0].styleHints?.color).toBeDefined();
    expect(data.series[1].styleHints?.color).toBeUndefined();
    // The shared x grid is the primary's m/z.
    expect(data.x).toEqual([100, 200, 300]);
  });

  it("falls back to a 'maldi' download stem when the name is blank", () => {
    const data = buildMaldiFigureData({
      spectra: [primary()],
      peaks: [],
      showProfile: true,
      showSticks: false,
      labelPeaks: false,
      sourceName: "",
    });
    expect(data.sourceName).toBe("maldi");
  });

  it("emits one stick series per group with stable ids + ladder colours, and no unassigned when every peak is grouped", () => {
    const peaks = [peak("p1", 100, 10), peak("p2", 200, 20), peak("p3", 300, 30)];
    const data = buildMaldiFigureData({
      spectra: [primary()],
      peaks,
      showProfile: false,
      showSticks: true,
      labelPeaks: true,
      sourceName: "x",
      seriesGroups: [
        { id: "sA", label: "[M+H]+", color: "#111111", peakIds: new Set(["p1", "p2"]) },
        { id: "sB", label: "[M+Na]+", color: "#222222", peakIds: new Set(["p3"]) },
      ],
    });
    const stickA = data.series.find((s) => s.id === "sticks:sA");
    const stickB = data.series.find((s) => s.id === "sticks:sB");
    expect(stickA?.styleHints).toMatchObject({ kind: "sticks", color: "#111111" });
    expect(stickA?.x).toEqual([100, 200]);
    expect(stickB?.styleHints?.color).toBe("#222222");
    expect(stickB?.x).toEqual([300]);
    // Every peak belongs to a group → no unassigned bucket.
    expect(data.series.find((s) => s.id === "sticks:unassigned")).toBeUndefined();
    // Labels carry the owning group's series id (drives "colour labels by series").
    expect(data.peakLabels?.find((l) => l.id === "p1")?.seriesId).toBe("sticks:sA");
    expect(data.peakLabels?.find((l) => l.id === "p3")?.seriesId).toBe("sticks:sB");
  });

  it("claims a peak shared by two groups for the first in array order, and buckets ungrouped peaks as 'sticks:unassigned'", () => {
    const peaks = [peak("shared", 100, 10), peak("only", 200, 20), peak("loose", 300, 30)];
    const data = buildMaldiFigureData({
      spectra: [primary()],
      peaks,
      showProfile: false,
      showSticks: true,
      labelPeaks: true,
      sourceName: "x",
      // Caller passes groups in precedence order (confirmed first, then score);
      // "shared" is in both, so the first group (sA) claims it.
      seriesGroups: [
        { id: "sA", label: "A", color: "#aaaaaa", peakIds: new Set(["shared", "only"]) },
        { id: "sB", label: "B", color: "#bbbbbb", peakIds: new Set(["shared"]) },
      ],
    });
    expect(data.series.find((s) => s.id === "sticks:sA")?.x).toEqual([100, 200]);
    // sB's only member was claimed by sA → empty group → no series emitted.
    expect(data.series.find((s) => s.id === "sticks:sB")).toBeUndefined();
    expect(data.peakLabels?.find((l) => l.id === "shared")?.seriesId).toBe("sticks:sA");
    // "loose" is in no group → unassigned sticks, and its label has no seriesId.
    expect(data.series.find((s) => s.id === "sticks:unassigned")?.x).toEqual([300]);
    expect(data.peakLabels?.find((l) => l.id === "loose")?.seriesId).toBeUndefined();
  });

  it("passes Peak.color / Peak.label straight through to the labels", () => {
    const peaks = [peak("p1", 150, 5, { color: "#ff0000", label: "M+H" }), peak("p2", 250, 8)];
    const data = buildMaldiFigureData({
      spectra: [primary()],
      peaks,
      showProfile: false,
      showSticks: false,
      labelPeaks: true,
      sourceName: "x",
    });
    // A user label wins verbatim and is marked custom so Decimals can't reformat it.
    expect(data.peakLabels?.find((l) => l.id === "p1")).toMatchObject({
      text: "M+H",
      customText: true,
      color: "#ff0000",
    });
    // No label/colour → m/z fallback, and neither flag is set.
    const l2 = data.peakLabels?.find((l) => l.id === "p2");
    expect(l2?.text).toBe("250.00");
    expect(l2?.customText).toBeUndefined();
    expect(l2?.color).toBeUndefined();
  });

  it("splits sticks by Peak.color so an individually-coloured peak keeps its colour", () => {
    // The shared renderer strokes a whole stick series one colour, so a coloured
    // peak must live in its own series. The uncoloured peaks stay in "sticks".
    const peaks = [peak("p1", 150, 5, { color: "#ff0000" }), peak("p2", 250, 8)];
    const data = buildMaldiFigureData({
      spectra: [primary()],
      peaks,
      showProfile: false,
      showSticks: true,
      labelPeaks: false,
      sourceName: "x",
    });
    const red = data.series.find((s) => s.styleHints?.color === "#ff0000");
    expect(red?.x).toEqual([150]);
    expect(data.series.find((s) => s.id === "sticks")?.x).toEqual([250]);
  });

  it("emits the base colour first and keeps the colour split out of the legend", () => {
    // The recoloured peak comes FIRST in the list, so only an explicit ordering
    // puts the ladder's own series ahead of its one-off colour split.
    const peaks = [peak("p1", 150, 5, { color: "#ff0000" }), peak("p2", 250, 8)];
    const data = buildMaldiFigureData({
      spectra: [primary()],
      peaks,
      showProfile: false,
      showSticks: true,
      labelPeaks: false,
      sourceName: "x",
      seriesGroups: [{ id: "sA", label: "ladder A", color: "#111111", peakIds: new Set(["p1", "p2"]) }],
    });
    expect(data.series.map((s) => s.id)).toEqual(["sticks:sA", "sticks:sA:c:#ff0000"]);
    // Only the ladder keys the legend; the split would just repeat its name.
    expect(data.series[0].legendHidden).toBeUndefined();
    expect(data.series[1].legendHidden).toBe(true);
  });
});
