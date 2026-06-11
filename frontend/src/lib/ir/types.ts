// Shared types for the IR Kinetics workspace.
//
// This is a faithful port of a working Streamlit/Python app for Shimadzu
// IRAffinity-1S `.ispd` spectra. The shapes here are the contract between the
// parser (bdb/spectrum), the numerics (baseline/kinetics), the UI, and the
// exporters. All processing is client-side; files are never uploaded.

// ---------------------------------------------------------------------------
// Spectra
// ---------------------------------------------------------------------------

/**
 * One parsed IR spectrum. Wavenumber is sorted ascending; both absorbance and
 * transmittance are always provided (one is derived from the other via the
 * %T ↔ A relation). See §2c of the spec.
 */
export interface Spectrum {
  /** Wavenumber axis in cm⁻¹, ascending. */
  wavenumber: number[];
  /** Absorbance, aligned to `wavenumber`. */
  absorbance: number[];
  /** Transmittance in %T, aligned to `wavenumber`. */
  transmittance: number[];
  /** Display name — the source filename without its extension. */
  name: string;
  /** The raw y-unit string read from the 100003 descriptor (for diagnostics). */
  rawYUnit: string;
  meta: {
    nPoints: number;
    xmin: number;
    xmax: number;
  };
}

// ---------------------------------------------------------------------------
// Display / baseline configuration
// ---------------------------------------------------------------------------

/** Which axis the overlay charts plot. */
export type YAxis = "%T" | "Absorbance";

/**
 * Full-spectrum baseline methods (§6). All operate in absorbance space.
 * "Manual (draw)" subtracts a single user-drawn polyline baseline (see
 * `BaselinePoint`) and is offered only in View & Export, so it is intentionally
 * absent from `BASELINE_METHODS` (the shared automatic-method list).
 */
export type BaselineMethod =
  | "None"
  | "Offset"
  | "Linear (2-point)"
  | "Rubberband"
  | "Manual (draw)";

export const BASELINE_METHODS: BaselineMethod[] = [
  "None",
  "Offset",
  "Linear (2-point)",
  "Rubberband",
];

/** One anchor of a hand-drawn baseline: wavenumber (cm⁻¹) × absorbance. */
export interface BaselinePoint {
  /** Wavenumber, cm⁻¹. */
  x: number;
  /** Absorbance value of the baseline at this wavenumber. */
  y: number;
}

// ---------------------------------------------------------------------------
// Kinetics — peak measurement configuration
// ---------------------------------------------------------------------------

export type TimeUnit = "s" | "min" | "h";

/** How a tracked peak's signal is quantified within its window. */
export type MeasureMode = "height" | "area";

/** Per-window baseline used by `measurePeak` (distinct from the §6 methods). */
export type WindowBaseline = "none" | "linear";

/** A peak (or reference peak) to track across the time series. */
export interface PeakConfig {
  /** Window centre, cm⁻¹. */
  center: number;
  /** Half-width of the window, cm⁻¹. */
  halfwidth: number;
  measure: MeasureMode;
  baseline: WindowBaseline;
}

// ---------------------------------------------------------------------------
// Kinetics — results
// ---------------------------------------------------------------------------

/**
 * First-order fit + derived quantities, returned by `analyze` (§8). When the
 * fit fails, `fitOk` is false but the measured points and conversion are still
 * present so the UI can show the raw data.
 */
export interface KineticsResult {
  /** Time points (in the chosen unit), finite pairs only. */
  time: number[];
  /** Measured signal (reference-divided when a reference peak is used). */
  signal: number[];
  /** Conversion fraction (s0 − s)/s0. */
  conversion: number[];
  /** Initial signal S0 (= signal[0]). */
  s0: number;
  /** Fitted plateau S∞. */
  sInf: number;
  /** Rate constant k (per time unit). NaN when the fit failed. */
  k: number;
  /** Coefficient of determination of the first-order fit. */
  r2: number;
  /** ln2/k; NaN when k ≤ 0. */
  halfLife: number;
  /** Fitted final conversion (S0 − S∞)/S0. */
  finalConversion: number;
  fitOk: boolean;
  /** Dense time grid for plotting the fitted curve (200 pts) — present iff fit ok. */
  tFit?: number[];
  /** Model S(t) evaluated on `tFit`. */
  sFit?: number[];
}

/**
 * One linearized reaction-order fit (order 0, 1, or 2), from `fitOrders` (§8).
 * Invalid/non-finite transformed points are dropped before fitting.
 */
export interface OrderFit {
  order: 0 | 1 | 2;
  /** Transform applied to the signal: "S", "ln(S)", "1/S". */
  transform: string;
  /** Human label, e.g. "ln(S) vs t". */
  label: string;
  /** Rate constant derived from the line's slope. */
  k: number;
  /** Units string for k, e.g. "1/min". */
  kUnits: string;
  r2: number;
  /** False when fewer than 3 valid points remain. */
  ok: boolean;
  /** Time points used (after dropping invalid). */
  t: number[];
  /** Transformed signal values. */
  y: number[];
  /** Straight-line fit evaluated at `t`. */
  yFit: number[];
  /** Count of valid points. */
  n: number;
}

// ---------------------------------------------------------------------------
// Export payload
// ---------------------------------------------------------------------------

/**
 * Everything the CSV/PDF/Excel exporters need (§9). Field names map onto the
 * exported column headers; refined as the exporters are built (Phase 9).
 */
export interface KineticsReport {
  timeUnit: TimeUnit;
  /** Signal axis label, e.g. "ratio to ref" or the measure mode. */
  signalUnit: string;
  time: number[];
  signal: number[];
  /** Conversion as a fraction (0..1); exported as a percentage. */
  conversion: number[];
  /** Raw tracked-peak measure when a reference is used. */
  raw?: number[];
  /** Reference-peak measure when a reference is used. */
  ref?: number[];
  peak: PeakConfig;
  refPeak?: PeakConfig;
  useReference: boolean;
  result: KineticsResult;
  orders: OrderFit[];
  spectraCount: number;
  /** Rendered chart PNGs for the PDF (grabbed from the uPlot canvases). */
  peakPlotPng?: string | null;
  conversionPlotPng?: string | null;
}
