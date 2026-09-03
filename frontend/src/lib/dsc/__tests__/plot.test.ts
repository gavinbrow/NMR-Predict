// Unit tests for the on-screen plot adapter (§WP4/§WP9).
//
// Mirrors `lib/tga/__tests__/plot.test.ts`'s style: inline fixtures, no
// mocking, behavioural `it(...)` sentences. Fixtures reuse
// `compute.test.ts`'s synthetic-curve shape (a linear baseline + a Gaussian
// endotherm + a tanh glass step, §WP3's own fixture) but with an explicit
// `features` array rather than relying on auto-detection — `run.features`
// is what `buildDscPlotMarkers` actually reads (auto-detected features are
// computed on the fly inside `computeDscAnalysis` and are not persisted back
// onto the run until a feature is explicitly added/edited), so a marker test
// has to populate it directly to exercise the real contract.

import { describe, expect, it } from "vitest";
import { computeDscAnalysis } from "../compute";
import {
  buildDscPlotMarkers,
  buildDscPlotTraces,
  DEFAULT_MAX_PLOT_POINTS,
  dscPlotXLabel,
  dscPlotY2Label,
  dscPlotYLabel,
  type DscMarkerToggles,
} from "../plot";
import { DEFAULT_PARAMS, type DscFeature, type DscParams, type DscRun, type DscSegment } from "../types";
import type { DscRunAnalyzed } from "../store";

const ALL_MARKERS: DscMarkerToggles = {
  glass: true,
  melt: true,
  crystallization: true,
  coldCrystallization: true,
  cure: true,
  oit: true,
  baselines: true,
  tangents: true,
  enthalpyLabels: true,
};

// ---------------------------------------------------------------------------
// Synthetic curve builder — baseline(T) + a Gaussian endotherm (melt) + a
// tanh glass-transition step, matching `compute.test.ts`'s shape.
// ---------------------------------------------------------------------------

function heatFlowWPerGAt(T: number): number {
  const baseline = 0.02 + 0.0001 * T;
  const gauss = -2 * Math.exp(-((T - 180) ** 2) / (2 * 5 ** 2)); // endothermic melt at 180 °C
  const step = (0.06 / 2) * (1 + Math.tanh((T - 80) / 3)); // glass step at 80 °C
  return baseline + gauss + step;
}

function baselineOnlyWPerGAt(T: number): number {
  return 0.02 + 0.0001 * T;
}

let runCounter = 0;

/**
 * A run with two segments on one 40-260 °C span at 10 °C/min: a heating
 * segment (baseline + melt + glass step, matching `heatFlowWPerGAt`) and a
 * cooling segment (baseline only, no features) — enough to exercise both
 * "active" and "all" segment mode. `sampleMassMg` defaults to 10 so a
 * W/g-vs-mW toggle test has something other than 1:1 to check.
 */
function makeRun(
  overrides: Partial<{
    sampleMassMg: number;
    scale: number;
    offset: number;
    visible: boolean;
    exoDirection: "up" | "down";
    n: number;
  }> = {},
): DscRunAnalyzed {
  runCounter += 1;
  const id = `run${runCounter}`;
  const sampleMassMg = overrides.sampleMassMg ?? 10;
  const t0 = 40;
  const t1 = 260;
  const dTc = 0.5;
  const rateCPerMin = 10;
  const n = overrides.n ?? Math.round((t1 - t0) / dTc) + 1;
  const dtMin = dTc / rateCPerMin;

  const timeMin = new Float64Array(2 * n);
  const tempC = new Float64Array(2 * n);
  const heatFlowMw = new Float64Array(2 * n);

  // Segment 0: heat, 40 -> 260 °C.
  for (let i = 0; i < n; i += 1) {
    const T = t0 + (i * (t1 - t0)) / (n - 1);
    timeMin[i] = i * dtMin;
    tempC[i] = T;
    heatFlowMw[i] = heatFlowWPerGAt(T) * sampleMassMg;
  }
  const gapMin = 1; // mimics an isothermal hold the block walk skips (§2.1)
  const t1Start = timeMin[n - 1] + gapMin;
  // Segment 1: cool, 260 -> 40 °C, baseline only (no features to detect).
  for (let j = 0; j < n; j += 1) {
    const T = t1 - (j * (t1 - t0)) / (n - 1);
    timeMin[n + j] = t1Start + j * dtMin;
    tempC[n + j] = T;
    heatFlowMw[n + j] = baselineOnlyWPerGAt(T) * sampleMassMg;
  }

  const seg0: DscSegment = {
    id: `${id}:seg0`,
    label: `Ramp ${rateCPerMin} °C/min to ${t1} °C`,
    kind: "heat",
    rateCPerMin,
    ordinal: 1,
    cycle: 1,
    start: 0,
    end: n,
    tStartC: tempC[0],
    tEndC: tempC[n - 1],
    timeStartMin: timeMin[0],
    timeEndMin: timeMin[n - 1],
  };
  const seg1: DscSegment = {
    id: `${id}:seg1`,
    label: `Ramp ${rateCPerMin} °C/min to ${t0} °C`,
    kind: "cool",
    rateCPerMin,
    ordinal: 1,
    cycle: 1,
    start: n,
    end: 2 * n,
    tStartC: tempC[n],
    tEndC: tempC[2 * n - 1],
    timeStartMin: timeMin[n],
    timeEndMin: timeMin[2 * n - 1],
  };

  const glassFeature: DscFeature = {
    id: `${id}:glass1`,
    segmentId: seg0.id,
    kind: "glass",
    label: "Glass transition 1",
    window: [56, 104], // 80 ± 8*3 °C, matches compute.test.ts's GLASS_WINDOW shape
    baseline: null,
    baselineMode: "linear",
    auto: false,
    visible: true,
  };
  const meltFeature: DscFeature = {
    id: `${id}:melt1`,
    segmentId: seg0.id,
    kind: "melt",
    label: "Melt 1",
    window: [150, 210], // 180 ± 6*5 °C
    baseline: null,
    baselineMode: "linear",
    auto: false,
    visible: true,
  };

  const run: DscRun = {
    label: id,
    meta: {
      instrument: "DSC25",
      operator: "Test",
      sampleName: id,
      sampleMassMg,
      panMassMg: 0,
      pan: "Tzero Aluminum Hermetic",
      methodSteps: [seg0.label, seg1.label],
      runDate: "9/2/2026",
      gases: "Nitrogen, 50 mL/min",
      cooler: "RCS 90",
      cellConstant: "-23.6 mW/°C",
      sampleInterval: "0.1 s/pt",
      exoDirection: overrides.exoDirection ?? "up",
    },
    segments: [seg0, seg1],
    timeMin,
    tempC,
    heatFlowMw,
    id,
    fileId: `${id}:file`,
    fileName: "synthetic.tri",
    color: "#2563eb",
    scale: overrides.scale ?? 1,
    offset: overrides.offset ?? 0,
    visible: overrides.visible ?? true,
    materialId: null,
    activeSegmentId: seg0.id,
    massOverrideMg: null,
    polymerFraction: 1,
    referenceId: null,
    features: [glassFeature, meltFeature],
  };

  const analysis = computeDscAnalysis(run, DEFAULT_PARAMS);
  return { ...run, analysis };
}

/** An isothermal run with an exothermic OIT rise, used only to exercise the
 *  time-domain marker (withheld on the temperature axis, drawn on time). */
function makeOitRun(): DscRunAnalyzed {
  runCounter += 1;
  const id = `oit${runCounter}`;
  const n = 300;
  const dt = 0.02; // minutes
  const onsetMin = 3;
  const timeMin = new Float64Array(n);
  const tempC = new Float64Array(n);
  const heatFlowMw = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i * dt;
    timeMin[i] = t;
    tempC[i] = 200;
    const step = 0.5 * (1 + Math.tanh((t - onsetMin) / 0.3));
    heatFlowMw[i] = 0.01 + 0.2 * step;
  }
  const seg: DscSegment = {
    id: `${id}:seg0`,
    label: "Isothermal 200.0 °C",
    kind: "isothermal",
    rateCPerMin: null,
    ordinal: 1,
    cycle: 1,
    start: 0,
    end: n,
    tStartC: tempC[0],
    tEndC: tempC[n - 1],
    timeStartMin: timeMin[0],
    timeEndMin: timeMin[n - 1],
  };
  const oitFeature: DscFeature = {
    id: `${id}:oit1`,
    segmentId: seg.id,
    kind: "oit",
    label: "OIT",
    window: [0, timeMin[n - 1]],
    baseline: null,
    baselineMode: "linear",
    auto: false,
    visible: true,
  };
  const run: DscRun = {
    label: id,
    meta: {
      instrument: "DSC25",
      operator: "Test",
      sampleName: id,
      sampleMassMg: 5,
      panMassMg: 0,
      pan: "Tzero Aluminum Hermetic",
      methodSteps: [seg.label],
      runDate: "9/2/2026",
      gases: "Oxygen, 50 mL/min",
      cooler: "RCS 90",
      cellConstant: "-23.6 mW/°C",
      sampleInterval: "0.02 min/pt",
      exoDirection: "up",
    },
    segments: [seg],
    timeMin,
    tempC,
    heatFlowMw,
    id,
    fileId: `${id}:file`,
    fileName: "synthetic-oit.tri",
    color: "#dc2626",
    scale: 1,
    offset: 0,
    visible: true,
    materialId: null,
    activeSegmentId: seg.id,
    massOverrideMg: null,
    polymerFraction: 1,
    referenceId: null,
    features: [oitFeature],
  };
  const analysis = computeDscAnalysis(run, DEFAULT_PARAMS);
  return { ...run, analysis };
}

// ---------------------------------------------------------------------------
// Axis labels
// ---------------------------------------------------------------------------

describe("axis labels", () => {
  it("follow the x/y mode toggles", () => {
    expect(dscPlotXLabel("temperature")).toBe("Temperature (°C)");
    expect(dscPlotXLabel("time")).toBe("Time (min)");
    expect(dscPlotYLabel("wattsPerGram", true, false)).toBe("Heat flow (W/g)");
    expect(dscPlotYLabel("milliwatts", true, false)).toBe("Heat flow (mW)");
  });

  it("appends the exo arrow only when showExoArrow is on, per the exoUp direction", () => {
    expect(dscPlotYLabel("wattsPerGram", true, true)).toBe("Heat flow (W/g) ↑ Exo");
    expect(dscPlotYLabel("wattsPerGram", false, true)).toBe("Heat flow (W/g) ↓ Exo");
    expect(dscPlotYLabel("wattsPerGram", true, false)).not.toMatch(/Exo/);
  });

  it("chooses the y2 content from xAxis, not a separate selector, and is empty when off", () => {
    expect(dscPlotY2Label("off", "temperature")).toBe("");
    expect(dscPlotY2Label("off", "time")).toBe("");
    expect(dscPlotY2Label("derivative", "temperature")).toBe("dHF/dT (W/g·°C)");
    expect(dscPlotY2Label("derivative", "time")).toBe("Temperature (°C)");
  });
});

// ---------------------------------------------------------------------------
// buildDscPlotTraces
// ---------------------------------------------------------------------------

describe("buildDscPlotTraces", () => {
  it("plots temperature or time on x per the mode", () => {
    const run = makeRun();
    const byT = buildDscPlotTraces({
      runs: [run],
      params: DEFAULT_PARAMS,
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2Mode: "off",
      segmentMode: "active",
    });
    const byTime = buildDscPlotTraces({
      runs: [run],
      params: DEFAULT_PARAMS,
      xAxis: "time",
      yAxis: "wattsPerGram",
      y2Mode: "off",
      segmentMode: "active",
    });
    expect(byT[0].x[0]).toBeCloseTo(40, 6);
    expect(byTime[0].x[0]).toBeCloseTo(0, 6);
  });

  it("applies the run's gain as v*scale+offset — the same formula the figure adapter uses", () => {
    // W/g mode always has unitScale === 1 (no mass conversion involved), so
    // the plain-vs-gained comparison isolates exactly the gain formula.
    const plain = makeRun({ scale: 1, offset: 0 });
    const gained = makeRun({ scale: 2, offset: 5 });
    const [plainTrace] = buildDscPlotTraces({
      runs: [plain],
      params: DEFAULT_PARAMS,
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2Mode: "off",
      segmentMode: "active",
    });
    const [gainedTrace] = buildDscPlotTraces({
      runs: [gained],
      params: DEFAULT_PARAMS,
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2Mode: "off",
      segmentMode: "active",
    });
    // n = 441 < DEFAULT_MAX_PLOT_POINTS, so neither call downsamples and the
    // two arrays stay index-aligned for a direct comparison.
    expect(plainTrace.x.length).toBeLessThan(DEFAULT_MAX_PLOT_POINTS);
    for (let i = 0; i < plainTrace.y.length; i += 4) {
      expect(gainedTrace.y[i]).toBeCloseTo(plainTrace.y[i] * 2 + 5, 6);
    }
  });

  it("converts W/g to mW using the run's normalizing mass, undoing the /mg division", () => {
    const run = makeRun({ sampleMassMg: 10 });
    const [wPerG] = buildDscPlotTraces({
      runs: [run],
      params: DEFAULT_PARAMS,
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2Mode: "off",
      segmentMode: "active",
    });
    const [mw] = buildDscPlotTraces({
      runs: [run],
      params: DEFAULT_PARAMS,
      xAxis: "temperature",
      yAxis: "milliwatts",
      y2Mode: "off",
      segmentMode: "active",
    });
    for (let i = 0; i < wPerG.y.length; i += 4) {
      expect(mw.y[i]).toBeCloseTo(wPerG.y[i] * 10, 6);
    }
  });

  it("scales the derivative with the run's gain, but never offsets it", () => {
    // d/dT of a scaled curve is scaled by the same factor; d/dT of a
    // constant offset is zero. Scaling a run used to grow the heat-flow
    // curve and leave the derivative behind (the exact bug TGA's plot.ts
    // doc comment pins for DTG).
    const plain = makeRun({ scale: 1, offset: 0 });
    const gained = makeRun({ scale: 3, offset: 7 });
    const [plainTrace] = buildDscPlotTraces({
      runs: [plain],
      params: DEFAULT_PARAMS,
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2Mode: "derivative",
      segmentMode: "active",
    });
    const [gainedTrace] = buildDscPlotTraces({
      runs: [gained],
      params: DEFAULT_PARAMS,
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2Mode: "derivative",
      segmentMode: "active",
    });
    expect(plainTrace.y2).not.toBeNull();
    const i = plainTrace.y2!.length >> 1;
    expect(gainedTrace.y2![i]).toBeCloseTo(plainTrace.y2![i] * 3, 6);
  });

  it("draws the temperature program on y2 (no gain) when x is time", () => {
    const run = makeRun({ scale: 5, offset: 100 });
    const [trace] = buildDscPlotTraces({
      runs: [run],
      params: DEFAULT_PARAMS,
      xAxis: "time",
      yAxis: "wattsPerGram",
      y2Mode: "derivative",
      segmentMode: "active",
    });
    expect(trace.y2).not.toBeNull();
    // The program trace is temperature (40-260 °C on the heating segment),
    // never the gained heat-flow curve — a 5x/+100 gain would push it far
    // outside that range if it had leaked in.
    for (let i = 0; i < trace.y2!.length; i += 1) {
      expect(trace.y2![i]).toBeGreaterThanOrEqual(39);
      expect(trace.y2![i]).toBeLessThanOrEqual(261);
    }
  });

  it("keeps hidden runs in the list, flagged invisible, so legend order stays stable", () => {
    const traces = buildDscPlotTraces({
      runs: [makeRun({ visible: false }), makeRun()],
      params: DEFAULT_PARAMS,
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2Mode: "off",
      segmentMode: "active",
    });
    expect(traces).toHaveLength(2);
    expect(traces[0].visible).toBe(false);
    expect(traces[1].visible).toBe(true);
  });

  it('segment mode "active" emits one trace per run, for its own active segment only', () => {
    const run = makeRun();
    const traces = buildDscPlotTraces({
      runs: [run],
      params: DEFAULT_PARAMS,
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2Mode: "off",
      segmentMode: "active",
    });
    expect(traces).toHaveLength(1);
    expect(traces[0].segmentId).toBe(run.segments[0].id); // the heat segment, run's activeSegmentId
    expect(traces[0].dashed).toBe(false);
  });

  it('segment mode "all" emits one trace per segment, with cooling segments dashed', () => {
    const run = makeRun();
    const traces = buildDscPlotTraces({
      runs: [run],
      params: DEFAULT_PARAMS,
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2Mode: "off",
      segmentMode: "all",
    });
    expect(traces).toHaveLength(2);
    const heat = traces.find((t) => t.segmentId === run.segments[0].id)!;
    const cool = traces.find((t) => t.segmentId === run.segments[1].id)!;
    expect(heat.dashed).toBe(false);
    expect(cool.dashed).toBe(true);
  });

  it("downsamples a series past the point budget, and respects a caller-supplied budget", () => {
    const run = makeRun({ n: 5001 });
    const full = buildDscPlotTraces({
      runs: [run],
      params: DEFAULT_PARAMS,
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2Mode: "off",
      segmentMode: "active",
    });
    expect(full[0].x.length).toBeLessThanOrEqual(DEFAULT_MAX_PLOT_POINTS);
    expect(full[0].x.length).toBeGreaterThan(0);

    const tight = buildDscPlotTraces({
      runs: [run],
      params: DEFAULT_PARAMS,
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2Mode: "off",
      segmentMode: "active",
      maxPoints: 50,
    });
    expect(tight[0].x.length).toBeLessThanOrEqual(50);
    expect(tight[0].x.length).toBeLessThan(full[0].x.length);
  });
});

// ---------------------------------------------------------------------------
// buildDscPlotMarkers
// ---------------------------------------------------------------------------

describe("buildDscPlotMarkers", () => {
  it("draws glass and melt markers on the temperature axis", () => {
    const markers = buildDscPlotMarkers({
      runs: [makeRun()],
      params: DEFAULT_PARAMS,
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      markers: ALL_MARKERS,
    });
    expect(markers.some((m) => m.id.includes(":glass1:"))).toBe(true);
    expect(markers.some((m) => m.id.includes(":melt1:"))).toBe(true);
    // A "Tg …" and a "Tm …" callout should both be present.
    const labels = markers.filter((m) => m.kind === "label");
    expect(labels.some((m) => m.text.startsWith("Tg "))).toBe(true);
    expect(labels.some((m) => m.text.startsWith("Tm "))).toBe(true);
    expect(labels.some((m) => m.text.startsWith("ΔH "))).toBe(true);
  });

  it("withholds the temperature-domain markers when x is time", () => {
    // Glass/melt/etc. are temperatures; drawn against time they would sit at
    // meaningless x positions, exactly like TGA's onset/endset/Tmax rule.
    const markers = buildDscPlotMarkers({
      runs: [makeRun()],
      params: DEFAULT_PARAMS,
      xAxis: "time",
      yAxis: "wattsPerGram",
      markers: ALL_MARKERS,
    });
    expect(markers).toEqual([]);
  });

  it("draws the OIT marker only on the time axis — the mirror-image rule", () => {
    const run = makeOitRun();
    const onTime = buildDscPlotMarkers({
      runs: [run],
      params: DEFAULT_PARAMS,
      xAxis: "time",
      yAxis: "wattsPerGram",
      markers: ALL_MARKERS,
    });
    const onTemperature = buildDscPlotMarkers({
      runs: [run],
      params: DEFAULT_PARAMS,
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      markers: ALL_MARKERS,
    });
    expect(onTime.length).toBeGreaterThan(0);
    expect(onTime.some((m) => m.kind === "label" && m.text.startsWith("OIT"))).toBe(true);
    expect(onTemperature).toEqual([]);
  });

  it("skips hidden runs entirely", () => {
    const markers = buildDscPlotMarkers({
      runs: [makeRun({ visible: false })],
      params: DEFAULT_PARAMS,
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      markers: ALL_MARKERS,
    });
    expect(markers).toEqual([]);
  });

  it("honours each feature kind's toggle", () => {
    const meltOnly: DscMarkerToggles = { ...ALL_MARKERS, glass: false };
    const markers = buildDscPlotMarkers({
      runs: [makeRun()],
      params: DEFAULT_PARAMS,
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      markers: meltOnly,
    });
    expect(markers.some((m) => m.id.includes(":glass1:"))).toBe(false);
    expect(markers.some((m) => m.id.includes(":melt1:"))).toBe(true);
  });

  it("carries the run's gain into the marker anchors, as the traces do", () => {
    const plain = buildDscPlotMarkers({
      runs: [makeRun({ scale: 1, offset: 0 })],
      params: DEFAULT_PARAMS,
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      markers: ALL_MARKERS,
    });
    const gained = buildDscPlotMarkers({
      runs: [makeRun({ scale: 2, offset: 5 })],
      params: DEFAULT_PARAMS,
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      markers: ALL_MARKERS,
    });
    expect(gained).toHaveLength(plain.length);
    for (let i = 0; i < plain.length; i += 1) {
      const p = plain[i];
      const g = gained[i];
      if (p.kind === "vertical" && p.y != null) {
        expect((g as typeof p).y!).toBeCloseTo(p.y * 2 + 5, 4);
      }
      if (p.kind === "vertical" && p.y2 != null) {
        expect((g as typeof p).y2!).toBeCloseTo(p.y2 * 2 + 5, 4);
      }
      if (p.kind === "label") {
        expect((g as typeof p).y).toBeCloseTo(p.y * 2 + 5, 4);
      }
    }
  });

  it("withholds baselines, tangents, and the ΔH label unless their toggles are on — the default state", () => {
    // `DEFAULT_PLOT_MARKERS` in `pages/Dsc.tsx` sets all three of these
    // false: a fresh analysis should show the Tg/Tm/… callouts without also
    // drawing every fitted baseline/tangent/ΔH label unasked.
    const markers: DscMarkerToggles = { ...ALL_MARKERS, baselines: false, tangents: false, enthalpyLabels: false };
    const out = buildDscPlotMarkers({
      runs: [makeRun()],
      params: DEFAULT_PARAMS,
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      markers,
    });
    expect(out.some((m) => m.kind === "line")).toBe(false);
    expect(out.some((m) => m.kind === "label" && m.text.startsWith("ΔH "))).toBe(false);
    // The onset/peak/midpoint verticals and the Tm/Tg callouts are unaffected.
    expect(out.some((m) => m.kind === "label" && m.text.startsWith("Tm "))).toBe(true);
    expect(out.some((m) => m.kind === "label" && m.text.startsWith("Tg "))).toBe(true);
  });

  it("re-enables baselines/tangents/ΔH only when their own toggles are on", () => {
    const out = buildDscPlotMarkers({
      runs: [makeRun()],
      params: DEFAULT_PARAMS,
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      markers: ALL_MARKERS,
    });
    expect(out.some((m) => m.kind === "line" && m.sub === "baseline")).toBe(true);
    expect(out.some((m) => m.kind === "line" && m.sub === "tangent")).toBe(true);
    expect(out.some((m) => m.kind === "label" && m.text.startsWith("ΔH "))).toBe(true);
  });

  it("spans the Tm vertical from the melt apex to its baseline, with the callout at the midpoint", () => {
    // The bug this pins: the vertical used to run all the way to the plot
    // floor, dragging the "Tm" callout down with it — for an endothermic
    // melt (a trough in exo-up), that put the label at the bottom of the
    // chart instead of on the peak.
    const out = buildDscPlotMarkers({
      runs: [makeRun()],
      params: DEFAULT_PARAMS,
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      markers: ALL_MARKERS,
    });
    const peakVertical = out.find((m) => m.kind === "vertical" && m.id.endsWith(":melt1:v:peak"));
    expect(peakVertical).toBeDefined();
    expect(peakVertical!.kind).toBe("vertical");
    const v = peakVertical as Extract<typeof peakVertical, { kind: "vertical" }>;
    expect(v.y).not.toBeUndefined();
    expect(v.y2).not.toBeUndefined();
    // The baseline sits well away from the apex — this is a real span, not
    // a same-point no-op.
    expect(Math.abs(v.y2! - v.y!)).toBeGreaterThan(0.1);

    const featureId = v.id.slice(0, -":v:peak".length);
    const label = out.find((m) => m.kind === "label" && m.id === `${featureId}:label:peak`);
    expect(label).toBeDefined();
    expect((label as { y: number }).y).toBeCloseTo((v.y! + v.y2!) / 2, 6);
  });
});
