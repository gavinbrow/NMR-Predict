// Types for the TGA workspace. Pure data shapes — the parsers, store, compute
// engine, and figure adapter all read from these. Nothing here touches the DOM.

/** Metadata extracted from a TGA file's header, normalized across vendors. */
export interface TgaMetadata {
  /** Instrument model, e.g. "TA Q50", "TGA5500", or "" when unknown. */
  instrument: string;
  operator: string;
  /** Sample name from the header, else the file stem. */
  sampleName: string;
  /** Sample mass in mg, or `null` when the header didn't carry it. */
  sampleSizeMg: number | null;
  /** Pan type, e.g. "Platinum HT", or "" when unknown. */
  pan: string;
  /** Thermal-program steps, e.g. ["1: Ramp 10 °C/min to 600 °C"]. */
  methodSteps: string[];
  /** Run date as the vendor wrote it (no normalization), "" when unknown. */
  runDate: string;
  /** Best-effort gas/atmosphere from the header, "" when unknown. */
  gases: string;
}

/** One procedure segment as the vendor recorded it (TRIOS files carry several;
 *  TA files produce exactly one). Per-segment arrays live only on the parsed
 *  run; the store flattens them into the concatenated `timeMin`/`tempC`/`weightMg`. */
export interface TgaSegment {
  label: string;
}

/** One TGA run as parsed from a file — the unit the store works in (a single
 *  file can yield many runs, e.g. a TRIOS Excel export with several samples side
 *  by side). Arrays are Float64 for the downstream numeric work. */
export interface ParsedRun {
  label: string;
  meta: TgaMetadata;
  segments: TgaSegment[];
  timeMin: Float64Array;
  tempC: Float64Array;
  weightMg: Float64Array;
  /** Vendor-supplied weight % when the file carried it (TRIOS, some TA exports). */
  weightPctFile?: Float64Array;
  /** Vendor-supplied derivative when the file carried it (TRIOS Ramp sheet). */
  dtgFile?: Float64Array;
}

/** Result of parsing one file: a file name, zero or more runs, and any
 *  non-fatal warnings the UI should surface. */
export interface ParsedTgaFile {
  fileName: string;
  runs: ParsedRun[];
  warnings: string[];
}

/** The set of native TGA formats the dispatcher recognises. */
export type TgaFormat = "taText" | "taBinary" | "triosTri" | "triosXls" | "genericTable";

/** Outcome of `sniffFormat`: a known format, `"skip"` (silently ignore, e.g. PDF),
 *  or `null` (unrecognised — surface as a warning). */
export type SniffResult = TgaFormat | "skip" | null;

/** Column mapping for the generic CSV/XLSX importer — which columns are which
 *  signal, the weight/temperature units, and where the header and data start.
 *  Built by the ColumnMapDialog when the auto-detect can't decide confidently. */
export interface ColumnMap {
  time: number;
  temperature: number;
  weight: number;
  weightPct?: number;
  dtg?: number;
  weightUnit: "mg" | "g" | "%";
  tempUnit: "C" | "K";
  headerRow: number;
  firstDataRow: number;
}

/** Weight-percent normalization strategy. */
export type NormMode = "first" | "sampleSize" | "max" | "atTemperature";

/** Per-run analysis parameters. Changing these recomputes the derived analysis. */
export interface AnalysisParams {
  /** How to convert recorded weight to percent. */
  normMode: NormMode;
  /** For `"atTemperature"` mode: the temperature whose interpolated weight is used as 100 %. */
  rezeroTempC: number | null;
  /** Savitzky–Golay window for DTG, forced odd and clamped to a minimum of 5. */
  dtgWindow: number;
  /** Display unit for DTG — both are computed, the figure/plot picks one. */
  dtgUnit: "%/°C" | "%/min";
  /** Decomposition temperatures: temperatures at which weight % first falls below 100 − threshold. */
  tdThresholds: number[];
  /** Minimum mass loss, in percent of the initial mass, for a DTG peak to count as a step. */
  stepMinLossPct: number;
  /** Temperature for residue report; null means the run's final temperature. */
  residueTempC: number | null;
}

/** One detected degradation step. */
export interface Step {
  /** Zero-based auto-detected step index; stable enough for keyed overrides. */
  index: number;
  /** Temperature at the DTG extremum (positive peak for mass loss). */
  tMax: number;
  /** Extrapolated onset temperature, or null when the tangents are degenerate. */
  tOnset: number | null;
  /** Extrapolated endset temperature, or null when the tangents are degenerate. */
  tEndset: number | null;
  /** Mass loss within the step window, in percent. */
  lossPct: number;
  /** Mass loss within the step window, in mg. */
  lossMg: number;
  /** [startT, endT] bounding temperatures of the step window. */
  tRange: [number, number];
}

/** Full computed analysis for a single TGA run. */
export interface TgaAnalysis {
  /** Weight percent, same length as the input arrays. */
  weightPct: Float64Array;
  /** DTG in the requested unit; NaN marks isothermal / guard gaps. */
  dtg: Float64Array;
  /** Threshold (e.g. 5, 10, 50) → temperature at which that decomposition level is crossed. */
  td: Record<number, number | null>;
  /** Detected degradation steps. */
  steps: Step[];
  /** Residue at the requested (or final) temperature. */
  residue: { tempC: number; pct: number; mg: number };
  /** Divisor used for normalization, so the UI can report the basis. */
  normDivisor: number;
  /** Non-fatal warnings the UI should surface. */
  warnings: string[];
}

/** Default analysis parameters — mirrors the WP3 specification. */
export const DEFAULT_PARAMS: AnalysisParams = {
  normMode: "first",
  rezeroTempC: null,
  dtgWindow: 21,
  dtgUnit: "%/°C",
  tdThresholds: [5, 10, 50],
  stepMinLossPct: 1,
  residueTempC: null,
};

/** A material group — a named collection of runs, for mean±SD comparison. */
export interface TgaMaterial {
  id: string;
  name: string;
  /** Member run ids, in display order. */
  runIds: string[];
}

/** One TGA run in the store — a parsed run plus the per-run display state
 *  (id, color, visibility, scale, offset, material assignment). The store
 *  memoizes the computed `analysis` on top of this. */
export interface TgaRun {
  id: string;
  /** Grouping key — one file can yield many runs. */
  fileId: string;
  fileName: string;
  label: string;
  color: string;
  meta: TgaMetadata;
  segments: TgaSegment[];
  timeMin: Float64Array;
  tempC: Float64Array;
  weightMg: Float64Array;
  /** Vendor-supplied weight % when present. */
  weightPctFile?: Float64Array;
  /** Vendor-supplied derivative when present. */
  dtgFile?: Float64Array;
  /** Per-run display multiplier (default 1). */
  scale: number;
  /** Per-run vertical offset (default 0). */
  offset: number;
  visible: boolean;
  /** Material group id, or null when unassigned. */
  materialId: string | null;
}

/** A loaded file in the store — one file can produce many runs. */
export interface TgaLoadedFile {
  id: string;
  fileName: string;
  runCount: number;
  warnings: string[];
}

/** The raw store state (before the derived analysis memo layer). */
export interface TgaState {
  files: TgaLoadedFile[];
  runs: TgaRun[];
  materials: TgaMaterial[];
  params: AnalysisParams;
  /** The run designated as the blank for buoyancy correction, or null. */
  blankRunId: string | null;
}
