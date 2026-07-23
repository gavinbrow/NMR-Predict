import { describe, expect, it } from "vitest";
import { buildGcmsFigureData, buildGcmsStackedFigureData, type GcmsFigureSpectrum } from "../figure";
import type { ChromPeak, ChromTrace, MassSpectrum, SpecPeak } from "../types";

function trace(id: string, rt: number[], intensity: number[], color = "#111111"): ChromTrace {
  return {
    id,
    runId: "run1",
    kind: "TIC",
    label: id,
    rtMin: Float64Array.from(rt),
    intensity: Float64Array.from(intensity),
    color,
    visible: true,
    offset: 0,
    scale: 1,
  };
}

function spectrum(mz: number[], intensity: number[]): MassSpectrum {
  return {
    runId: "run1",
    mz: Float64Array.from(mz),
    intensity: Float64Array.from(intensity),
    label: "MS scan",
    rtLo: 1,
    rtHi: 1,
    scanCount: 1,
    basePeak: null,
  };
}

function specEntry(id: string, mzs: number[], ints: number[], color = "#0ea5e9"): GcmsFigureSpectrum {
  return { id, label: id, color, spectrum: spectrum(mzs, ints) };
}

function chromPeak(id: string, traceId: string, rtApex: number, height: number, name?: string): ChromPeak {
  return {
    id,
    runId: "run1",
    traceId,
    rtApex,
    rtStart: rtApex - 0.1,
    rtEnd: rtApex + 0.1,
    scanApex: 0,
    height,
    area: height * 0.2,
    areaPct: 100,
    basePeakMz: null,
    ...(name ? { name } : {}),
  };
}

function specPeak(id: string, mz: number, intensity: number): SpecPeak {
  return { id, mz, intensity, relPct: 100 };
}

describe("buildGcmsFigureData", () => {
  it("chromatogram subject: one line series per visible trace, with colour + labels", () => {
    const t1 = trace("t1", [1, 2, 3], [10, 20, 30], "#ff0000");
    const t2 = trace("t2", [1, 2, 3], [5, 15, 25], "#00ff00");
    const data = buildGcmsFigureData({
      subject: "chromatogram",
      traces: [t1, t2],
      spectra: [],
      chromPeaks: [],
      specPeaks: [],
      labelPeaks: false,
      sourceName: "run1",
    });
    expect(data.series).toHaveLength(2);
    expect(data.series.map((s) => s.id)).toEqual(["trace:t1", "trace:t2"]);
    expect(data.series[0].styleHints).toMatchObject({ kind: "line", color: "#ff0000" });
    expect(data.series[1].styleHints).toMatchObject({ kind: "line", color: "#00ff00" });
    expect(data.series[0].x).toEqual([1, 2, 3]);
    expect(data.series[0].y).toEqual([10, 20, 30]);
    expect(data.xLabel).toBe("Retention time (min)");
    expect(data.yLabel).toBe("Intensity");
    expect(data.sourceName).toBe("run1");
  });

  it("chromatogram subject: emits RT peak labels from chromPeaks, owned by their trace", () => {
    const t1 = trace("t1", [1, 2, 3], [10, 20, 30]);
    const peaks = [chromPeak("p1", "t1", 2, 20), chromPeak("p2", "t1", 1, 10, "Toluene")];
    const data = buildGcmsFigureData({
      subject: "chromatogram",
      traces: [t1],
      spectra: [],
      chromPeaks: peaks,
      specPeaks: [],
      labelPeaks: true,
    });
    expect(data.peakLabels).toHaveLength(2);
    const l1 = data.peakLabels!.find((l) => l.id === "p1")!;
    expect(l1).toMatchObject({ x: 2, y: 20, text: "2.000", seriesId: "trace:t1" });
    expect(l1.customText).toBeUndefined();
    const l2 = data.peakLabels!.find((l) => l.id === "p2")!;
    expect(l2).toMatchObject({ x: 1, y: 10, text: "Toluene", customText: true, seriesId: "trace:t1" });
  });

  it("spectrum subject: one sticks series per spectrum, with colour + m/z labels", () => {
    const s1 = specEntry("s1", [100, 200], [50, 80], "#123456");
    const peaks = [specPeak("sp1", 100, 50), specPeak("sp2", 200, 80)];
    const data = buildGcmsFigureData({
      subject: "spectrum",
      traces: [],
      spectra: [s1],
      chromPeaks: [],
      specPeaks: peaks,
      labelPeaks: true,
    });
    expect(data.series).toHaveLength(1);
    expect(data.series[0]).toMatchObject({ id: "sticks:s1", x: [100, 200], y: [50, 80] });
    expect(data.series[0].styleHints).toMatchObject({ kind: "sticks", color: "#123456" });
    expect(data.xLabel).toBe("m/z");
    expect(data.peakLabels).toHaveLength(2);
    expect(data.peakLabels?.[0]).toMatchObject({ id: "sp1", x: 100, y: 50, text: "100.00", seriesId: "sticks:s1" });
  });

  it("labels every comparison spectrum and preserves stacked baselines", () => {
    const s1 = {
      ...specEntry("s1", [100], [100], "#123456"),
      peaks: [specPeak("sp1", 100, 100)],
      baseline: 0,
    };
    const s2 = {
      ...specEntry("s2", [120], [160], "#654321"),
      peaks: [specPeak("sp2", 120, 160)],
      baseline: 110,
    };
    const data = buildGcmsFigureData({
      subject: "spectrum",
      traces: [],
      spectra: [s1, s2],
      chromPeaks: [],
      specPeaks: [],
      labelPeaks: true,
    });
    expect(data.series[1].baseline).toBe(110);
    expect(data.peakLabels).toEqual([
      expect.objectContaining({ id: "sp1", seriesId: "sticks:s1" }),
      expect.objectContaining({ id: "sp2", seriesId: "sticks:s2" }),
    ]);
  });

  it("applies per-trace scale + offset to the line series AND its peak labels (WYSIWYG)", () => {
    const t1 = trace("t1", [1, 2, 3], [10, 20, 30]);
    t1.scale = 2;
    t1.offset = 5;
    const data = buildGcmsFigureData({
      subject: "chromatogram",
      traces: [t1],
      spectra: [],
      chromPeaks: [chromPeak("p1", "t1", 2, 20)],
      specPeaks: [],
      labelPeaks: true,
    });
    // y = intensity * scale + offset
    expect(data.series[0].y).toEqual([25, 45, 65]);
    // The label rides the transformed curve: 20 * 2 + 5 = 45.
    expect(data.peakLabels!.find((l) => l.id === "p1")!.y).toBe(45);
  });

  it("treats a non-positive or non-finite scale as 1 and a missing offset as 0", () => {
    const t1 = trace("t1", [1, 2, 3], [10, 20, 30]);
    // A degenerate scale must not blank the curve.
    t1.scale = 0;
    (t1 as { offset?: number }).offset = undefined;
    const data = buildGcmsFigureData({
      subject: "chromatogram",
      traces: [t1],
      spectra: [],
      chromPeaks: [],
      specPeaks: [],
      labelPeaks: false,
    });
    expect(data.series[0].y).toEqual([10, 20, 30]);
  });

  it("both subject: includes chromatogram AND spectrum series together", () => {
    const t1 = trace("t1", [1, 2, 3], [10, 20, 30]);
    const s1 = specEntry("s1", [100, 200], [50, 80]);
    const data = buildGcmsFigureData({
      subject: "both",
      traces: [t1],
      spectra: [s1],
      chromPeaks: [chromPeak("p1", "t1", 2, 20)],
      specPeaks: [specPeak("sp1", 100, 50)],
      labelPeaks: true,
    });
    expect(data.series.map((s) => s.id)).toEqual(["trace:t1", "sticks:s1"]);
    expect(data.peakLabels?.map((l) => l.id).sort()).toEqual(["p1", "sp1"]);
    expect(data.xLabel).toContain("Retention time");
    expect(data.xLabel).toContain("m/z");
  });

  it("labelPeaks:false yields no peak labels even when peaks are supplied", () => {
    const t1 = trace("t1", [1, 2, 3], [10, 20, 30]);
    const data = buildGcmsFigureData({
      subject: "chromatogram",
      traces: [t1],
      spectra: [],
      chromPeaks: [chromPeak("p1", "t1", 2, 20)],
      specPeaks: [],
      labelPeaks: false,
    });
    expect(data.peakLabels).toEqual([]);
  });

  it("empty input does not throw, for every subject", () => {
    for (const subject of ["chromatogram", "spectrum", "both"] as const) {
      const data = buildGcmsFigureData({
        subject,
        traces: [],
        spectra: [],
        chromPeaks: [],
        specPeaks: [],
        labelPeaks: true,
      });
      expect(data.series).toEqual([]);
      expect(data.peakLabels).toEqual([]);
      expect(data.x).toEqual([]);
    }
  });

  it("falls back to a 'gcms' download stem when the name is blank", () => {
    const data = buildGcmsFigureData({
      subject: "chromatogram",
      traces: [],
      spectra: [],
      chromPeaks: [],
      specPeaks: [],
      labelPeaks: false,
      sourceName: "",
    });
    expect(data.sourceName).toBe("gcms");
  });

  it("downsamples long chromatogram traces (min/max envelope) to keep the SVG small", () => {
    const n = 5000;
    const rt = Array.from({ length: n }, (_, i) => i * 0.01);
    const intensity = Array.from({ length: n }, (_, i) => (i % 50 === 25 ? 1000 : 10));
    const t1 = trace("t1", rt, intensity);
    const data = buildGcmsFigureData({
      subject: "chromatogram",
      traces: [t1],
      spectra: [],
      chromPeaks: [],
      specPeaks: [],
      labelPeaks: false,
      maxTracePoints: 500,
    });
    const s0 = data.series[0]!;
    const sx = s0.x ?? [];
    expect(sx.length).toBeLessThan(n);
    expect(sx.length).toBeGreaterThan(0);
    // The narrow spikes must survive decimation (min/max bucketing).
    expect(Math.max(...s0.y)).toBe(1000);
  });

  it("keeps a real m/z axis in the combined stacked figure", () => {
    const t1 = trace("t1", [5, 6], [10, 20]);
    const spectrumEntry = specEntry("s1", [50, 100, 200], [10, 100, 20]);
    const data = buildGcmsStackedFigureData({
      traces: [t1],
      spectra: [spectrumEntry],
      chromPeaks: [chromPeak("cp", "t1", 5.5, 20)],
      specPeaks: [{ id: "sp", mz: 100, intensity: 100, relPct: 100 }],
      labelPeaks: true,
    });

    expect(data.x).toEqual([50, 200]);
    expect(data.series.find((series) => series.id === "sticks:s1")?.x).toEqual([50, 100, 200]);
    expect(data.xLabel).toContain("m/z");
    expect(data.peakLabels?.find((peak) => peak.id === "cp")).toMatchObject({
      text: "5.500",
      customText: true,
    });
    expect(data.peakLabels?.find((peak) => peak.id === "sp")).toMatchObject({
      x: 100,
      text: "100.00",
    });
  });
});
