// Unit tests for the TGA figure adapter (`buildTgaFigureData`). Pure data
// shaping — no DOM. Verifies the series ids, the axis hints, the marker
// series' `legendHidden`, and the peak labels' `customText`.

import { describe, expect, it } from "vitest";
import { buildTgaFigureData } from "../figure";
import { computeAnalysis } from "../compute";
import { DEFAULT_PARAMS, type TgaMetadata, type TgaSegment } from "../types";
import type { TgaRunAnalyzed } from "../store";

function makeRun(id: string, color: string): TgaRunAnalyzed {
  // A simple single-step ramp: 100% → 60% from 100→300°C.
  const n = 201;
  const tempC = new Float64Array(n);
  const weightMg = new Float64Array(n);
  const timeMin = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    tempC[i] = 100 + t * 200;
    weightMg[i] = 10 * (1 - 0.4 * t); // 10 mg → 6 mg
    timeMin[i] = t * 20;
  }
  const meta: TgaMetadata = {
    instrument: "TA Q50",
    operator: "",
    sampleName: id,
    sampleSizeMg: 10,
    pan: "",
    methodSteps: ["Ramp 10 °C/min to 300 °C"],
    runDate: "",
    gases: "",
  };
  const segments: TgaSegment[] = [{ label: "Ramp" }];
  const analysis = computeAnalysis(weightMg, tempC, timeMin, DEFAULT_PARAMS, { sampleSizeMg: 10 });
  return {
    id,
    fileId: `file-${id}`,
    fileName: `${id}.txt`,
    label: id,
    color,
    meta,
    segments,
    timeMin,
    tempC,
    weightMg,
    scale: 1,
    offset: 0,
    visible: true,
    materialId: null,
    analysis,
  };
}

describe("buildTgaFigureData", () => {
  it("emits one TGA line series per visible run on the left axis", () => {
    const run = makeRun("A", "#2563eb");
    const data = buildTgaFigureData({
      runs: [run],
      xAxis: "temperature",
      yAxis: "weightPct",
      showDtg: false,
      labelMarkers: false,
      stackRuns: false,
      markers: { onset: false, endset: false, td: false, tmax: false, residue: false, stepShade: false },
    });
    const tgaSeries = data.series.filter((s) => s.id === "tga:A");
    expect(tgaSeries).toHaveLength(1);
    expect(tgaSeries[0].styleHints?.axis).toBe("y");
    expect(tgaSeries[0].styleHints?.kind).toBe("line");
    expect(tgaSeries[0].styleHints?.color).toBe("#2563eb");
    expect(tgaSeries[0].group).toBe("A");
  });

  it("emits a DTG line series on the y2 axis when showDtg is true", () => {
    const run = makeRun("A", "#2563eb");
    const data = buildTgaFigureData({
      runs: [run],
      xAxis: "temperature",
      yAxis: "weightPct",
      showDtg: true,
      labelMarkers: false,
      stackRuns: false,
      markers: { onset: false, endset: false, td: false, tmax: false, residue: false, stepShade: false },
    });
    const dtgSeries = data.series.filter((s) => s.id === "dtg:A");
    expect(dtgSeries).toHaveLength(1);
    expect(dtgSeries[0].styleHints?.axis).toBe("y2");
    expect(dtgSeries[0].styleHints?.lineStyle).toBe("dashed");
    expect(dtgSeries[0].legendHidden).toBe(true);
    expect(data.y2Label).toBe("Deriv. weight (%/°C)");
  });

  it("omits y2Label when showDtg is false", () => {
    const run = makeRun("A", "#2563eb");
    const data = buildTgaFigureData({
      runs: [run],
      xAxis: "temperature",
      yAxis: "weightPct",
      showDtg: false,
      labelMarkers: false,
      stackRuns: false,
      markers: { onset: false, endset: false, td: false, tmax: false, residue: false, stepShade: false },
    });
    expect(data.y2Label).toBeUndefined();
  });

  it("marker series are legendHidden and grouped under 'Analysis markers'", () => {
    const run = makeRun("A", "#2563eb");
    const data = buildTgaFigureData({
      runs: [run],
      xAxis: "temperature",
      yAxis: "weightPct",
      showDtg: false,
      labelMarkers: false,
      stackRuns: false,
      markers: { onset: true, endset: true, td: true, tmax: true, residue: true, stepShade: false },
    });
    const markerSeries = data.series.filter((s) => s.group === "Analysis markers");
    expect(markerSeries.length).toBeGreaterThan(0);
    for (const s of markerSeries) {
      expect(s.legendHidden).toBe(true);
    }
  });

  it("peak labels are customText and carry the owning run's series id", () => {
    const run = makeRun("A", "#2563eb");
    const data = buildTgaFigureData({
      runs: [run],
      xAxis: "temperature",
      yAxis: "weightPct",
      showDtg: false,
      labelMarkers: true,
      stackRuns: false,
      markers: { onset: true, endset: false, td: true, tmax: true, residue: true, stepShade: false },
    });
    const labels = data.peakLabels ?? [];
    expect(labels.length).toBeGreaterThan(0);
    for (const p of labels) {
      expect(p.customText).toBe(true);
      expect(p.seriesId).toBe("tga:A");
      expect(p.color).toBe("#2563eb");
    }
  });

  it("always supplies peakLabels (possibly empty) so the maker's section appears", () => {
    const run = makeRun("A", "#2563eb");
    const data = buildTgaFigureData({
      runs: [run],
      xAxis: "temperature",
      yAxis: "weightPct",
      showDtg: false,
      labelMarkers: false,
      stackRuns: false,
      markers: { onset: false, endset: false, td: false, tmax: false, residue: false, stepShade: false },
    });
    expect(Array.isArray(data.peakLabels)).toBe(true);
  });

  it("xLabel/yLabel follow the mode toggles", () => {
    const run = makeRun("A", "#2563eb");
    const d1 = buildTgaFigureData({
      runs: [run], xAxis: "temperature", yAxis: "weightPct", showDtg: false, labelMarkers: false, stackRuns: false,
      markers: { onset: false, endset: false, td: false, tmax: false, residue: false, stepShade: false },
    });
    expect(d1.xLabel).toBe("Temperature (°C)");
    expect(d1.yLabel).toBe("Weight (%)");
    const d2 = buildTgaFigureData({
      runs: [run], xAxis: "time", yAxis: "weightMg", showDtg: false, labelMarkers: false, stackRuns: false,
      markers: { onset: false, endset: false, td: false, tmax: false, residue: false, stepShade: false },
    });
    expect(d2.xLabel).toBe("Time (min)");
    expect(d2.yLabel).toBe("Weight (mg)");
  });

  it("anchors every vertical marker on the run's own curve, not on 0-100", () => {
    // The marker geometry is the whole point of the callouts: a line that ran
    // 0 -> 100 regardless of the y-unit pointed at nothing once the axis was mg
    // (or once runs were stacked). Each vertical must now span from the run's
    // floor up to the curve AT that temperature.
    const run = makeRun("A", "#2563eb");
    const data = buildTgaFigureData({
      runs: [run],
      xAxis: "temperature",
      yAxis: "weightMg",
      showDtg: false,
      labelMarkers: true,
      stackRuns: false,
      markers: { onset: true, endset: false, td: true, tmax: true, residue: false, stepShade: false },
    });
    const curve = data.series.find((s) => s.id === "tga:A")!;
    const runMin = Math.min(...curve.y.filter(Number.isFinite));
    const verticals = data.series.filter((s) => /^(onset|td|tmax):/.test(s.id));
    expect(verticals.length).toBeGreaterThan(0);
    for (const v of verticals) {
      // Two points, same x, from the run floor up to the curve.
      expect(v.x).toHaveLength(2);
      expect(v.x![0]).toBeCloseTo(v.x![1], 10);
      expect(v.y[0]).toBeCloseTo(runMin, 6);
      // The top sits on the mg curve (6-10 mg here), NOT at 100.
      expect(v.y[1]).toBeGreaterThan(5.5);
      expect(v.y[1]).toBeLessThan(10.5);
      // ...and it is the curve's value at that x, to interpolation error.
      const i = curve.x!.findIndex((xv) => xv >= v.x![0]);
      expect(v.y[1]).toBeCloseTo(curve.y[i], 1);
    }
    // Each label sits on the line it annotates.
    for (const p of data.peakLabels ?? []) {
      const owner = data.series.find((s) => s.id === `${p.id.split(":")[0]}:A`);
      if (owner) expect(p.y).toBeCloseTo(owner.y[1], 6);
    }
  });

  it("withholds the temperature markers on a time x-axis", () => {
    // Onset / Td / Tmax are temperatures; against minutes they would sit at
    // arbitrary positions, so they are not drawn at all (the on-screen plot
    // withholds them for the same reason).
    const run = makeRun("A", "#2563eb");
    const data = buildTgaFigureData({
      runs: [run],
      xAxis: "time",
      yAxis: "weightPct",
      showDtg: false,
      labelMarkers: true,
      stackRuns: false,
      markers: { onset: true, endset: true, td: true, tmax: true, residue: true, stepShade: false },
    });
    expect(data.series.filter((s) => /^(onset|endset|td|tmax):/.test(s.id))).toHaveLength(0);
    // The residue level is a weight, so it is still valid against time.
    expect(data.series.find((s) => s.id === "residue:A")).toBeDefined();
  });

  it("stacking lifts each run onto its own band, markers and residue with it", () => {
    const a = makeRun("A", "#2563eb");
    const b = makeRun("B", "#dc2626");
    const data = buildTgaFigureData({
      runs: [a, b],
      xAxis: "temperature",
      yAxis: "weightPct",
      showDtg: true,
      labelMarkers: true,
      stackRuns: true,
      markers: { onset: true, endset: false, td: false, tmax: false, residue: true, stepShade: false },
    });
    const ca = data.series.find((s) => s.id === "tga:A")!;
    const cb = data.series.find((s) => s.id === "tga:B")!;
    // The second run sits entirely above the first.
    expect(Math.min(...cb.y.filter(Number.isFinite))).toBeGreaterThan(
      Math.max(...ca.y.filter(Number.isFinite)),
    );
    expect(ca.baseline).toBe(0);
    expect(cb.baseline).toBeGreaterThan(0);
    // DTG stacks too, or every run's derivative piles up in the same band.
    const da = data.series.find((s) => s.id === "dtg:A")!;
    const db = data.series.find((s) => s.id === "dtg:B")!;
    expect(Math.min(...db.y.filter(Number.isFinite))).toBeGreaterThan(
      Math.max(...da.y.filter(Number.isFinite)),
    );
    // The markers ride along: B's onset and residue are in B's band.
    const onsetB = data.series.find((s) => s.id.startsWith("onset:B"));
    if (onsetB) expect(onsetB.y[0]).toBeCloseTo(cb.baseline!, 6);
    const residueB = data.series.find((s) => s.id === "residue:B")!;
    expect(residueB.y[0]).toBeGreaterThanOrEqual(cb.baseline!);
    expect(residueB.y[0]).toBeLessThanOrEqual(Math.max(...cb.y.filter(Number.isFinite)));
  });

  it("keeps every point of a run up to a generous cap", () => {
    // An export must carry the curve the instrument recorded, not a sketch of
    // it; the preview decimates again to the plot width, so this cap only
    // bounds the exported SVG.
    const run = makeRun("A", "#2563eb");
    const data = buildTgaFigureData({
      runs: [run],
      xAxis: "temperature",
      yAxis: "weightPct",
      showDtg: false,
      labelMarkers: false,
      stackRuns: false,
      markers: { onset: false, endset: false, td: false, tmax: false, residue: false, stepShade: false },
    });
    expect(data.series.find((s) => s.id === "tga:A")!.y).toHaveLength(run.tempC.length);
  });

  it("sourceName falls back to 'tga' when no run is visible", () => {
    const data = buildTgaFigureData({
      runs: [],
      xAxis: "temperature",
      yAxis: "weightPct",
      showDtg: false,
      labelMarkers: false,
      stackRuns: false,
      markers: { onset: false, endset: false, td: false, tmax: false, residue: false, stepShade: false },
    });
    expect(data.sourceName).toBe("tga");
    expect(data.series).toHaveLength(0);
  });
});