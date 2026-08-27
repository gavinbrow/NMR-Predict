// Unit tests for the on-screen plot adapter. The two things that matter here:
// the traces apply the run's gain the same way the figure adapter does (so the
// figure really is WYSIWYG), and the temperature-only markers are withheld when
// the x-axis is showing time.

import { describe, expect, it } from "vitest";
import {
  buildTgaPlotMarkers,
  buildTgaPlotTraces,
  plotXLabel,
  plotY2Label,
  plotYLabel,
} from "../plot";
import { computeAnalysis } from "../compute";
import { DEFAULT_PARAMS, type TgaMetadata } from "../types";
import type { TgaRunAnalyzed } from "../store";
import type { TgaMarkerToggles } from "../figure";

const ALL_MARKERS: TgaMarkerToggles = {
  onset: true,
  endset: true,
  td: true,
  tmax: true,
  residue: true,
  stepShade: false,
};

function makeRun(id: string, overrides: Partial<TgaRunAnalyzed> = {}): TgaRunAnalyzed {
  const n = 201;
  const tempC = new Float64Array(n);
  const weightMg = new Float64Array(n);
  const timeMin = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    tempC[i] = 100 + t * 200;
    weightMg[i] = 10 * (1 - 0.4 * t);
    timeMin[i] = t * 20;
  }
  const meta: TgaMetadata = {
    instrument: "TA Q50",
    operator: "",
    sampleName: id,
    sampleSizeMg: 10,
    pan: "",
    methodSteps: [],
    runDate: "",
    gases: "",
  };
  return {
    id,
    fileId: "f1",
    fileName: `${id}.txt`,
    label: id,
    color: "#2563eb",
    meta,
    segments: [{ label: "Ramp" }],
    timeMin,
    tempC,
    weightMg,
    scale: 1,
    offset: 0,
    visible: true,
    materialId: null,
    analysis: computeAnalysis(weightMg, tempC, timeMin, DEFAULT_PARAMS, { sampleSizeMg: 10 }),
    ...overrides,
  };
}

describe("axis labels", () => {
  it("follow the mode toggles", () => {
    expect(plotXLabel("temperature")).toBe("Temperature (°C)");
    expect(plotXLabel("time")).toBe("Time (min)");
    expect(plotYLabel("weightPct")).toBe("Weight (%)");
    expect(plotYLabel("weightMg")).toBe("Weight (mg)");
    expect(plotY2Label("%/°C")).toBe("Deriv. weight (%/°C)");
    expect(plotY2Label("%/min")).toBe("Deriv. weight (%/min)");
  });
});

describe("buildTgaPlotTraces", () => {
  it("plots temperature or time on x per the mode", () => {
    const run = makeRun("A");
    const byT = buildTgaPlotTraces({ runs: [run], xAxis: "temperature", yAxis: "weightPct" });
    const byTime = buildTgaPlotTraces({ runs: [run], xAxis: "time", yAxis: "weightPct" });
    expect(byT[0].x[0]).toBeCloseTo(100, 6);
    expect(byTime[0].x[0]).toBeCloseTo(0, 6);
  });

  it("plots weight % or mg on y per the mode", () => {
    const run = makeRun("A");
    const pct = buildTgaPlotTraces({ runs: [run], xAxis: "temperature", yAxis: "weightPct" });
    const mg = buildTgaPlotTraces({ runs: [run], xAxis: "temperature", yAxis: "weightMg" });
    expect(pct[0].y[0]).toBeCloseTo(100, 6);
    expect(mg[0].y[0]).toBeCloseTo(10, 6);
  });

  it("applies the run's scale and offset — the same v*scale+offset the figure uses", () => {
    const run = makeRun("A", { scale: 2, offset: 5 });
    const [trace] = buildTgaPlotTraces({ runs: [run], xAxis: "temperature", yAxis: "weightPct" });
    expect(trace.y[0]).toBeCloseTo(100 * 2 + 5, 6);
  });

  it("keeps hidden runs in the list, flagged invisible, so ordering is stable", () => {
    const traces = buildTgaPlotTraces({
      runs: [makeRun("A", { visible: false }), makeRun("B")],
      xAxis: "temperature",
      yAxis: "weightPct",
    });
    expect(traces.map((t) => t.id)).toEqual(["A", "B"]);
    expect(traces[0].visible).toBe(false);
  });
});

describe("buildTgaPlotMarkers", () => {
  it("draws the temperature markers when x is temperature", () => {
    const markers = buildTgaPlotMarkers({
      runs: [makeRun("A")],
      xAxis: "temperature",
      yAxis: "weightPct",
      markers: ALL_MARKERS,
    });
    expect(markers.some((m) => m.kind === "td")).toBe(true);
    expect(markers.some((m) => m.kind === "residue")).toBe(true);
  });

  it("scales a run's DTG with its gain, but never offsets it", () => {
    // d/dT of a scaled curve is scaled by the same factor; d/dT of a constant
    // offset is zero. Scaling a run used to grow its mass curve and leave its
    // derivative behind.
    const plain = buildTgaPlotTraces({ runs: [makeRun("A")], xAxis: "temperature", yAxis: "weightPct" });
    const gained = buildTgaPlotTraces({
      runs: [makeRun("A", { scale: 2, offset: 5 })],
      xAxis: "temperature",
      yAxis: "weightPct",
    });
    const i = plain[0].dtg!.length >> 1;
    expect(gained[0].dtg![i]).toBeCloseTo(plain[0].dtg![i] * 2, 10);
    expect(gained[0].y[i]).toBeCloseTo(plain[0].y[i] * 2 + 5, 10);
  });

  it("anchors each vertical marker's label on its own run's curve", () => {
    // Without a y the overlay drew every label at the top of the plot, so with
    // several runs overlaid the callouts stacked up in one corner and none of
    // them said which line they belonged to.
    const run = makeRun("A");
    const out = buildTgaPlotMarkers({
      runs: [run],
      xAxis: "temperature",
      yAxis: "weightPct",
      markers: ALL_MARKERS,
    });
    const verticals = out.filter((m) => m.kind !== "residue");
    expect(verticals.length).toBeGreaterThan(0);
    for (const m of verticals) {
      expect(m.y).toBeDefined();
      // The synthetic run falls 100 % -> 60 %, so every anchor is in that band.
      expect(m.y!).toBeGreaterThanOrEqual(59);
      expect(m.y!).toBeLessThanOrEqual(101);
    }
  });

  it("carries the run's gain into the marker anchors, as the traces do", () => {
    const run = makeRun("A", { scale: 2, offset: 5 });
    const plain = buildTgaPlotMarkers({
      runs: [makeRun("A")],
      xAxis: "temperature",
      yAxis: "weightPct",
      markers: ALL_MARKERS,
    });
    const gained = buildTgaPlotMarkers({
      runs: [run],
      xAxis: "temperature",
      yAxis: "weightPct",
      markers: ALL_MARKERS,
    });
    expect(gained).toHaveLength(plain.length);
    for (let i = 0; i < plain.length; i += 1) {
      if (plain[i].y == null) continue;
      expect(gained[i].y!).toBeCloseTo(plain[i].y! * 2 + 5, 6);
    }
  });

  it("withholds the temperature markers when x is time, but keeps the residue level", () => {
    const markers = buildTgaPlotMarkers({
      runs: [makeRun("A")],
      xAxis: "time",
      yAxis: "weightPct",
      markers: ALL_MARKERS,
    });
    expect(markers.every((m) => m.kind === "residue")).toBe(true);
    expect(markers).not.toHaveLength(0);
  });

  it("skips hidden runs entirely", () => {
    const markers = buildTgaPlotMarkers({
      runs: [makeRun("A", { visible: false })],
      xAxis: "temperature",
      yAxis: "weightPct",
      markers: ALL_MARKERS,
    });
    expect(markers).toEqual([]);
  });

  it("honours each marker family's toggle", () => {
    const only: TgaMarkerToggles = { ...ALL_MARKERS, td: false, residue: false };
    const markers = buildTgaPlotMarkers({
      runs: [makeRun("A")],
      xAxis: "temperature",
      yAxis: "weightPct",
      markers: only,
    });
    expect(markers.some((m) => m.kind === "td")).toBe(false);
    expect(markers.some((m) => m.kind === "residue")).toBe(false);
  });

  it("reports the residue in mg when the primary axis is showing mg", () => {
    const [marker] = buildTgaPlotMarkers({
      runs: [makeRun("A")],
      xAxis: "time",
      yAxis: "weightMg",
      markers: ALL_MARKERS,
    });
    expect(marker.label).toMatch(/mg$/);
    expect(marker.y).toBeCloseTo(6, 2);
  });
});
