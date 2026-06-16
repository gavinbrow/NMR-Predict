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
});
