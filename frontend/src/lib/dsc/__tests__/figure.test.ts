// Unit tests for the DSC figure adapter (`buildDscFigureData`). Pure data
// shaping — no DOM. Verifies the series ids, the axis hints, the marker
// series' `legendHidden`/group, the peak labels' `customText`, and the
// stacking/segment-mode geometry. Follows `lib/tga/__tests__/figure.test.ts`
// closely; a `makeRun` helper builds a synthetic two-segment run (a heating
// ramp with a glass step + a melt peak, then a cooling ramp with a
// crystallization peak) and calls the REAL `computeDscAnalysis` on it, so
// every assertion below is checked against genuine analysis results, not a
// hand-typed stand-in.

import { describe, expect, it } from "vitest";
import { computeDscAnalysis } from "../compute";
import { buildDscFigureData, type DscMarkerToggles } from "../figure";
import { buildSegments } from "../segments";
import type { DscRunAnalyzed } from "../store";
import { DEFAULT_PARAMS, type DscFeature, type DscMetadata, type DscRun } from "../types";

const NO_MARKERS: DscMarkerToggles = {
  glassOnset: false,
  glassMid: false,
  glassEndset: false,
  peakTemp: false,
  peakOnset: false,
  peakEndset: false,
  baselines: false,
  tangents: false,
  enthalpyLabels: false,
};

const ALL_MARKERS: DscMarkerToggles = {
  glassOnset: true,
  glassMid: true,
  glassEndset: true,
  peakTemp: true,
  peakOnset: true,
  peakEndset: true,
  baselines: true,
  tangents: true,
  enthalpyLabels: true,
};

/**
 * A synthetic run: a heating ramp (30 -> 200 °C, seg0) carrying a glass step
 * near 80 °C and an endothermic melt peak near 150 °C, followed by a cooling
 * ramp (200 -> 30 °C, seg1) carrying an exothermic crystallization peak near
 * 120 °C. `heatFlowMw` is built directly (raw, file-convention mW) so the
 * real `toWattsPerGram`/`exoDisplaySign` machinery inside `computeDscAnalysis`
 * does the normalizing — nothing here is pre-normalized by hand.
 */
function makeRun(
  id: string,
  color: string,
  opts: { massMg?: number; exoDirection?: "up" | "down"; scale?: number; offset?: number } = {},
): DscRunAnalyzed {
  const massMg = opts.massMg ?? 10;
  const n1 = 401;
  const n2 = 401;
  const n = n1 + n2;
  const tempC = new Float64Array(n);
  const timeMin = new Float64Array(n);
  const heatFlowMw = new Float64Array(n);

  const baseline = (T: number) => -0.02 + 0.0002 * T;
  const glassStep = (T: number) => 0.03 / (1 + Math.exp(-(T - 80) / 2));
  const meltPeak = (T: number) => -0.5 * Math.exp(-((T - 150) ** 2) / (2 * 5 * 5));
  const crystPeak = (T: number) => 0.4 * Math.exp(-((T - 120) ** 2) / (2 * 5 * 5));

  for (let i = 0; i < n1; i += 1) {
    const t = i / (n1 - 1);
    tempC[i] = 30 + t * 170;
    timeMin[i] = t * 17;
    const wPerG = baseline(tempC[i]) + glassStep(tempC[i]) + meltPeak(tempC[i]);
    heatFlowMw[i] = wPerG * massMg;
  }
  for (let j = 0; j < n2; j += 1) {
    const i = n1 + j;
    const t = j / (n2 - 1);
    tempC[i] = 200 - t * 170;
    timeMin[i] = 17 + t * 17;
    const wPerG = baseline(tempC[i]) + crystPeak(tempC[i]);
    heatFlowMw[i] = wPerG * massMg;
  }

  const segments = buildSegments(id, tempC, timeMin, [
    { start: 0, end: n1, label: "Ramp 10 °C/min to 200 °C" },
    { start: n1, end: n, label: "Ramp 10 °C/min to 30 °C" },
  ]);

  const meta: DscMetadata = {
    instrument: "DSC25",
    operator: "",
    sampleName: id,
    sampleMassMg: massMg,
    panMassMg: null,
    pan: "",
    methodSteps: [],
    runDate: "",
    gases: "",
    cooler: "",
    cellConstant: "",
    sampleInterval: "",
    exoDirection: opts.exoDirection ?? "up",
  };

  const features: DscFeature[] = [
    {
      id: `${id}:glass1`,
      segmentId: segments[0].id,
      kind: "glass",
      label: "Tg",
      window: [60, 100],
      baseline: null,
      baselineMode: "linear",
      auto: false,
      visible: true,
    },
    {
      id: `${id}:melt1`,
      segmentId: segments[0].id,
      kind: "melt",
      label: "Melt",
      window: [130, 170],
      baseline: null,
      baselineMode: "linear",
      auto: false,
      visible: true,
    },
  ];

  const run: DscRun = {
    id,
    fileId: `file-${id}`,
    fileName: `${id}.tri`,
    label: id,
    color,
    meta,
    segments,
    timeMin,
    tempC,
    heatFlowMw,
    scale: opts.scale ?? 1,
    offset: opts.offset ?? 0,
    visible: true,
    materialId: null,
    activeSegmentId: null, // resolves to segments[0] (the only heat segment)
    massOverrideMg: null,
    polymerFraction: 1,
    referenceId: null,
    features,
  };

  const analysis = computeDscAnalysis(run, DEFAULT_PARAMS);
  return { ...run, analysis };
}

describe("buildDscFigureData", () => {
  it("emits one DSC line series per visible run in active-segment mode", () => {
    const run = makeRun("A", "#2563eb");
    const data = buildDscFigureData({
      runs: [run],
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2: "none",
      segmentMode: "active",
      labelFeatures: false,
      stackRuns: false,
      markers: NO_MARKERS,
    });
    const dscSeries = data.series.filter((s) => s.id.startsWith("dsc:A:"));
    expect(dscSeries).toHaveLength(1);
    expect(dscSeries[0].id).toBe(`dsc:A:${run.analysis.segmentId}`);
    expect(dscSeries[0].styleHints?.axis).toBe("y");
    expect(dscSeries[0].styleHints?.kind).toBe("line");
    expect(dscSeries[0].styleHints?.lineWidth).toBe(1.6);
    expect(dscSeries[0].styleHints?.color).toBe("#2563eb");
    expect(dscSeries[0].group).toBe("A");
  });

  it("emits one series per run·segment in 'all' mode, with the cooling segment dashed", () => {
    const run = makeRun("A", "#2563eb");
    const data = buildDscFigureData({
      runs: [run],
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2: "none",
      segmentMode: "all",
      labelFeatures: false,
      stackRuns: false,
      markers: NO_MARKERS,
    });
    const dscSeries = data.series.filter((s) => s.id.startsWith("dsc:A:"));
    expect(dscSeries).toHaveLength(2); // heat (seg0) + cool (seg1)
    const heat = dscSeries.find((s) => s.id === `dsc:A:${run.segments[0].id}`)!;
    const cool = dscSeries.find((s) => s.id === `dsc:A:${run.segments[1].id}`)!;
    expect(heat.styleHints?.lineStyle).not.toBe("dashed");
    expect(cool.styleHints?.lineStyle).toBe("dashed");
    // A cooling segment rebuilt from raw arrays must use the SAME exo sign
    // as the active (heating) segment — this pins a sign-derivation bug: the
    // crystallization peak near 120 °C is exothermic (positive, W/g) in the
    // exo-up convention used here, same as the file's own raw sign.
    expect(Math.max(...cool.y)).toBeGreaterThan(0.3);
  });

  it("only draws the active segment's series when segmentMode is 'active'", () => {
    const run = makeRun("A", "#2563eb");
    const data = buildDscFigureData({
      runs: [run],
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2: "none",
      segmentMode: "active",
      labelFeatures: false,
      stackRuns: false,
      markers: NO_MARKERS,
    });
    expect(data.series.filter((s) => s.id.startsWith("dsc:A:"))).toHaveLength(1);
  });

  it("emits a derivative series on y2 only when y2 is 'derivative'", () => {
    const run = makeRun("A", "#2563eb");
    const withDeriv = buildDscFigureData({
      runs: [run],
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2: "derivative",
      segmentMode: "active",
      labelFeatures: false,
      stackRuns: false,
      markers: NO_MARKERS,
    });
    const derivSeries = withDeriv.series.filter((s) => s.id.startsWith("deriv:A:"));
    expect(derivSeries).toHaveLength(1);
    expect(derivSeries[0].styleHints?.axis).toBe("y2");
    expect(derivSeries[0].styleHints?.lineStyle).toBe("dashed");
    expect(derivSeries[0].legendHidden).toBe(true);

    const withoutDeriv = buildDscFigureData({
      runs: [run],
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2: "none",
      segmentMode: "active",
      labelFeatures: false,
      stackRuns: false,
      markers: NO_MARKERS,
    });
    expect(withoutDeriv.series.filter((s) => s.id.startsWith("deriv:"))).toHaveLength(0);
  });

  it("emits a temperature-program series on y2 only for y2 'program' AND a time x-axis", () => {
    const run = makeRun("A", "#2563eb");
    const onTime = buildDscFigureData({
      runs: [run],
      xAxis: "time",
      yAxis: "wattsPerGram",
      y2: "program",
      segmentMode: "active",
      labelFeatures: false,
      stackRuns: false,
      markers: NO_MARKERS,
    });
    const progSeries = onTime.series.filter((s) => s.id === "program:A");
    expect(progSeries).toHaveLength(1);
    expect(progSeries[0].styleHints?.axis).toBe("y2");
    expect(progSeries[0].styleHints?.lineStyle).toBe("dotted");
    expect(progSeries[0].legendHidden).toBe(true);

    // Program mode requested but the x-axis is temperature: the program
    // trace (temperature vs TIME) would be meaningless against a
    // temperature axis, so it is withheld — and so is the y2 axis itself.
    const onTemperature = buildDscFigureData({
      runs: [run],
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2: "program",
      segmentMode: "active",
      labelFeatures: false,
      stackRuns: false,
      markers: NO_MARKERS,
    });
    expect(onTemperature.series.filter((s) => s.id === "program:A")).toHaveLength(0);
    expect(onTemperature.y2Label).toBeUndefined();
  });

  it("omits y2Label (undefined, not empty string) when y2 is 'none'", () => {
    // Load-bearing: `useFigureOptions` creates/destroys `options.y2` off the
    // PRESENCE of `y2Label`, so an empty string would wrongly keep the axis.
    const run = makeRun("A", "#2563eb");
    const data = buildDscFigureData({
      runs: [run],
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2: "none",
      segmentMode: "active",
      labelFeatures: false,
      stackRuns: false,
      markers: NO_MARKERS,
    });
    expect(data.y2Label).toBeUndefined();
    expect(data.y2Label).not.toBe("");
  });

  it("marker series are legendHidden and grouped under 'Analysis markers'", () => {
    const run = makeRun("A", "#2563eb");
    const data = buildDscFigureData({
      runs: [run],
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2: "none",
      segmentMode: "active",
      labelFeatures: false,
      stackRuns: false,
      markers: ALL_MARKERS,
    });
    const markerSeries = data.series.filter((s) => s.group === "Analysis markers");
    expect(markerSeries.length).toBeGreaterThan(0);
    for (const s of markerSeries) {
      expect(s.legendHidden).toBe(true);
    }
  });

  it("peak labels are customText and carry the owning run·segment series id", () => {
    const run = makeRun("A", "#2563eb");
    const data = buildDscFigureData({
      runs: [run],
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2: "none",
      segmentMode: "active",
      labelFeatures: true,
      stackRuns: false,
      markers: ALL_MARKERS,
    });
    const labels = data.peakLabels ?? [];
    expect(labels.length).toBeGreaterThan(0);
    const expectedSeriesId = `dsc:A:${run.analysis.segmentId}`;
    for (const p of labels) {
      expect(p.customText).toBe(true);
      expect(p.seriesId).toBe(expectedSeriesId);
      expect(p.color).toBe("#2563eb");
    }
    // The Decimals control must never reformat a "ΔH 41.2 J/g"-style label —
    // that's exactly what customText:true guards against.
    expect(labels.some((p) => p.text.startsWith("ΔH "))).toBe(true);
  });

  it("always supplies peakLabels (possibly empty) so the maker's section appears", () => {
    const run = makeRun("A", "#2563eb");
    const data = buildDscFigureData({
      runs: [run],
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2: "none",
      segmentMode: "active",
      labelFeatures: false,
      stackRuns: false,
      markers: NO_MARKERS,
    });
    expect(Array.isArray(data.peakLabels)).toBe(true);
    expect(data.peakLabels).toHaveLength(0);
  });

  it("ΔH labels require BOTH labelFeatures and markers.enthalpyLabels", () => {
    const run = makeRun("A", "#2563eb");
    const onlyToggleOn = buildDscFigureData({
      runs: [run],
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2: "none",
      segmentMode: "active",
      labelFeatures: false, // master "Label transitions" switch is off
      stackRuns: false,
      markers: { ...NO_MARKERS, enthalpyLabels: true },
    });
    expect((onlyToggleOn.peakLabels ?? []).some((p) => p.text.startsWith("ΔH "))).toBe(false);
  });

  it("anchors the glass mark: vertical on the run's own curve, from the run floor up", () => {
    // A glass mark has no fitted "baseline" to span to (see `pushMark`'s
    // `bottomY` doc comment) — it keeps the original run-floor behaviour.
    const run = makeRun("A", "#2563eb");
    const data = buildDscFigureData({
      runs: [run],
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2: "none",
      segmentMode: "active",
      labelFeatures: true,
      stackRuns: false,
      markers: { ...NO_MARKERS, glassOnset: true },
    });
    const curve = data.series.find((s) => s.id === `dsc:A:${run.analysis.segmentId}`)!;
    const runMin = Math.min(...curve.y.filter((v) => Number.isFinite(v)));
    const verticals = data.series.filter((s) => s.id.startsWith("mark:"));
    expect(verticals.length).toBeGreaterThan(0);
    for (const v of verticals) {
      expect(v.x).toHaveLength(2);
      expect(v.x![0]).toBeCloseTo(v.x![1], 10);
      expect(v.y[0]).toBeCloseTo(runMin, 6);
      // The top sits ON the curve at that x, not at some fixed magic number.
      const xv = v.x![0];
      const i = curve.x!.findIndex((cx) => cx >= xv);
      expect(v.y[1]).toBeCloseTo(curve.y[i], 1);
    }
  });

  it("anchors a peak mark's vertical apex-to-baseline, not apex-to-run-floor, with the callout at the midpoint", () => {
    // The bug this pins: the melt's "Tm" mark used to run apex-to-run-floor,
    // dragging its callout to the bottom of the exported figure — the same
    // fix as the on-screen plot overlay's `pushPeakMarkers` (`lib/dsc/plot.ts`).
    const run = makeRun("A", "#2563eb");
    const data = buildDscFigureData({
      runs: [run],
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2: "none",
      segmentMode: "active",
      labelFeatures: true,
      stackRuns: false,
      markers: { ...NO_MARKERS, peakTemp: true },
    });
    const curve = data.series.find((s) => s.id === `dsc:A:${run.analysis.segmentId}`)!;
    const runMin = Math.min(...curve.y.filter((v) => Number.isFinite(v)));

    const result = run.analysis.results["A:melt1"];
    expect(result.kind).toBe("melt");
    const baseline = result.kind === "melt" ? result.peak.baseline : null;
    expect(baseline).not.toBeNull();

    const marks = data.series.filter((s) => s.id.startsWith("mark:") && s.id.endsWith(":peak"));
    expect(marks).toHaveLength(1);
    const [mark] = marks;
    const xv = mark.x![0];
    const expectedBottom = baseline!.slope * xv + baseline!.intercept;

    expect(mark.y[0]).toBeCloseTo(expectedBottom, 3);
    // Not the run floor any more — the span is much shorter than that.
    expect(Math.abs(mark.y[0] - runMin)).toBeGreaterThan(0.05);

    const label = (data.peakLabels ?? []).find((p) => p.id === `${mark.id}:lbl`);
    expect(label).toBeDefined();
    expect(label!.y).toBeCloseTo((mark.y[0] + mark.y[1]) / 2, 6);
  });

  it("withholds every marker and program series on a time x-axis", () => {
    const run = makeRun("A", "#2563eb");
    const data = buildDscFigureData({
      runs: [run],
      xAxis: "time",
      yAxis: "wattsPerGram",
      y2: "none",
      segmentMode: "active",
      labelFeatures: true,
      stackRuns: false,
      markers: ALL_MARKERS,
    });
    expect(data.series.filter((s) => s.group === "Analysis markers")).toHaveLength(0);
    expect(data.peakLabels).toHaveLength(0);
  });

  it("stacking lifts each run onto its own band, markers riding along with it", () => {
    const a = makeRun("A", "#2563eb");
    const b = makeRun("B", "#dc2626");
    const data = buildDscFigureData({
      runs: [a, b],
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2: "derivative",
      segmentMode: "active",
      labelFeatures: true,
      stackRuns: true,
      markers: { ...NO_MARKERS, glassOnset: true },
    });
    const ca = data.series.find((s) => s.id === `dsc:A:${a.analysis.segmentId}`)!;
    const cb = data.series.find((s) => s.id === `dsc:B:${b.analysis.segmentId}`)!;
    expect(Math.min(...cb.y.filter(Number.isFinite))).toBeGreaterThan(
      Math.max(...ca.y.filter(Number.isFinite)),
    );
    expect(ca.baseline).toBe(0);
    expect(cb.baseline).toBeGreaterThan(0);

    // The derivative stacks too, in its own y2 band.
    const da = data.series.find((s) => s.id === `deriv:A:${a.analysis.segmentId}`)!;
    const db = data.series.find((s) => s.id === `deriv:B:${b.analysis.segmentId}`)!;
    expect(Math.min(...db.y.filter(Number.isFinite))).toBeGreaterThan(
      Math.max(...da.y.filter(Number.isFinite)),
    );

    // B's onset marker rides in B's band, not A's: its vertical starts at
    // B's stack baseline, not at 0 or at A's.
    const markersB = data.series.filter((s) => s.group === "Analysis markers" && s.y[0] === cb.baseline);
    expect(markersB.length).toBeGreaterThan(0);
  });

  it("keeps every point of a run·segment up to a generous cap", () => {
    const run = makeRun("A", "#2563eb");
    const data = buildDscFigureData({
      runs: [run],
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2: "none",
      segmentMode: "active",
      labelFeatures: false,
      stackRuns: false,
      markers: NO_MARKERS,
    });
    const seg = run.segments[0];
    const activeLen = seg.end - seg.start;
    expect(data.series.find((s) => s.id === `dsc:A:${seg.id}`)!.y).toHaveLength(activeLen);
  });

  it("sourceName falls back to 'dsc' when no run is visible", () => {
    const data = buildDscFigureData({
      runs: [],
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2: "none",
      segmentMode: "active",
      labelFeatures: false,
      stackRuns: false,
      markers: NO_MARKERS,
    });
    expect(data.sourceName).toBe("dsc");
    expect(data.series).toHaveLength(0);
    expect(data.peakLabels).toHaveLength(0);
  });

  it("converts the primary curve between W/g and mW by the run's mass", () => {
    const run = makeRun("A", "#2563eb", { massMg: 10 });
    const wPerG = buildDscFigureData({
      runs: [run],
      xAxis: "temperature",
      yAxis: "wattsPerGram",
      y2: "none",
      segmentMode: "active",
      labelFeatures: false,
      stackRuns: false,
      markers: NO_MARKERS,
    });
    const mw = buildDscFigureData({
      runs: [run],
      xAxis: "temperature",
      yAxis: "milliwatts",
      y2: "none",
      segmentMode: "active",
      labelFeatures: false,
      stackRuns: false,
      markers: NO_MARKERS,
    });
    const curveWPerG = wPerG.series.find((s) => s.id.startsWith("dsc:A:"))!;
    const curveMw = mw.series.find((s) => s.id.startsWith("dsc:A:"))!;
    // W/g = mW / mg, so mW values should be ~10x the W/g values (mass = 10 mg).
    const idx = curveWPerG.y.findIndex((v) => Math.abs(v) > 0.05);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(curveMw.y[idx] / curveWPerG.y[idx]).toBeCloseTo(10, 5);
  });
});
