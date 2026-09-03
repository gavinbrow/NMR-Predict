// Adapter from the DSC store model to the on-screen plot's props (§WP4).
//
// Mirrors `lib/tga/plot.ts`'s role — the figure adapter (`lib/dsc/figure.ts`,
// WP5, built concurrently) shapes the publication figure; this module shapes
// what `DscPlot` draws. Keeping the shaping here rather than in the component
// means the x/y-mode switching, the gain/unit application, the marker
// geometry and the point-budget downsampling are all pure and unit-testable
// without a DOM — `DscPlot.tsx` only does uPlot wiring and canvas drawing.
//
// Unlike `lib/tga/plot.ts` (which leaves downsampling to the component),
// THIS module downsamples itself — the plan calls for `downsample` (from
// `@/lib/dsc/view`) to run here so the point budget is covered by a DOM-free
// test. A trace's primary (x, y) and secondary (x2, y2) series are decimated
// independently (exactly like TGA's `dtg` column), so they can pick
// different index subsets; `DscPlot`'s uPlot data builder reconciles that the
// same way TGA's `buildData` does — union the primary x grids, then resample
// every column (primary AND secondary) onto that union via linear
// interpolation, so misaligned decimation never desyncs the two axes.
//
// This module intentionally does NOT import `lib/dsc/figure.ts` — that file
// is being built concurrently by another work package and isn't a stable
// contract yet. The x/y/y2/segment-mode/marker-toggle types below are
// declared locally; they mirror `pages/Dsc.tsx`'s hoisted view-state names
// (`xAxis`, `yAxis`, `y2Mode`, `segmentMode`, `markers`) so the wiring step
// is a drop-in, EXCEPT `yAxis`: see this module's `DscPlotYAxis` doc comment
// for the one deliberate mismatch with `Dsc.tsx`'s current placeholder type.

import {
  computeDerivative,
  segmentView,
  type DscAnalysis,
  type GlassResult,
  type PeakResult,
} from "./compute";
import { interp1d } from "./numerics";
import { downsample } from "./view";
import type { DscFeature, DscFeatureKind, DscParams, DscRun, DscSegment } from "./types";
import type { DscRunAnalyzed } from "./store";

// ---------------------------------------------------------------------------
// View-state types
// ---------------------------------------------------------------------------

/** X-axis quantity. Matches `Dsc.tsx`'s hoisted `DscXAxis` exactly. */
export type DscPlotXAxis = "temperature" | "time";

/**
 * Primary y-axis unit — heat flow per gram, or raw milliwatts (§WP4: "y
 * toggle Heat flow (W/g) ⇄ Heat flow (mW)").
 *
 * ⚠️ `Dsc.tsx` (WP0, already landed) currently declares a DIFFERENT local
 * `DscYAxis = "heatFlow" | "heatFlowDeriv"` — a curve-select between the raw
 * value and its derivative. That predates this work package's design: the
 * derivative is exclusively a Y2 concern here (`DscPlotY2Mode`), and the
 * primary axis only ever shows heat flow, in one of two units. The wiring
 * step must replace `Dsc.tsx`'s `DscYAxis` alias (and its `yAxis` `useState`
 * default `"heatFlow"`) with this type and a `"wattsPerGram"` default — see
 * this file's header and the WP4 completion report for the exact diff.
 */
export type DscPlotYAxis = "wattsPerGram" | "milliwatts";

/**
 * Secondary (right-hand) axis toggle. Matches `Dsc.tsx`'s hoisted
 * `DscY2Mode` exactly — a single on/off switch, not a 3-way selector: per
 * §WP4, content is chosen FROM `xAxis` when it's "on" (`"derivative"`),
 * never asked for separately. dHF/dT when `xAxis === "temperature"`, the
 * temperature program when `xAxis === "time"`.
 */
export type DscPlotY2Mode = "off" | "derivative";

/** Matches `Dsc.tsx`'s hoisted `DscSegmentMode` exactly. */
export type DscPlotSegmentMode = "active" | "all";

/** Matches `Dsc.tsx`'s hoisted `DscMarkerToggles` exactly: one toggle per
 *  `DscFeatureKind` except `"custom"` — a user-placed feature has no
 *  kind-level toggle and is always shown — plus three marker-FAMILY toggles
 *  that cut across every kind: `baselines` (`sub: "baseline"` lines),
 *  `tangents` (`sub: "tangent"` lines), and `enthalpyLabels` (the "ΔH …"
 *  callout). All three default to `false` in `Dsc.tsx`'s
 *  `DEFAULT_PLOT_MARKERS` — a fresh analysis should show the transition
 *  callouts (Tg/Tm/…) without also drawing every fitted baseline/tangent/ΔH
 *  the user hasn't asked to see. Mirrors `lib/dsc/figure.ts`'s
 *  `DscMarkerToggles`, which already had these three (see that file's own
 *  doc comment). */
export type DscMarkerToggles = Record<Exclude<DscFeatureKind, "custom">, boolean> & {
  baselines: boolean;
  tangents: boolean;
  enthalpyLabels: boolean;
};

/** Point budget per decimated series before the min/max-envelope
 *  `downsample` kicks in. A 2nd-heat segment can be ~16 800 points and a
 *  workspace can hold several runs × several segments in "all" mode. */
export const DEFAULT_MAX_PLOT_POINTS = 2000;

// ---------------------------------------------------------------------------
// Axis labels
// ---------------------------------------------------------------------------

export function dscPlotXLabel(xAxis: DscPlotXAxis): string {
  return xAxis === "temperature" ? "Temperature (°C)" : "Time (min)";
}

/** Primary y-axis label. Carries the "↑ Exo" / "↓ Exo" suffix per §3.2 when
 *  `showExoArrow` is on — `exoUp` is `params.exoUp`, the display convention,
 *  not any one run's file convention (the arrow describes what "up" means
 *  for the whole plot). */
export function dscPlotYLabel(yAxis: DscPlotYAxis, exoUp: boolean, showExoArrow: boolean): string {
  const base = yAxis === "wattsPerGram" ? "Heat flow (W/g)" : "Heat flow (mW)";
  if (!showExoArrow) return base;
  return `${base} ${exoUp ? "↑ Exo" : "↓ Exo"}`;
}

/** Secondary y-axis label. Empty when the axis is off — `DscPlot` hides the
 *  axis on an empty label, mirroring `TgaPlot`'s `show: showDtg`. Content
 *  follows `xAxis`, never asked for separately (see `DscPlotY2Mode`). */
export function dscPlotY2Label(y2Mode: DscPlotY2Mode, xAxis: DscPlotXAxis): string {
  if (y2Mode === "off") return "";
  return xAxis === "temperature" ? "dHF/dT (W/g·°C)" : "Temperature (°C)";
}

// ---------------------------------------------------------------------------
// Gain / unit helpers
// ---------------------------------------------------------------------------

/** The sample mass (mg) that normalized this run's heat flow, or `null` when
 *  the run is displayed raw (no mass, or `params.normMode === "raw"`).
 *  Mirrors `compute.ts`'s private `resolveSampleMassMg` + its
 *  `normDivisorMg` gate — duplicated here (rather than imported) because
 *  neither is exported; both are single-expression reads of public fields. */
function resolveNormDivisorMg(run: DscRun, params: DscParams): number | null {
  if (params.normMode !== "wattsPerGram") return null;
  const mass = run.massOverrideMg ?? run.meta.sampleMassMg;
  return mass != null && Number.isFinite(mass) && mass > 0 ? mass : null;
}

/**
 * Multiplier converting a `SegmentView.heatFlow` sample (already normalized
 * + sign-applied per `params.normMode`) into the plot's requested display
 * unit.
 *  - Requesting `"wattsPerGram"`: the view is already W/g when
 *    `normDivisorMg != null`; when it's `null` (no mass — the view is
 *    already raw mW) there is nothing to convert FROM, so this passes the
 *    raw value through unchanged rather than fabricating a number.
 *  - Requesting `"milliwatts"`: multiply back by the mass that normalized it
 *    (`W/g * mg = mW`); when the view was never normalized it's already mW.
 */
function heatFlowUnitScale(normDivisorMg: number | null, yAxis: DscPlotYAxis): number {
  if (yAxis === "wattsPerGram") return 1;
  return normDivisorMg != null ? normDivisorMg : 1;
}

/** `v * unitScale * scale + offset` — unit conversion composed with the
 *  run's display gain, applied identically to a scalar or an array so a
 *  marker anchor and its owning trace agree exactly. */
function toDisplay(raw: number, unitScale: number, scale: number, offset: number): number {
  return raw * unitScale * scale + offset;
}

function applyDisplayArray(src: Float64Array, unitScale: number, scale: number, offset: number): Float64Array {
  if (unitScale === 1 && scale === 1 && offset === 0) return src;
  const out = new Float64Array(src.length);
  for (let i = 0; i < src.length; i += 1) out[i] = src[i] * unitScale * scale + offset;
  return out;
}

function evalLine(line: { slope: number; intercept: number }, x: number): number {
  return line.slope * x + line.intercept;
}

/** The segments to draw for one run under the current segment mode: just the
 *  active one, or every segment (§WP4 "all"). */
function segmentsForMode(run: DscRunAnalyzed, segmentMode: DscPlotSegmentMode): DscSegment[] {
  if (segmentMode === "active") {
    const seg = run.segments.find((s) => s.id === run.analysis.segmentId);
    return seg ? [seg] : [];
  }
  return run.segments;
}

// ---------------------------------------------------------------------------
// Traces
// ---------------------------------------------------------------------------

/** One curve `DscPlot` draws. `y` (and `y2`, when present) are already
 *  gain/unit-adjusted by this module — the component never re-applies a
 *  run's scale/offset, so what it draws is exactly what the figure adapter
 *  (WP5) would build for the same inputs. `x`/`y` and `x2`/`y2` are each
 *  independently downsampled (see this file's header) so they may not share
 *  an index basis; `DscPlot` reconciles them via a union grid + resample,
 *  exactly like `TgaPlot` does for its DTG column. */
export interface DscPlotTrace {
  id: string; // `${run.id}:${segment.id}`
  runId: string;
  segmentId: string;
  label: string;
  color: string;
  visible: boolean;
  /** Cooling segments are dashed in "all" segment mode (§WP4). */
  dashed: boolean;
  x: Float64Array;
  y: Float64Array;
  x2: Float64Array | null;
  y2: Float64Array | null;
}

export interface BuildDscPlotTracesArgs {
  runs: DscRunAnalyzed[];
  params: DscParams;
  xAxis: DscPlotXAxis;
  yAxis: DscPlotYAxis;
  y2Mode: DscPlotY2Mode;
  segmentMode: DscPlotSegmentMode;
  /** Point budget per decimated series; defaults to `DEFAULT_MAX_PLOT_POINTS`. */
  maxPoints?: number;
}

/**
 * One plot trace per run (segment mode "active") or per run×segment (mode
 * "all"). Hidden runs are still included, flagged `visible: false`, so the
 * plot's legend order stays stable as they toggle — mirrors
 * `buildTgaPlotTraces`.
 */
export function buildDscPlotTraces(args: BuildDscPlotTracesArgs): DscPlotTrace[] {
  const { runs, params, xAxis, yAxis, y2Mode, segmentMode, maxPoints = DEFAULT_MAX_PLOT_POINTS } = args;
  const out: DscPlotTrace[] = [];

  for (const run of runs) {
    const segments = segmentsForMode(run, segmentMode);
    const normDivisorMg = resolveNormDivisorMg(run, params);
    const unitScale = heatFlowUnitScale(normDivisorMg, yAxis);

    for (const segment of segments) {
      const view = segmentView(run, segment, params);
      if (view.tempC.length < 2) continue; // too little data to draw

      const xFull = xAxis === "temperature" ? view.tempC : view.timeMin;
      const yFull = applyDisplayArray(view.heatFlow, unitScale, run.scale, run.offset);
      const primary = downsample({ x: xFull, y: yFull }, maxPoints);

      let secondary: { x: Float64Array; y: Float64Array } | null = null;
      if (y2Mode === "derivative") {
        if (xAxis === "temperature") {
          // The derivative is scaled but NEVER offset — d/dT of a constant
          // offset is zero (copies TGA's rule, and `compute.ts`'s own §3.3
          // doc comment). No unit conversion either: the axis always reads
          // "W/g·°C" regardless of the primary unit toggle.
          const deriv = computeDerivative(view, view.smoothWindow);
          const y2Full = applyDisplayArray(deriv, 1, run.scale, 0);
          secondary = downsample({ x: xFull, y: y2Full }, maxPoints);
        } else {
          // Temperature program trace: a different physical quantity than
          // heat flow, so the run's gain does not apply to it.
          secondary = downsample({ x: xFull, y: view.tempC }, maxPoints);
        }
      }

      out.push({
        id: `${run.id}:${segment.id}`,
        runId: run.id,
        segmentId: segment.id,
        label: segmentMode === "all" ? `${run.label} · ${segment.label}` : run.label,
        color: run.color,
        visible: run.visible,
        dashed: segmentMode === "all" && segment.kind === "cool",
        x: primary.x,
        y: primary.y,
        x2: secondary ? secondary.x : null,
        y2: secondary ? secondary.y : null,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

/** A two-point line: a peak's baseline, or a glass/peak tangent. */
export interface DscPlotMarkerLine {
  id: string;
  kind: "line";
  sub: "baseline" | "tangent";
  color: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A vertical drop-line at one x (onset/midpoint/peak/endset), anchored on
 *  the owning run's own curve where available, and — when the feature has a
 *  fitted baseline to stop at — running only as far as `y2` rather than all
 *  the way to the plot floor. Without `y2`, `DscPlot` draws to the floor
 *  exactly as before (glass verticals, and a peak with no fitted baseline
 *  yet). With it, the line spans apex-to-baseline: for an endothermic melt
 *  in exo-up (a trough), that keeps the `Tm` line and its callout anchored
 *  ON the peak instead of running off to the bottom axis (§ "Tm sits at the
 *  bottom of the chart" fix). */
export interface DscPlotMarkerVertical {
  id: string;
  kind: "vertical";
  sub: "onset" | "midpoint" | "peak" | "endset";
  color: string;
  x: number;
  y?: number;
  y2?: number;
}

/** A standalone text callout ("Tg 62.4 °C", "ΔH 41.2 J/g", "Xc 28 %"), not
 *  tied to a line. */
export interface DscPlotMarkerLabel {
  id: string;
  kind: "label";
  color: string;
  x: number;
  y: number;
  text: string;
}

export type DscPlotMarker = DscPlotMarkerLine | DscPlotMarkerVertical | DscPlotMarkerLabel;

export interface BuildDscPlotMarkersArgs {
  runs: DscRunAnalyzed[];
  params: DscParams;
  xAxis: DscPlotXAxis;
  yAxis: DscPlotYAxis;
  markers: DscMarkerToggles;
}

const PEAK_KIND_LABEL: Partial<Record<DscFeatureKind, string>> = {
  melt: "Tm",
  crystallization: "Tc",
  coldCrystallization: "Tcc",
  cure: "Tcure",
  custom: "T",
};

/** Draw the glass-transition markers: up to three tangents (pre/post/infl),
 *  onset/midpoint/endset verticals, and a "Tg …" callout at the midpoint. */
function pushGlassMarkers(
  out: DscPlotMarker[],
  run: DscRunAnalyzed,
  feature: DscFeature,
  glass: GlassResult,
  toY: (raw: number) => number,
  curveAt: (x: number) => number | undefined,
  markers: DscMarkerToggles,
): void {
  const id = feature.id;
  const color = run.color;
  const wLo = Math.min(feature.window[0], feature.window[1]);
  const wHi = Math.max(feature.window[0], feature.window[1]);

  if (markers.tangents && glass.preLine && glass.onsetC != null) {
    out.push({
      id: `${id}:tangent:pre`,
      kind: "line",
      sub: "tangent",
      color,
      x0: wLo,
      y0: toY(evalLine(glass.preLine, wLo)),
      x1: glass.onsetC,
      y1: toY(evalLine(glass.preLine, glass.onsetC)),
    });
  }
  if (markers.tangents && glass.postLine && glass.endsetC != null) {
    out.push({
      id: `${id}:tangent:post`,
      kind: "line",
      sub: "tangent",
      color,
      x0: glass.endsetC,
      y0: toY(evalLine(glass.postLine, glass.endsetC)),
      x1: wHi,
      y1: toY(evalLine(glass.postLine, wHi)),
    });
  }
  if (markers.tangents && glass.inflLine && glass.inflectionC != null) {
    const halfSpan = Math.max(1, (wHi - wLo) * 0.05);
    out.push({
      id: `${id}:tangent:infl`,
      kind: "line",
      sub: "tangent",
      color,
      x0: glass.inflectionC - halfSpan,
      y0: toY(evalLine(glass.inflLine, glass.inflectionC - halfSpan)),
      x1: glass.inflectionC + halfSpan,
      y1: toY(evalLine(glass.inflLine, glass.inflectionC + halfSpan)),
    });
  }
  // No `y2` on the glass verticals — unlike a peak's baseline, `preLine`/
  // `postLine` evaluated AT onsetC/endsetC lands essentially on the curve
  // itself (that's how onset/endset are defined: where preLine/postLine
  // cross the inflection tangent), so it would draw a near-zero-length line
  // rather than the "span the transition" geometry the peak fix needs.
  if (glass.onsetC != null) {
    out.push({ id: `${id}:v:onset`, kind: "vertical", sub: "onset", color, x: glass.onsetC, y: curveAt(glass.onsetC) });
  }
  if (glass.endsetC != null) {
    out.push({ id: `${id}:v:endset`, kind: "vertical", sub: "endset", color, x: glass.endsetC, y: curveAt(glass.endsetC) });
  }
  if (glass.midpointC != null) {
    const y = curveAt(glass.midpointC);
    out.push({ id: `${id}:v:midpoint`, kind: "vertical", sub: "midpoint", color, x: glass.midpointC, y });
    out.push({
      id: `${id}:label`,
      kind: "label",
      color,
      x: glass.midpointC,
      y: y ?? 0,
      text: `Tg ${glass.midpointC.toFixed(1)} °C`,
    });
  }
}

/** Draw one peak-shaped feature's markers (melt/crystallization/cold
 *  crystallization/cure/custom): the baseline, the two flank tangents
 *  (approximated as baseline-crossing → apex, since `peakTransition` only
 *  returns the tangent/baseline INTERSECTION, not the tangent line itself),
 *  onset/peak/endset verticals, and "T… …" + "ΔH …" callouts. */
function pushPeakMarkers(
  out: DscPlotMarker[],
  run: DscRunAnalyzed,
  feature: DscFeature,
  peak: PeakResult,
  toY: (raw: number) => number,
  curveAt: (x: number) => number | undefined,
  markers: DscMarkerToggles,
): void {
  const id = feature.id;
  const color = run.color;
  const wLo = Math.min(feature.window[0], feature.window[1]);
  const wHi = Math.max(feature.window[0], feature.window[1]);

  // The feature's own baseline evaluated at `x` — the vertical's `y2` (§ "Tm
  // sits at the bottom of the chart" fix): a peak/onset/endset line now
  // stops here instead of running to the plot floor. `undefined` (no fitted
  // baseline yet) falls back to `DscPlot`'s original floor behaviour.
  const baselineY = (x: number): number | undefined => (peak.baseline ? toY(evalLine(peak.baseline, x)) : undefined);

  if (peak.baseline) {
    if (markers.baselines) {
      out.push({
        id: `${id}:baseline`,
        kind: "line",
        sub: "baseline",
        color,
        x0: wLo,
        y0: toY(evalLine(peak.baseline, wLo)),
        x1: wHi,
        y1: toY(evalLine(peak.baseline, wHi)),
      });
    }
    if (markers.tangents) {
      if (peak.onsetC != null && peak.peakC != null) {
        out.push({
          id: `${id}:tangent:lead`,
          kind: "line",
          sub: "tangent",
          color,
          x0: peak.onsetC,
          y0: toY(evalLine(peak.baseline, peak.onsetC)),
          x1: peak.peakC,
          y1: curveAt(peak.peakC) ?? toY(evalLine(peak.baseline, peak.peakC)),
        });
      }
      if (peak.endsetC != null && peak.peakC != null) {
        out.push({
          id: `${id}:tangent:trail`,
          kind: "line",
          sub: "tangent",
          color,
          x0: peak.peakC,
          y0: curveAt(peak.peakC) ?? toY(evalLine(peak.baseline, peak.peakC)),
          x1: peak.endsetC,
          y1: toY(evalLine(peak.baseline, peak.endsetC)),
        });
      }
    }
  }
  if (peak.onsetC != null) {
    out.push({
      id: `${id}:v:onset`,
      kind: "vertical",
      sub: "onset",
      color,
      x: peak.onsetC,
      y: curveAt(peak.onsetC),
      y2: baselineY(peak.onsetC),
    });
  }
  if (peak.endsetC != null) {
    out.push({
      id: `${id}:v:endset`,
      kind: "vertical",
      sub: "endset",
      color,
      x: peak.endsetC,
      y: curveAt(peak.endsetC),
      y2: baselineY(peak.endsetC),
    });
  }
  if (peak.peakC != null) {
    const y = curveAt(peak.peakC);
    const y2 = baselineY(peak.peakC);
    out.push({ id: `${id}:v:peak`, kind: "vertical", sub: "peak", color, x: peak.peakC, y, y2 });
    const label = PEAK_KIND_LABEL[feature.kind] ?? "T";
    // Midway down the apex-to-baseline span, not at the apex — "midway down
    // the slope", per the fix — when there's a baseline to span; otherwise
    // the same apex anchor as before.
    const labelY = y != null && y2 != null ? (y + y2) / 2 : (y ?? 0);
    out.push({
      id: `${id}:label:peak`,
      kind: "label",
      color,
      x: peak.peakC,
      y: labelY,
      text: `${label} ${peak.peakC.toFixed(1)} °C`,
    });
  }
  if (peak.enthalpyJPerG != null && markers.enthalpyLabels) {
    const atX = peak.peakC ?? (wLo + wHi) / 2;
    const y = curveAt(atX) ?? 0;
    out.push({ id: `${id}:label:dh`, kind: "label", color, x: atX, y, text: `ΔH ${peak.enthalpyJPerG.toFixed(1)} J/g` });
  }
}

/** Draw one OIT feature's onset vertical and "OIT … min" callout. Time
 *  domain — meaningful only on the time x-axis (§WP4). */
function pushOitMarkers(
  out: DscPlotMarker[],
  run: DscRunAnalyzed,
  feature: DscFeature,
  oit: { onsetMin: number | null; oitMin: number | null },
  curveAtTime: (t: number) => number | undefined,
): void {
  const id = feature.id;
  const color = run.color;
  if (oit.onsetMin == null) return;
  const y = curveAtTime(oit.onsetMin);
  out.push({ id: `${id}:v:onset`, kind: "vertical", sub: "onset", color, x: oit.onsetMin, y });
  const text = oit.oitMin != null ? `OIT ${oit.oitMin.toFixed(1)} min` : `OIT onset ${oit.onsetMin.toFixed(1)} min`;
  out.push({ id: `${id}:label`, kind: "label", color, x: oit.onsetMin, y: y ?? 0, text });
}

/**
 * The analysis marker overlay for the plot (§WP4). Features are read from
 * the run's ACTIVE segment only — `computeDscAnalysis` never analyzes any
 * other segment (§WP3), so a marker in "all" segment mode would have no
 * result to draw regardless. A feature's kind gates it through `markers`
 * except `"custom"`, which has no kind-level toggle and is always drawn
 * (mirrors `Dsc.tsx`'s `DscMarkerToggles` doc comment).
 *
 * Temperature-domain features (glass/melt/crystallization/cold
 * crystallization/cure/custom) are withheld when `xAxis === "time"`; the
 * time-domain OIT feature is withheld when `xAxis === "temperature"` — the
 * mirror image of `buildTgaPlotMarkers`' temperature-only rule, extended to
 * a feature kind that lives on the OTHER axis instead of just being
 * unconditionally axis-agnostic.
 */
export function buildDscPlotMarkers(args: BuildDscPlotMarkersArgs): DscPlotMarker[] {
  const { runs, params, xAxis, yAxis, markers } = args;
  const out: DscPlotMarker[] = [];

  for (const run of runs) {
    if (!run.visible) continue;
    const { analysis } = run;
    const view = analysis.view;
    if (view.tempC.length === 0) continue;

    const normDivisorMg = resolveNormDivisorMg(run, params);
    const unitScale = heatFlowUnitScale(normDivisorMg, yAxis);
    const toY = (raw: number) => toDisplay(raw, unitScale, run.scale, run.offset);
    const curveAt = (x: number): number | undefined => {
      const raw = interp1d(x, view.tempC, view.heatFlow);
      return Number.isFinite(raw) ? toY(raw) : undefined;
    };
    // OIT's segment is always isothermal (temperature ~constant, never
    // reversed — §3.1's `reversed` flag is decided by comparing the segment's
    // FIRST and LAST temperature, which are equal on a hold), so
    // `view.timeMin` is guaranteed ascending here, same as `interp1d` needs.
    const curveAtTime = (t: number): number | undefined => {
      const raw = interp1d(t, view.timeMin, view.heatFlow);
      return Number.isFinite(raw) ? toY(raw) : undefined;
    };

    const features = run.features.filter((f) => f.segmentId === analysis.segmentId);
    for (const feature of features) {
      const kind = feature.kind;
      if (kind !== "custom" && !markers[kind]) continue;
      const result = analysis.results[feature.id];
      if (!result) continue;

      if (result.kind === "glass") {
        if (xAxis !== "temperature") continue;
        pushGlassMarkers(out, run, feature, result.glass, toY, curveAt, markers);
      } else if (result.kind === "oit") {
        if (xAxis !== "time") continue;
        pushOitMarkers(out, run, feature, result.oit, curveAtTime);
      } else {
        if (xAxis !== "temperature") continue;
        pushPeakMarkers(out, run, feature, result.peak, toY, curveAt, markers);
      }
    }

    // % crystallinity is a run-level stat (derived from melt + cold
    // crystallization, §3.7), not a single feature's own result, so it gets
    // one callout per run rather than one per feature. Gated on the melt
    // toggle since that's the feature it's computed alongside.
    if (
      markers.melt &&
      xAxis === "temperature" &&
      analysis.crystallinityPct != null &&
      analysis.melt?.peakC != null
    ) {
      const x = analysis.melt.peakC;
      out.push({
        id: `${run.id}:label:xc`,
        kind: "label",
        color: run.color,
        x,
        y: curveAt(x) ?? 0,
        text: `Xc ${analysis.crystallinityPct.toFixed(0)} %`,
      });
    }
  }

  return out;
}

// Re-exported so callers that only need the analysis shape don't have to
// reach into `./compute` directly for it.
export type { DscAnalysis };
