// Unit tests for the DSC compute engine (§WP3).
//
// Fixtures are a synthetic curve = a linear baseline + a Gaussian endotherm
// (melt, analytically known area) + a tanh step (glass transition,
// analytically known height), sampled on a realistic 10 °C/min grid. Because
// the shape is analytic, every physical quantity the compute engine reports
// (enthalpy, peak location, Δcp) has a known closed-form answer to check
// against — no mocking, just arithmetic.

import { describe, expect, it } from "vitest";
import {
  autoDetectFeatures,
  computeDerivative,
  computeDscAnalysis,
  crystallinity,
  degreeOfCure,
  exoDisplaySign,
  glassTransition,
  oxidativeInductionTime,
  peakTransition,
  segmentView,
  toWattsPerGram,
} from "../compute";
import { DEFAULT_PARAMS, type DscRun, type DscSegment } from "../types";

// ---------------------------------------------------------------------------
// Synthetic curve builder
// ---------------------------------------------------------------------------

interface CurveOpts {
  t0C: number;
  t1C: number;
  dTc: number; // grid spacing, °C
  rateCPerMin: number;
  baseline0: number;
  baselineSlope: number;
  gaussPeakC: number;
  gaussSigmaC: number;
  gaussAmpWPerG: number; // negative = endothermic (melt) in exo-up convention
  stepCenterC: number;
  stepWidthC: number;
  stepHeightWPerG: number; // >= 0; 0 disables the step entirely
  sampleMassMg: number;
  exoDirection?: "up" | "down";
  /** Small high-frequency ripple riding on top of the whole curve, in W/g —
   *  0 (the default for every existing fixture) disables it entirely. Real
   *  instrument signal is never perfectly smooth; a broad peak's shoulder
   *  needs only a little of this to create genuine sample-to-sample local
   *  extrema, which is what `detectPeakCandidates`'s window-claiming bug
   *  (fixed alongside this fixture) actually bites on — see the "does not
   *  re-detect a broad peak off its own noisy shoulder" test below. */
  rippleAmpWPerG?: number;
  ripplePeriodC?: number;
  /** Quadratic curvature about the segment's own midpoint, W/(g·°C²) — 0 (the
   *  default for every existing fixture) disables it. `detectPeakCandidates`'
   *  baseline (§3.6) is a straight two-point line, which cancels
   *  `baselineSlope` exactly but leaves this term's curvature behind as a
   *  single symmetric bulge peaking at the segment's midpoint — the
   *  synthetic stand-in for `MAX_PEAK_SPAN_FRACTION`'s real-file bug (see
   *  that constant's doc comment): a gently curved real baseline with no
   *  actual transition, misread as one enormous peak. */
  baselineCurvWPerGC2?: number;
}

/** baseline(T) + a Gaussian endotherm/exotherm + a tanh glass-transition
 *  step + an optional tiny high-frequency ripple + an optional quadratic
 *  curvature term, all in W/g. `sampleMassMg` is always 1 in these fixtures
 *  so the raw mW array below can hold these W/g values directly (mW / 1 mg =
 *  numerically identical), keeping the arithmetic transparent. */
function heatFlowAt(T: number, o: CurveOpts): number {
  const baseline = o.baseline0 + o.baselineSlope * T;
  const gauss = o.gaussAmpWPerG * Math.exp(-((T - o.gaussPeakC) ** 2) / (2 * o.gaussSigmaC ** 2));
  const step = (o.stepHeightWPerG / 2) * (1 + Math.tanh((T - o.stepCenterC) / o.stepWidthC));
  const ripple = o.rippleAmpWPerG ? o.rippleAmpWPerG * Math.sin((2 * Math.PI * T) / (o.ripplePeriodC ?? 1)) : 0;
  const mid = (o.t0C + o.t1C) / 2;
  const curv = o.baselineCurvWPerGC2 ? o.baselineCurvWPerGC2 * (T - mid) ** 2 : 0;
  return baseline + gauss + step + ripple + curv;
}

/** Analytic |ΔH| of the Gaussian term alone, in J/g, integrated over all T
 *  (the window used in tests is wide enough — ±6σ — that the truncated tail
 *  is negligible next to the 1 % tolerance). Enthalpy integrates against
 *  TIME (§3.5.4): dT = rateCPerMin * dt(min), so ∫P dT = (60/rate)∫P dt(sec). */
function analyticGaussianEnthalpyJPerG(o: CurveOpts): number {
  return (60 / o.rateCPerMin) * Math.abs(o.gaussAmpWPerG) * o.gaussSigmaC * Math.sqrt(2 * Math.PI);
}

let runCounter = 0;

/**
 * Build a run with a single segment covering `[t0C, t1C]` at `rateCPerMin`.
 * `direction: "heat"` samples temperature ascending with index (the ordinary
 * case); `direction: "cool"` samples it DESCENDING with index — i.e. the
 * run's raw acquisition order runs from `t1C` down to `t0C` — while time
 * still only ever increases with index, exactly like a real cooling ramp.
 */
function makeRun(direction: "heat" | "cool", o: CurveOpts): DscRun {
  runCounter += 1;
  const id = `run${runCounter}`;
  const steps = Math.round((o.t1C - o.t0C) / o.dTc);
  const n = steps + 1;
  const dtMin = o.dTc / o.rateCPerMin;

  const timeMin = new Float64Array(n);
  const tempC = new Float64Array(n);
  const heatFlowMw = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const T = direction === "heat" ? o.t0C + i * o.dTc : o.t1C - i * o.dTc;
    timeMin[i] = i * dtMin;
    tempC[i] = T;
    heatFlowMw[i] = heatFlowAt(T, o);
  }

  const segment: DscSegment = {
    id: `${id}:seg0`,
    label: direction === "heat" ? `Ramp ${o.rateCPerMin} °C/min to ${o.t1C} °C` : `Ramp ${o.rateCPerMin} °C/min to ${o.t0C} °C`,
    kind: direction,
    rateCPerMin: o.rateCPerMin,
    ordinal: 1,
    cycle: 1,
    start: 0,
    end: n,
    tStartC: tempC[0],
    tEndC: tempC[n - 1],
    timeStartMin: timeMin[0],
    timeEndMin: timeMin[n - 1],
  };

  return {
    label: "Synthetic",
    meta: {
      instrument: "DSC25",
      operator: "Test",
      sampleName: "Synthetic",
      sampleMassMg: o.sampleMassMg,
      panMassMg: 0,
      pan: "Tzero Aluminum Hermetic",
      methodSteps: [segment.label],
      runDate: "9/2/2026",
      gases: "Nitrogen, 50 mL/min",
      cooler: "RCS 90",
      cellConstant: "-23.6 mW/°C",
      sampleInterval: "0.1 s/pt",
      exoDirection: o.exoDirection ?? "up",
    },
    segments: [segment],
    timeMin,
    tempC,
    heatFlowMw,
    id,
    fileId: `${id}:file`,
    fileName: "synthetic.tri",
    color: "#000000",
    scale: 1,
    offset: 0,
    visible: true,
    materialId: null,
    activeSegmentId: segment.id,
    massOverrideMg: null,
    polymerFraction: 1,
    referenceId: null,
    features: [],
  };
}

/** A large, well-separated melt (Gaussian at 180 °C) and glass step (tanh at
 *  80 °C) on one heating ramp, spanning 40-260 °C at 10 °C/min. The two
 *  features are ~100 °C apart so neither's baseline/window interferes with
 *  the other's. */
const COMBINED: CurveOpts = {
  t0C: 40,
  t1C: 260,
  dTc: 0.05,
  rateCPerMin: 10,
  baseline0: 0.02,
  baselineSlope: 0.0001,
  gaussPeakC: 180,
  gaussSigmaC: 5,
  gaussAmpWPerG: -2, // endothermic melt
  stepCenterC: 80,
  stepWidthC: 3,
  stepHeightWPerG: 0.06,
  sampleMassMg: 1,
};

const MELT_WINDOW: [number, number] = [
  COMBINED.gaussPeakC - 6 * COMBINED.gaussSigmaC,
  COMBINED.gaussPeakC + 6 * COMBINED.gaussSigmaC,
];
const GLASS_WINDOW: [number, number] = [
  COMBINED.stepCenterC - 8 * COMBINED.stepWidthC,
  COMBINED.stepCenterC + 8 * COMBINED.stepWidthC,
];

/** A BROAD melt (σ = 25 °C, comparable to the ~114 °C FWHM measured on the
 *  real `DAC1.tri` fixture) with a tiny high-frequency ripple riding its
 *  shoulder, no glass step, spanning 20-300 °C at 10 °C/min. Real DSC
 *  data is never perfectly smooth; this reproduces just enough
 *  sample-to-sample non-monotonicity on the shoulder — while the ripple's
 *  own amplitude (0.02 W/g) stays far below the peak-detection floor — to
 *  pin the bug the real file exposed: a peak whose true 10 %-cutoff window
 *  is far wider than `minSep` used to get "rediscovered" off its own
 *  shoulder as several near-duplicate features. */
const BROAD_NOISY_MELT: CurveOpts = {
  t0C: 20,
  t1C: 300,
  dTc: 0.05,
  rateCPerMin: 10,
  baseline0: 0.02,
  baselineSlope: 0,
  gaussPeakC: 120,
  gaussSigmaC: 25,
  gaussAmpWPerG: -2,
  stepCenterC: -1000, // far outside the range — irrelevant with stepHeightWPerG 0
  stepWidthC: 3,
  stepHeightWPerG: 0,
  sampleMassMg: 1,
  rippleAmpWPerG: 0.002,
  ripplePeriodC: 0.6,
};

/** A small, isolated Gaussian endotherm with no glass step — used to test
 *  the `minPeakEnthalpy` gate in isolation. */
const SMALL_PEAK: CurveOpts = {
  t0C: 40,
  t1C: 140,
  dTc: 0.05,
  rateCPerMin: 10,
  baseline0: 0.01,
  baselineSlope: 0,
  gaussPeakC: 90,
  gaussSigmaC: 2,
  gaussAmpWPerG: -0.05,
  stepCenterC: 90,
  stepWidthC: 1,
  stepHeightWPerG: 0, // no step
  sampleMassMg: 1,
};

/** No Gaussian, no step — just a gently CURVED baseline (quadratic bulge,
 *  see `CurveOpts.baselineCurvWPerGC2`'s doc comment) over a 280 °C ramp, the
 *  synthetic stand-in for real curvature-only segments like DAC2.tri's
 *  monotone 2nd heat. `detectPeakCandidates`' straight two-point baseline
 *  cannot cancel this shape, so it reads as one huge candidate spanning
 *  nearly the whole segment — exactly the shape `MAX_PEAK_SPAN_FRACTION`
 *  exists to reject. There is nothing here to find; "no feature detected" is
 *  the correct answer. */
const CURVED_BASELINE_ONLY: CurveOpts = {
  t0C: 0,
  t1C: 280,
  dTc: 0.1,
  rateCPerMin: 10,
  baseline0: -0.2,
  baselineSlope: 0,
  gaussPeakC: 140,
  gaussSigmaC: 5,
  gaussAmpWPerG: 0, // no real peak
  stepCenterC: 140,
  stepWidthC: 3,
  stepHeightWPerG: 0, // no real step
  sampleMassMg: 1,
  baselineCurvWPerGC2: -1e-5,
};

/**
 * A heating ramp carrying a normal melt (Gaussian at 180 °C, same shape as
 * `COMBINED`) PLUS a sharp exothermic transient confined to the first couple
 * of °C of the ramp — a stand-in for a real DSC instrument's start-of-ramp
 * thermal lag (it takes a few tens of seconds for the furnace to settle into
 * the new rate). Before `EDGE_REJECT_FRACTION` this got picked up by
 * `detectPeakCandidates` as a strong local extremum and auto-classified as a
 * bogus "cold crystallization" a fraction of a degree into the ramp — the
 * exact "Tcc 0.3 °C" bug reported against real `.tri` files. `CurveOpts`
 * only models one Gaussian, so this fixture is built by hand rather than
 * through `makeRun`/`heatFlowAt`.
 */
function makeEdgeArtifactRun(): DscRun {
  runCounter += 1;
  const id = `run${runCounter}`;
  const t0 = 40;
  const t1 = 260;
  const dTc = 0.05;
  const rateCPerMin = 10;
  const n = Math.round((t1 - t0) / dTc) + 1;
  const dtMin = dTc / rateCPerMin;

  const timeMin = new Float64Array(n);
  const tempC = new Float64Array(n);
  const heatFlowMw = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const T = t0 + i * dTc;
    timeMin[i] = i * dtMin;
    tempC[i] = T;
    const baseline = 0.02 + 0.0001 * T;
    const melt = -2 * Math.exp(-((T - 180) ** 2) / (2 * 5 ** 2));
    // Confined to ~T=40-41 °C — well inside the first 2 % of this 40-260 °C
    // segment — and large enough to clear both the enthalpy gate and the
    // peak-floor gate on its own.
    const edgeArtifact = 0.5 * Math.exp(-((T - (t0 + 0.3)) ** 2) / (2 * 0.3 ** 2));
    heatFlowMw[i] = baseline + melt + edgeArtifact;
  }

  const segment: DscSegment = {
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

  return {
    label: "Synthetic edge artifact",
    meta: {
      instrument: "DSC25",
      operator: "Test",
      sampleName: "Synthetic edge artifact",
      sampleMassMg: 1,
      panMassMg: 0,
      pan: "Tzero Aluminum Hermetic",
      methodSteps: [segment.label],
      runDate: "9/2/2026",
      gases: "Nitrogen, 50 mL/min",
      cooler: "RCS 90",
      cellConstant: "-23.6 mW/°C",
      sampleInterval: "0.1 s/pt",
      exoDirection: "up",
    },
    segments: [segment],
    timeMin,
    tempC,
    heatFlowMw,
    id,
    fileId: `${id}:file`,
    fileName: "synthetic.tri",
    color: "#000000",
    scale: 1,
    offset: 0,
    visible: true,
    materialId: null,
    activeSegmentId: segment.id,
    massOverrideMg: null,
    polymerFraction: 1,
    referenceId: null,
    features: [],
  };
}

/** An isothermal hold at a constant temperature, with a tanh-in-TIME
 *  exothermic rise at `onsetMin` — used for the OIT test. */
function makeOitRun(onsetMin: number, riseWidthMin: number): DscRun {
  runCounter += 1;
  const id = `run${runCounter}`;
  const n = 600;
  const dt = 0.02; // minutes
  const timeMin = new Float64Array(n);
  const tempC = new Float64Array(n);
  const heatFlowMw = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i * dt;
    timeMin[i] = t;
    tempC[i] = 200; // isothermal
    const step = 0.5 * (1 + Math.tanh((t - onsetMin) / riseWidthMin));
    heatFlowMw[i] = 0.01 + 0.2 * step;
  }
  const segment: DscSegment = {
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
  return {
    label: "Synthetic OIT",
    meta: {
      instrument: "DSC25",
      operator: "Test",
      sampleName: "Synthetic OIT",
      sampleMassMg: 1,
      panMassMg: 0,
      pan: "Tzero Aluminum Hermetic",
      methodSteps: [segment.label],
      runDate: "9/2/2026",
      gases: "Oxygen, 50 mL/min",
      cooler: "RCS 90",
      cellConstant: "-23.6 mW/°C",
      sampleInterval: "0.02 min/pt",
      exoDirection: "up",
    },
    segments: [segment],
    timeMin,
    tempC,
    heatFlowMw,
    id,
    fileId: `${id}:file`,
    fileName: "synthetic-oit.tri",
    color: "#000000",
    scale: 1,
    offset: 0,
    visible: true,
    materialId: null,
    activeSegmentId: segment.id,
    massOverrideMg: null,
    polymerFraction: 1,
    referenceId: null,
    features: [],
  };
}

/** A constant-temperature run, used to pin the "all-NaN over an isothermal
 *  span" guard on the derivative (§3.3). */
function makeIsothermalRun(): DscRun {
  runCounter += 1;
  const id = `run${runCounter}`;
  const n = 200;
  const timeMin = new Float64Array(n);
  const tempC = new Float64Array(n);
  const heatFlowMw = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    timeMin[i] = i * 0.1;
    tempC[i] = 150 + (i % 3) * 1e-4; // near-constant, sub-guard wobble
    heatFlowMw[i] = 0.02 + (i % 5) * 1e-5;
  }
  const segment: DscSegment = {
    id: `${id}:seg0`,
    label: "Isothermal 150.0 °C",
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
  return {
    label: "Synthetic isothermal",
    meta: {
      instrument: "DSC25",
      operator: "Test",
      sampleName: "Synthetic isothermal",
      sampleMassMg: 1,
      panMassMg: 0,
      pan: "Tzero Aluminum Hermetic",
      methodSteps: [segment.label],
      runDate: "9/2/2026",
      gases: "Nitrogen, 50 mL/min",
      cooler: "RCS 90",
      cellConstant: "-23.6 mW/°C",
      sampleInterval: "0.1 s/pt",
      exoDirection: "up",
    },
    segments: [segment],
    timeMin,
    tempC,
    heatFlowMw,
    id,
    fileId: `${id}:file`,
    fileName: "synthetic-iso.tri",
    color: "#000000",
    scale: 1,
    offset: 0,
    visible: true,
    materialId: null,
    activeSegmentId: segment.id,
    massOverrideMg: null,
    polymerFraction: 1,
    referenceId: null,
    features: [],
  };
}

/**
 * Options for `makeTwoSlopeRun` — a real-shaped fixture for the step-vs-peak
 * discriminator (`classifyStepCandidate` in `compute.ts`), distinct from
 * `CurveOpts`/`heatFlowAt` above. `heatFlowAt`'s baseline is a single GLOBAL
 * linear slope, so its tanh step (see `COMBINED`) is small enough that
 * `detectPeakCandidates`' endpoint-to-endpoint line still cancels it near
 * enough for `detectGlassCandidate`'s outside-every-peak fallback to find it
 * — a different code path than the one this fixture targets. Real `.tri`
 * files' Tg steps ride on a baseline whose SLOPE CHANGES across the
 * transition (steeper before, shallower after — DAC1.tri's pre-Tg slope
 * measures ≈ -0.0018 W/(g·°C), its post-Tg slope ≈ -0.0005), which is what
 * actually defeats the straight two-point baseline and gets the step picked
 * up as one huge, one-sided "peak" candidate in the first place. Only THAT
 * shape exercises `classifyStepCandidate`.
 */
interface TwoSlopeOpts {
  t0C: number;
  t1C: number;
  dTc: number;
  rateCPerMin: number;
  baseline0: number; // hf at t0C
  preSlope: number; // W/(g·°C), before the step
  postSlope: number; // W/(g·°C), after the step
  stepCenterC: number;
  stepWidthC: number;
  stepHeightWPerG: number; // permanent displacement added at the transition; 0 = a slope-only kink, no step
  /** An optional Gaussian riding at `stepCenterC` — a real peak candidate to
   *  confirm the discriminator lets it through untouched even when it's the
   *  same size/location a step candidate would be. 0 = no peak. */
  gaussAmpWPerG: number;
  gaussSigmaC: number;
  sampleMassMg: number;
}

/** `(1-w)*preLine(T) + w*postLine(T) + gaussian`, where `w` is the same
 *  tanh blend `heatFlowAt` uses for its step, so the two lines cross over
 *  smoothly at `stepCenterC` rather than jumping discontinuously — matching
 *  a real DSC step's finite rise width. */
function twoSlopeHeatFlowAt(T: number, o: TwoSlopeOpts): number {
  const w = 0.5 * (1 + Math.tanh((T - o.stepCenterC) / o.stepWidthC));
  const preVal = o.baseline0 + o.preSlope * (T - o.t0C);
  const atCenter = o.baseline0 + o.preSlope * (o.stepCenterC - o.t0C);
  const postVal = atCenter + o.stepHeightWPerG + o.postSlope * (T - o.stepCenterC);
  const baseline = (1 - w) * preVal + w * postVal;
  const gauss =
    o.gaussAmpWPerG !== 0
      ? o.gaussAmpWPerG * Math.exp(-((T - o.stepCenterC) ** 2) / (2 * o.gaussSigmaC ** 2))
      : 0;
  return baseline + gauss;
}

/** Same run-building shape as `makeRun`, driven by `twoSlopeHeatFlowAt`
 *  instead of `heatFlowAt`. Always a heating ramp — every real file this
 *  fixture mirrors is a heat segment. */
function makeTwoSlopeRun(o: TwoSlopeOpts): DscRun {
  runCounter += 1;
  const id = `run${runCounter}`;
  const n = Math.round((o.t1C - o.t0C) / o.dTc) + 1;
  const dtMin = o.dTc / o.rateCPerMin;

  const timeMin = new Float64Array(n);
  const tempC = new Float64Array(n);
  const heatFlowMw = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const T = o.t0C + i * o.dTc;
    timeMin[i] = i * dtMin;
    tempC[i] = T;
    heatFlowMw[i] = twoSlopeHeatFlowAt(T, o);
  }

  const segment: DscSegment = {
    id: `${id}:seg0`,
    label: `Ramp ${o.rateCPerMin} °C/min to ${o.t1C} °C`,
    kind: "heat",
    rateCPerMin: o.rateCPerMin,
    ordinal: 1,
    cycle: 1,
    start: 0,
    end: n,
    tStartC: tempC[0],
    tEndC: tempC[n - 1],
    timeStartMin: timeMin[0],
    timeEndMin: timeMin[n - 1],
  };

  return {
    label: "Synthetic two-slope",
    meta: {
      instrument: "DSC25",
      operator: "Test",
      sampleName: "Synthetic two-slope",
      sampleMassMg: o.sampleMassMg,
      panMassMg: 0,
      pan: "Tzero Aluminum Hermetic",
      methodSteps: [segment.label],
      runDate: "9/2/2026",
      gases: "Nitrogen, 50 mL/min",
      cooler: "RCS 90",
      cellConstant: "-23.6 mW/°C",
      sampleInterval: "0.1 s/pt",
      exoDirection: "up",
    },
    segments: [segment],
    timeMin,
    tempC,
    heatFlowMw,
    id,
    fileId: `${id}:file`,
    fileName: "synthetic-two-slope.tri",
    color: "#000000",
    scale: 1,
    offset: 0,
    visible: true,
    materialId: null,
    activeSegmentId: segment.id,
    massOverrideMg: null,
    polymerFraction: 1,
    referenceId: null,
    features: [],
  };
}

/** DAC1.tri-shaped: a real step (permanent -0.05 W/g displacement) at 70 °C,
 *  well clear of both segment ends (margin `max(10, 5% * 280) = 14 °C`,
 *  70 °C clears it by 56 °C), pre-slope steeper than post-slope, no Gaussian.
 *  `stepCenterC` and `stepHeightWPerG` are overridden by individual tests
 *  below to probe the discriminator's edge-margin and Δcp-plausibility
 *  guards. */
const TWO_SLOPE_STEP: TwoSlopeOpts = {
  t0C: 0,
  t1C: 280,
  dTc: 0.1,
  rateCPerMin: 10,
  baseline0: -0.17,
  preSlope: -0.0018,
  postSlope: -0.0005,
  stepCenterC: 70,
  stepWidthC: 3,
  stepHeightWPerG: -0.05,
  gaussAmpWPerG: 0,
  gaussSigmaC: 5,
  sampleMassMg: 1,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compute engine", () => {
  it("integrates the melt enthalpy within 1% of the analytic Gaussian area and locates/brackets the peak", () => {
    const run = makeRun("heat", COMBINED);
    const view = segmentView(run, run.segments[0], DEFAULT_PARAMS);
    const result = peakTransition(view, run, MELT_WINDOW, MELT_WINDOW);

    const expected = analyticGaussianEnthalpyJPerG(COMBINED);
    expect(result.enthalpyJPerG).not.toBeNull();
    expect(Math.abs(Math.abs(result.enthalpyJPerG!) - expected) / expected).toBeLessThan(0.01);

    expect(result.peakC).not.toBeNull();
    expect(Math.abs(result.peakC! - COMBINED.gaussPeakC)).toBeLessThan(0.5);

    // Onset/endset must bracket the peak.
    expect(result.onsetC).not.toBeNull();
    expect(result.endsetC).not.toBeNull();
    expect(result.onsetC!).toBeLessThan(result.peakC!);
    expect(result.endsetC!).toBeGreaterThan(result.peakC!);
  });

  // Regression for a real-file bug: on `1-2 S1.tri`'s broad melt peak, the
  // steepest-point tangent on one flank came out nearly parallel to the
  // window's baseline — a mathematically valid but physically meaningless
  // line intersection, reported as an Endset of -6286 °C. A genuine
  // onset/endset can only fall between the window edge and the peak (the
  // span `tangentBaselineIntersect` searches over); anything outside that
  // must come back `null`, same as an exactly-parallel (NaN) intersection.
  it("never reports an onset/endset outside the window it was searched over, even on a broad peak", () => {
    const run = makeRun("heat", BROAD_NOISY_MELT);
    const view = segmentView(run, run.segments[0], DEFAULT_PARAMS);
    // Deliberately asymmetric, like the real `1-2 S1.tri` melt that exposed
    // this bug: the peak sits close to one edge of a window that runs far
    // out the other side, so the far flank's steepest-point tangent has a
    // long, gentle run-in that can end up nearly parallel to the anchor
    // baseline.
    const window: [number, number] = [BROAD_NOISY_MELT.t0C, BROAD_NOISY_MELT.t1C];
    const result = peakTransition(view, run, window, window);

    if (result.onsetC != null) {
      expect(result.onsetC).toBeGreaterThanOrEqual(window[0]);
      expect(result.onsetC).toBeLessThanOrEqual(result.peakC!);
    }
    if (result.endsetC != null) {
      expect(result.endsetC).toBeLessThanOrEqual(window[1]);
      expect(result.endsetC).toBeGreaterThanOrEqual(result.peakC!);
    }
  });

  it("computes Δcp within 2% of the analytic tanh step height divided by rate", () => {
    const run = makeRun("heat", COMBINED);
    const view = segmentView(run, run.segments[0], DEFAULT_PARAMS);
    const result = glassTransition(view, GLASS_WINDOW);

    const rateCPerSec = COMBINED.rateCPerMin / 60;
    const expectedDeltaCp = COMBINED.stepHeightWPerG / rateCPerSec;

    expect(result.deltaCp).not.toBeNull();
    expect(Math.abs(result.deltaCp! - expectedDeltaCp) / expectedDeltaCp).toBeLessThan(0.02);
    expect(result.onsetC).not.toBeNull();
    expect(result.endsetC).not.toBeNull();
    expect(result.midpointC).not.toBeNull();
    // Midpoint should land close to the tanh's true center.
    expect(Math.abs(result.midpointC! - COMBINED.stepCenterC)).toBeLessThan(1);
  });

  it("integrates the same |ΔH| for a cooling segment as for heating", () => {
    // §3.5.4 requires walking the run's ORIGINAL acquisition order
    // (`view.rawTimeMin`), never the reversed `view.timeMin`. A cooling
    // segment's `timeMin` is reversed alongside `tempC` so the view stays
    // ascending-temperature; integrating against THAT axis would make
    // `t[i+1] - t[i]` negative and corrupt (or sign-flip) the trapezoidal
    // sum. This test would fail if that reversed axis were used instead of
    // the raw one.
    const runHeat = makeRun("heat", COMBINED);
    const runCool = makeRun("cool", COMBINED);
    const viewHeat = segmentView(runHeat, runHeat.segments[0], DEFAULT_PARAMS);
    const viewCool = segmentView(runCool, runCool.segments[0], DEFAULT_PARAMS);
    expect(viewCool.reversed).toBe(true);
    expect(viewHeat.reversed).toBe(false);

    const rHeat = peakTransition(viewHeat, runHeat, MELT_WINDOW, MELT_WINDOW);
    const rCool = peakTransition(viewCool, runCool, MELT_WINDOW, MELT_WINDOW);

    expect(rHeat.enthalpyJPerG).not.toBeNull();
    expect(rCool.enthalpyJPerG).not.toBeNull();
    const relDiff = Math.abs(Math.abs(rCool.enthalpyJPerG!) - Math.abs(rHeat.enthalpyJPerG!)) / Math.abs(rHeat.enthalpyJPerG!);
    expect(relDiff).toBeLessThan(0.01);
  });

  it("marks the derivative all-NaN across an isothermal segment", () => {
    const run = makeIsothermalRun();
    const view = segmentView(run, run.segments[0], DEFAULT_PARAMS);
    const deriv = computeDerivative(view, DEFAULT_PARAMS.smoothWindow);
    expect(deriv.length).toBeGreaterThan(0);
    expect(deriv.every((v) => Number.isNaN(v))).toBe(true);
  });

  it("autoDetectFeatures finds exactly the melt and glass features and classifies them for a heat segment", () => {
    const run = makeRun("heat", COMBINED);
    const view = segmentView(run, run.segments[0], DEFAULT_PARAMS);
    const features = autoDetectFeatures(view, run.segments[0], DEFAULT_PARAMS);

    expect(features).toHaveLength(2);
    const melt = features.find((f) => f.kind === "melt");
    const glass = features.find((f) => f.kind === "glass");
    expect(melt).toBeDefined();
    expect(glass).toBeDefined();
    expect(melt!.auto).toBe(true);
    expect(glass!.auto).toBe(true);

    expect(melt!.window[0]).toBeLessThan(COMBINED.gaussPeakC);
    expect(melt!.window[1]).toBeGreaterThan(COMBINED.gaussPeakC);
    expect(glass!.window[0]).toBeLessThan(COMBINED.stepCenterC);
    expect(glass!.window[1]).toBeGreaterThan(COMBINED.stepCenterC);
  });

  it("does not re-detect a broad, noisy-shouldered melt peak as several near-duplicate features", () => {
    const run = makeRun("heat", BROAD_NOISY_MELT);
    const view = segmentView(run, run.segments[0], DEFAULT_PARAMS);
    const features = autoDetectFeatures(view, run.segments[0], DEFAULT_PARAMS);

    const melts = features.filter((f) => f.kind === "melt");
    expect(melts).toHaveLength(1);
    expect(melts[0].window[0]).toBeLessThan(BROAD_NOISY_MELT.gaussPeakC);
    expect(melts[0].window[1]).toBeGreaterThan(BROAD_NOISY_MELT.gaussPeakC);
  });

  it("drops an auto-detected peak whose |ΔH| falls below params.minPeakEnthalpy", () => {
    const run = makeRun("heat", SMALL_PEAK);
    const view = segmentView(run, run.segments[0], DEFAULT_PARAMS);

    // The small Gaussian's analytic enthalpy (~1.5 J/g) clears the default
    // 1 J/g floor.
    const included = autoDetectFeatures(view, run.segments[0], DEFAULT_PARAMS);
    expect(included.some((f) => f.kind === "melt")).toBe(true);

    // A stricter floor above that value must drop it.
    const strict = { ...DEFAULT_PARAMS, minPeakEnthalpy: 5 };
    const excluded = autoDetectFeatures(view, run.segments[0], strict);
    expect(excluded.some((f) => f.kind === "melt")).toBe(false);
  });

  // Regression for the real-file bug `MAX_PEAK_SPAN_FRACTION` (compute.ts)
  // exists to fix: DAC2.tri heat 2, DAC1.tri cool 1, DAC1.tri heat 1, and
  // `1-2 S1.tri` heat 2 all reported a bogus melt/crystallization spanning
  // 77-97% of their segment before this gate existed, because a straight
  // two-point baseline can't represent a gently curved real DSC baseline.
  it("rejects a peak candidate whose window would cover most of a purely-curved segment with no real transition", () => {
    const run = makeRun("heat", CURVED_BASELINE_ONLY);
    const view = segmentView(run, run.segments[0], DEFAULT_PARAMS);
    const features = autoDetectFeatures(view, run.segments[0], DEFAULT_PARAMS);

    // No melt, no crystallization, no cure — just curvature, nothing to
    // report. (A weak glass candidate is not what this fixture is built to
    // exercise; the assertion that matters is that no PEAK-family feature
    // spans most of the segment.)
    for (const f of features) {
      const span = Math.abs(f.window[1] - f.window[0]);
      const segSpan = Math.abs(CURVED_BASELINE_ONLY.t1C - CURVED_BASELINE_ONLY.t0C);
      expect(span).toBeLessThanOrEqual(0.75 * segSpan);
    }
    expect(features.some((f) => f.kind === "melt" || f.kind === "crystallization" || f.kind === "cure")).toBe(
      false,
    );
  });

  it("rejects an auto-detected peak whose apex sits in the segment's first/last 2% (start-of-ramp thermal lag, not a real transition)", () => {
    const run = makeEdgeArtifactRun();
    const view = segmentView(run, run.segments[0], DEFAULT_PARAMS);
    const features = autoDetectFeatures(view, run.segments[0], DEFAULT_PARAMS);

    // The real melt survives...
    const melt = features.find((f) => f.kind === "melt");
    expect(melt).toBeDefined();
    expect(melt!.window[0]).toBeLessThan(180);
    expect(melt!.window[1]).toBeGreaterThan(180);

    // ...but no bogus peak-family feature gets auto-detected out of the
    // thermal-lag transient at the start of the ramp — the "Tcc 0.3 °C" bug.
    expect(features.some((f) => f.kind === "coldCrystallization" || f.kind === "cure")).toBe(false);
  });

  it("crystallinity honours polymerFraction", () => {
    expect(crystallinity(100, 0, 200, 1)).toBeCloseTo(50, 6);
    // Halving the polymer fraction doubles the reported crystallinity of the
    // polymer phase, for the same measured enthalpy.
    expect(crystallinity(100, 0, 200, 0.5)).toBeCloseTo(100, 6);
    // Cold crystallization subtracts from the melt enthalpy.
    expect(crystallinity(100, 20, 200, 1)).toBeCloseTo(40, 6);
    expect(crystallinity(100, 0, 200, 0)).toBeNull();
    expect(crystallinity(100, 0, 0, 1)).toBeNull();
  });

  it("toWattsPerGram falls back to raw mW and warns when sample mass is missing or zero", () => {
    const mw = Float64Array.from([1, 2, 3]);

    const nullMass = toWattsPerGram(mw, null);
    expect(Array.from(nullMass.heatFlow)).toEqual([1, 2, 3]);
    expect(nullMass.warning).toBe("No sample mass — heat flow shown in mW; enter a mass to normalize.");
    expect(nullMass.divisorMg).toBeNull();

    const zeroMass = toWattsPerGram(mw, 0);
    expect(zeroMass.warning).not.toBeNull();

    const normal = toWattsPerGram(mw, 2);
    expect(Array.from(normal.heatFlow)).toEqual([0.5, 1, 1.5]);
    expect(normal.warning).toBeNull();
    expect(normal.divisorMg).toBe(2);
  });

  it("exoDisplaySign flips with the exoUp/exoDirection combination", () => {
    const runUp = makeRun("heat", COMBINED); // exoDirection defaults "up"
    expect(exoDisplaySign(runUp, { ...DEFAULT_PARAMS, exoUp: true })).toBe(1);
    expect(exoDisplaySign(runUp, { ...DEFAULT_PARAMS, exoUp: false })).toBe(-1);

    const runDown = makeRun("heat", { ...COMBINED, exoDirection: "down" });
    expect(exoDisplaySign(runDown, { ...DEFAULT_PARAMS, exoUp: true })).toBe(-1);
    expect(exoDisplaySign(runDown, { ...DEFAULT_PARAMS, exoUp: false })).toBe(1);
  });

  it("degreeOfCure computes 1 - residual/total", () => {
    expect(degreeOfCure(100, 20)).toBeCloseTo(0.8, 6);
    expect(degreeOfCure(0, 20)).toBeNull();
    expect(degreeOfCure(100, NaN)).toBeNull();
  });

  it("oxidativeInductionTime finds the onset of an exotherm during an isothermal hold", () => {
    const run = makeOitRun(5, 0.3);
    const view = segmentView(run, run.segments[0], DEFAULT_PARAMS);
    const { onsetMin, oitMin } = oxidativeInductionTime(view, 0);
    expect(onsetMin).not.toBeNull();
    expect(onsetMin!).toBeGreaterThan(4);
    expect(onsetMin!).toBeLessThan(6);
    expect(oitMin).toBeCloseTo(onsetMin!, 6);
  });

  it("computeDscAnalysis auto-detects features and fills glass/melt/crystallinityPct", () => {
    const run = makeRun("heat", COMBINED);
    run.referenceId = "pe"; // built-in reference, 293 J/g

    const analysis = computeDscAnalysis(run, DEFAULT_PARAMS);
    expect(analysis.warnings).toEqual([]);
    expect(analysis.melt).not.toBeNull();
    expect(analysis.glass).not.toBeNull();
    expect(analysis.crystallinityPct).not.toBeNull();

    const expectedXc = (Math.abs(analysis.melt!.enthalpyJPerG!) / 293) * 100;
    expect(analysis.crystallinityPct!).toBeCloseTo(expectedXc, 6);
  });

  it("computeDscAnalysis never throws on a run with no segments", () => {
    const run = makeRun("heat", COMBINED);
    const empty: DscRun = { ...run, segments: [], features: [] };
    const analysis = computeDscAnalysis(empty, DEFAULT_PARAMS);
    expect(analysis.warnings.length).toBeGreaterThan(0);
    expect(analysis.melt).toBeNull();
    expect(analysis.glass).toBeNull();
    expect(analysis.view.tempC.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Step-vs-peak discriminator (`classifyStepCandidate`) — regression tests
  // for the real `DAC1.tri`/`DAC3.tri` bug: a Tg step riding on a baseline
  // whose slope differs before/after the transition defeats
  // `detectPeakCandidates`' straight two-point baseline and reads as one
  // huge, one-sided "melt" unless the discriminator catches it. Fixtures use
  // `makeTwoSlopeRun`/`TWO_SLOPE_STEP`, not `COMBINED` — see that fixture's
  // doc comment for why `COMBINED`'s small tanh step doesn't exercise this
  // code path at all.
  // -------------------------------------------------------------------------

  it("auto-detects a baseline step with differing pre/post slopes as glass, windowed on the step, not swallowed as a bogus melt", () => {
    const run = makeTwoSlopeRun(TWO_SLOPE_STEP);
    const view = segmentView(run, run.segments[0], DEFAULT_PARAMS);
    const features = autoDetectFeatures(view, run.segments[0], DEFAULT_PARAMS);

    // Before the discriminator existed, this exact shape (verified against
    // DAC1.tri's real numbers in TWO_SLOPE_STEP's doc comment) was reported
    // as a single "melt" spanning almost the entire segment instead.
    expect(features.some((f) => f.kind !== "glass")).toBe(false);
    const glass = features.find((f) => f.kind === "glass");
    expect(glass).toBeDefined();
    expect(glass!.window[0]).toBeLessThan(TWO_SLOPE_STEP.stepCenterC);
    expect(glass!.window[1]).toBeGreaterThan(TWO_SLOPE_STEP.stepCenterC);
    // Windowed on the step, not spanning most of the 280 °C segment the way
    // the pre-fix "melt" did.
    expect(glass!.window[1] - glass!.window[0]).toBeLessThan(150);

    const g = glassTransition(view, glass!.window);
    expect(g.midpointC).not.toBeNull();
    expect(Math.abs(g.midpointC! - TWO_SLOPE_STEP.stepCenterC)).toBeLessThan(10);
  });

  it("still classifies a genuine Gaussian peak as a peak, not a glass step, even riding the same two-slope baseline a step would", () => {
    // Same baseline shape (and even the same candidate location) as the
    // previous test, but a REAL, symmetric peak instead of a permanent
    // displacement — the discriminator's two-lobe dominance test
    // (STEP_LOBE_DOMINANCE_RATIO) must see this peak's roughly-equal
    // opposite-sign flanks and let it through untouched.
    const run = makeTwoSlopeRun({ ...TWO_SLOPE_STEP, stepHeightWPerG: 0, gaussAmpWPerG: -2, gaussSigmaC: 5 });
    const view = segmentView(run, run.segments[0], DEFAULT_PARAMS);
    const features = autoDetectFeatures(view, run.segments[0], DEFAULT_PARAMS);

    expect(features.some((f) => f.kind === "glass")).toBe(false);
    const melt = features.find((f) => f.kind === "melt");
    expect(melt).toBeDefined();
    expect(melt!.window[0]).toBeLessThan(TWO_SLOPE_STEP.stepCenterC);
    expect(melt!.window[1]).toBeGreaterThan(TWO_SLOPE_STEP.stepCenterC);
  });

  it("rejects a step whose core sits within the ramp-start/end temperature margin, even when its own apex escapes the index-based edge guard", () => {
    // Pins the real DAC2.tri/1-2 S1.tri bug: the ramp-start thermal-lag
    // artifact's CORE sits at ~2-6 °C, but its d-apex (bestIdx, what
    // EDGE_REJECT_FRACTION's pre-existing INDEX guard checks) lands much
    // further out (~19 °C on the real files) — past that guard, so only the
    // newer TEMPERATURE-based margin on the core itself (isNearSegmentTempEdge)
    // catches it. stepCenterC: 5 sits inside max(10, 5% * 280) = 14 °C of
    // the segment's low end.
    const run = makeTwoSlopeRun({ ...TWO_SLOPE_STEP, stepCenterC: 5 });
    const view = segmentView(run, run.segments[0], DEFAULT_PARAMS);
    const features = autoDetectFeatures(view, run.segments[0], DEFAULT_PARAMS);
    expect(features.some((f) => f.kind === "glass")).toBe(false);
  });

  it("rejects a step-shaped candidate whose fitted Δcp is implausibly large, the cure-exotherm-flank bug seen on DAC1.tri/DAC3.tri's first heat", () => {
    // A step height of -0.2 W/g at 10 °C/min fits to Δcp ≈ 0.2 / (10/60) ≈
    // 1.2 J/(g·°C) — above GLASS_DELTA_CP_MAX_J_PER_G_C (1.0) and nowhere
    // near a real polymer's heat-capacity jump at Tg (TWO_SLOPE_STEP's own
    // -0.05 W/g step fits to a plausible ≈ 0.3). The lobe-dominance and
    // step-height-vs-amplitude gates both still pass this shape (it IS a
    // one-sided, permanently-displaced deviation) — only the Δcp
    // plausibility gate, run by calling the real glassTransition on the
    // candidate window, catches it.
    const run = makeTwoSlopeRun({ ...TWO_SLOPE_STEP, stepHeightWPerG: -0.2 });
    const view = segmentView(run, run.segments[0], DEFAULT_PARAMS);
    const features = autoDetectFeatures(view, run.segments[0], DEFAULT_PARAMS);
    expect(features.some((f) => f.kind === "glass")).toBe(false);
  });
});
