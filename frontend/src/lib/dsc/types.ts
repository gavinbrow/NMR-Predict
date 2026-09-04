// Types for the DSC workspace. Pure data shapes — the parsers, store, compute
// engine, and figure adapter all read from these. Nothing here touches the DOM.
//
// This file declares the FULL type surface later work packages need,
// including a few types whose *implementation* (the reducer, the compute
// engine) is built by later WPs — WP1 only owns parsing + segment
// classification, but the shapes have to exist up front so those WPs can be
// written against a stable contract. See the plan's §1.1/§WP2/§2.3/§3.7.

/** Exothermic display convention: whether a positive signal reads as an
 *  exotherm ("up") or an endotherm ("down"). TRIOS `.tri`/`.xls` files store
 *  the raw signal already exo-up by default (§2.1); PerkinElmer's "Endo Up"
 *  convention is the opposite (§2.5). */
export type ExoDirection = "up" | "down";

/** Classification of one procedure segment, from `classifySegment` (§WP1.4). */
export type SegmentKind = "heat" | "cool" | "isothermal" | "unknown";

/** Metadata extracted from a DSC file's header, normalized across vendors. */
export interface DscMetadata {
  instrument: string; // "DSC25"
  operator: string;
  sampleName: string;
  sampleMassMg: number | null; // §2.1: .tri `samplesize` is ALREADY mg
  panMassMg: number | null;
  pan: string; // "Tzero Aluminum Hermetic"
  methodSteps: string[]; // proceduresegments split on ";"
  runDate: string;
  gases: string; // "Nitrogen, 50 mL/min"
  cooler: string; // "RCS 90"
  cellConstant: string; // "-23.63117 mW/°C"
  sampleInterval: string; // "0.1 s/pt"
  exoDirection: ExoDirection; // from the file; default "up"
}

/** One procedure segment of a run (a heat/cool ramp or an isothermal hold).
 *  A TRIOS heat→cool→heat→cool method yields four of these on one run. */
export interface DscSegment {
  id: string; // `${runId}:seg${i}`, stable across reloads
  label: string; // "Ramp 10.00 °C/min to 280.00 °C"
  kind: SegmentKind;
  rateCPerMin: number | null; // magnitude; `kind` carries the direction
  ordinal: number; // 1-based among segments of the SAME kind: heat 1, heat 2, …
  cycle: number; // 1-based heat/cool cycle
  start: number; // inclusive index into the run's arrays
  end: number; // exclusive
  tStartC: number;
  tEndC: number;
  timeStartMin: number;
  timeEndMin: number;
}

/** One DSC run as parsed from a file, before it is adopted into the store
 *  (colour, visibility, features, …). A single file can yield several runs
 *  (a TRIOS Excel export's sheets all merge into one run; a generic CSV
 *  yields exactly one). Arrays are Float64 for the downstream numeric work. */
export interface ParsedDscRun {
  label: string;
  meta: DscMetadata;
  segments: DscSegment[];
  timeMin: Float64Array;
  tempC: Float64Array;
  heatFlowMw: Float64Array; // raw, in the file's own exo convention
  heatFlowNormFile?: Float64Array; // vendor W/g when the file gave only that
}

/** Result of parsing one file: a file name, zero or more runs, and any
 *  non-fatal warnings the UI should surface. Parsers never throw — every
 *  failure becomes a warning string here, with `runs` left empty. */
export interface ParsedDscFile {
  fileName: string;
  runs: ParsedDscRun[];
  warnings: string[];
}

/** One user-placed or auto-detected transition on a run's segment. */
export type DscFeatureKind =
  | "glass"
  | "melt"
  | "crystallization"
  | "coldCrystallization"
  | "cure"
  | "oit"
  | "custom";

export interface DscFeature {
  id: string;
  segmentId: string;
  kind: DscFeatureKind;
  label: string;
  window: [number, number]; // °C, or min for an isothermal/OIT feature
  baseline: [number, number] | null; // anchor temperatures/times, or null → window ends
  baselineMode: "linear";
  auto: boolean; // true until the user edits it (§3.6.6)
  visible: boolean;
  /**
   * User-typed Tg override, °C — meaningful only when `kind === "glass"`;
   * `null` on every other kind and on a glass feature that hasn't been
   * hand-corrected. Auto-detection and the ASTM E1356 fit are a starting
   * point, not always the answer: a noisy segment can pull the half-height
   * crossing off the real step, or miss one on a segment that visibly has
   * one. When set, `computeDscAnalysis` overrides the fitted
   * `GlassResult.midpointC` with this value (and recomputes `deltaCp` at
   * it — see that function's doc comment) instead of discarding the user's
   * correction the next time parameters change or re-detection runs. Setting
   * it goes through `UPDATE_FEATURE` like any other field, which already
   * clears `auto` (§3.6.6) so a hand-set Tg survives exactly like a
   * hand-edited window does.
   */
  manualMidpointC: number | null;
}

/** A DSC run in the store — a parsed run plus the per-run display state
 *  (id, colour, visibility, scale, offset, material assignment, analysis
 *  inputs). The store memoizes the computed analysis on top of this. */
export interface DscRun extends ParsedDscRun {
  id: string;
  fileId: string;
  fileName: string;
  color: string;
  scale: number;
  offset: number;
  visible: boolean;
  materialId: string | null;
  activeSegmentId: string | null; // null ⇒ resolve the default (§WP1.4)
  massOverrideMg: number | null; // user correction when metadata is wrong/absent
  polymerFraction: number; // 0–1, for filled samples; default 1
  referenceId: string | null; // ΔH°100 library entry for % crystallinity
  features: DscFeature[]; // user + auto transitions, per segment
}

/** A loaded file in the store — one file can produce many runs (a TRIOS
 *  Excel export's segment sheets all merge into a single run, but a future
 *  multi-sample generic import could yield more than one). Mirrors
 *  `TgaLoadedFile`. */
export interface DscFile {
  id: string;
  fileName: string;
  runCount: number;
  warnings: string[];
}

/** A material group — a named collection of runs, for mean±SD comparison.
 *  One material per file by default (`materialNameFromFile`), so replicate
 *  runs like `DAC1`/`DAC2`/`DAC3` can be merged into one group by the user.
 *  Mirrors `TgaMaterial`. */
export interface DscMaterial {
  id: string;
  name: string;
  runIds: string[];
}

/** Per-run analysis parameters. Changing these recomputes the derived
 *  analysis (§WP3). */
export interface DscParams {
  /** Savitzky–Golay window for the derivative, forced odd, min 5. */
  smoothWindow: number;
  /** Minimum |ΔH| (J/g) for an auto-detected peak to be kept (§3.6.3). */
  minPeakEnthalpy: number;
  /** Display convention: true when a positive signal should read as an
   *  exotherm. Combined with the run's own `meta.exoDirection` (§3.2). */
  exoUp: boolean;
  /** Whether the y-axis label carries the "↑ Exo" / "↓ Exo" arrow (§3.2). */
  showExoArrow: boolean;
  /** Heat-flow normalization: per-gram (needs a sample mass) or raw mW. */
  normMode: "wattsPerGram" | "raw";
  /** Whether `autoDetectFeatures` runs automatically for `auto` features. */
  autoDetect: boolean;
}

/** Default analysis parameters — mirrors the WP1/WP3 specification. */
export const DEFAULT_PARAMS: DscParams = {
  smoothWindow: 21,
  minPeakEnthalpy: 1,
  exoUp: true,
  showExoArrow: true,
  normMode: "wattsPerGram",
  autoDetect: true,
};

/** Column mapping for the generic CSV/XLSX importer — mirrors TGA's
 *  `ColumnMap` but swaps `weight`/`weightPct`/`dtg` for `heatFlow`/
 *  `heatFlowNorm` (§2.3). Built by `autoDetectColumnMap`/`ColumnMapDialog`. */
export interface DscColumnMap {
  time: number;
  /** Time column's unit; absent means already minutes (most exports). §2.3:
   *  seconds columns divide by 60 on extraction. */
  timeUnit?: "min" | "s";
  temperature: number;
  heatFlow: number;
  heatFlowNorm?: number;
  heatFlowUnit: "mW" | "W" | "W/g" | "mW/mg";
  tempUnit: "C" | "K";
  exoDirection: ExoDirection;
  headerRow: number;
  firstDataRow: number;
}

/** One entry in the % crystallinity reference library — a 100 %-crystalline
 *  reference enthalpy for a polymer (§3.7). */
export interface DscReference {
  id: string;
  name: string;
  enthalpy100JPerG: number;
  builtIn: boolean;
  note?: string;
}
