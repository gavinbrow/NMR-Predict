// Shared types for the Tensile workspace.
//
// Phase 1 covers the *parsing* model: what a zwickRoell / Instron Excel export
// looks like once normalized into in-memory runs. Phase 2 adds the computed
// mechanical properties (`RunProps`), and Phase 3 adds the analysis parameters
// (`AnalysisParams`) plus the store's domain model (`Specimen`, `Material`,
// `LoadedFile`, `Selection`).

/**
 * One detected stress–strain run — i.e. one specimen's curve, faithful to the
 * Python `detect_runs` output. `strain` and `stress` are parallel arrays of the
 * raw numbers exactly as they appeared in the sheet (no cleaning yet; that is
 * Phase 2's `_clean`). `strainIsPercent` records whether the strain numbers are
 * already in percent or are a mm/mm fraction.
 */
export interface RawRun {
  /** Worksheet the run was read from (e.g. "Specimen 1"). */
  sheet: string;
  /**
   * Display label, assigned the way the Python driver does: the sheet name when
   * a sheet holds a single run, else `"<sheet> – run <k>"`.
   */
  label: string;
  /** 0-based column index of the strain column in the source sheet. */
  strainCol: number;
  /** 0-based column index of the stress column in the source sheet. */
  stressCol: number;
  /** 1-based first/last data row in the source sheet (informational). */
  firstRow: number;
  lastRow: number;
  /** Raw strain values as found in the sheet (percent or fraction per the flag). */
  strain: number[];
  /** Raw stress values (MPa) aligned with `strain`. */
  stress: number[];
  /** True when strain is in percent, false when it is a mm/mm fraction. */
  strainIsPercent: boolean;
}

/** How a workbook's runs were found, for surfacing in the file report. */
export type DetectionMethod = "header" | "numeric" | "none";

/** A workbook-level strain-unit summary across all detected runs. */
export type StrainUnit = "%" | "mm/mm" | "mixed" | "n/a";

/**
 * The result of parsing one uploaded workbook: every detected run plus the
 * report the UI shows on the file's card (specimen count, skipped sheets,
 * strain unit, detection path).
 */
export interface ParsedWorkbook {
  /** Source file name as uploaded. */
  fileName: string;
  /** Every detected run, in sheet order then run order within a sheet. */
  runs: RawRun[];
  /** Names of sheets skipped as instrument metadata (Parameters/Results/…). */
  skippedSheets: string[];
  /** Whether the labelled-header path, the legacy numeric fallback, or neither matched. */
  detection: DetectionMethod;
  /** Strain unit summarized across runs: "%", "mm/mm", "mixed", or "n/a" when no runs. */
  strainUnit: StrainUnit;
  /**
   * The instrument's own per-specimen numbers from a `Results` sheet, keyed by
   * specimen label (e.g. "Specimen 1"). Absent/empty when the file has no such
   * sheet (Phase 8).
   */
  machine?: Record<string, MachineResults>;
}

// --------------------------------------------------------------------------- //
// Phase 2 — computed mechanical properties                                    //
// --------------------------------------------------------------------------- //

/**
 * The mechanical properties computed for one run, a faithful port of the Python
 * `extract_run` dict. Numeric fields use `NaN` for "not available" (e.g. an
 * offset yield that never crosses), mirroring the Python `np.nan`; the UI turns
 * `NaN` into "N/A". Strains are in percent, stresses/moduli in MPa.
 */
export interface RunProps {
  /** Young's modulus (MPa). */
  E_MPa: number;
  /** Young's modulus (GPa) = `E_MPa / 1000`. */
  E_GPa: number;
  /** Human-readable window/method string, e.g. "0.05–0.25% regr (n=7, R²=0.998)". */
  E_method: string;
  /** Tensile strength / UTS (MPa) = max stress. */
  uts_MPa: number;
  /** Strain at UTS (%). */
  strain_at_uts: number;
  /** Yield strength (MPa) — first stress maximum (ASTM D638). */
  yield_pk_MPa: number;
  /** Yield strain (%). */
  yield_pk_pct: number;
  /** 0.2% offset yield strength (MPa); `NaN` if the offset line never crosses. */
  yield_off_MPa: number;
  /** 0.2% offset yield strain (%). */
  yield_off_pct: number;
  /** Stress at break (MPa) — the break point per the break definition. */
  break_MPa: number;
  /** Elongation at break (%). */
  elong_break: number;
  /** Toughness (MJ/m³) — area under stress vs strain-as-fraction up to break. */
  toughness: number;
}

/**
 * The instrument's own per-specimen values, read from an export's `Results`
 * sheet when present (Phase 8). Keyed by the machine's column headers, mapped to
 * computed properties via `MACHINE_MAP` in `compute.ts`. Shown next to the
 * computed values for reference — never a pass/fail gate.
 */
export interface MachineResults {
  /** Young's modulus `Et` (MPa). */
  Et?: number;
  /** Tensile strength `sM` (MPa). */
  sM?: number;
  /** Strain at max force `eM` (%). */
  eM?: number;
  /** Stress at break `sB` (MPa). */
  sB?: number;
  /** Strain at break `eB` (%). */
  eB?: number;
}

/** Pooled statistics for one property across a group of specimens. */
export interface PropertyStats {
  mean: number;
  /** Sample standard deviation (ddof = 1); 0 when n = 1, `NaN` when n = 0. */
  sd: number;
  /** Coefficient of variation (%) = sd / mean × 100. */
  cv: number;
  n: number;
  min: number;
  max: number;
}

// --------------------------------------------------------------------------- //
// Phase 3 — analysis parameters & store domain model                          //
// --------------------------------------------------------------------------- //

/** How the break point (stress/elongation at break) is located on a curve. */
export type BreakDefinition =
  /** Last data point of the curve (the Python default). */
  | { mode: "last" }
  /** First point after UTS whose stress falls to `dropFrac × UTS` or below. */
  | { mode: "dropFromPeak"; dropFrac: number }
  /** First point after UTS whose stress falls to `threshold` MPa or below. */
  | { mode: "forceThreshold"; threshold: number };

/** Override for the auto-detected strain unit, per file/global. */
export type StrainUnitOverride = "auto" | "%" | "mm/mm";

/**
 * The tunable analysis parameters (Phase 6 drives these live). Defaults mirror
 * the Python CONFIG block: 0.05–0.25% modulus window, 0.2% offset, 2% peak-drop.
 */
export interface AnalysisParams {
  /** Lower strain bound for the modulus window (%). */
  eLo: number;
  /** Upper strain bound for the modulus window (%). */
  eHi: number;
  /** Offset for the offset-yield line, in % strain. */
  offsetPct: number;
  /** An intermediate yield must drop by this fraction × UTS to count. */
  peakDropFrac: number;
  /** How stress/elongation at break are located. */
  breakDefinition: BreakDefinition;
  /** Strain-unit override applied to every run when not "auto". */
  strainUnitOverride: StrainUnitOverride;
}

/**
 * One specimen in the store: its raw curve, its provenance, an exclude flag
 * (excluded specimens stay visible but are dropped from stats), and — derived,
 * not stored — the computed properties. `props` is filled by the store's
 * memoized recompute whenever the curve or the params change.
 */
export interface Specimen {
  /** Stable unique id. */
  id: string;
  /** Display label (the run's label, e.g. "Specimen 1"). */
  label: string;
  /** Source worksheet name. */
  sheet: string;
  /** Id of the LoadedFile this specimen came from. */
  fileId: string;
  /** Source file name (denormalized for display). */
  fileName: string;
  /** The parsed raw run. */
  raw: RawRun;
  /** Excluded from pooled statistics (still shown, greyed, on charts). */
  excluded: boolean;
  /** The instrument's own values for this specimen, when the file had a `Results` sheet. */
  machine?: MachineResults;
  /** Computed mechanical properties for the current params. */
  props: RunProps;
}

/** A named group of specimens treated as replicates of one material. */
export interface Material {
  id: string;
  name: string;
  /** Member specimen ids, in display order. */
  specimenIds: string[];
}

/** One uploaded workbook and the report shown on its card. */
export interface LoadedFile {
  id: string;
  fileName: string;
  /** Number of specimens detected in this file. */
  specimenCount: number;
  skippedSheets: string[];
  detection: DetectionMethod;
  strainUnit: StrainUnit;
}

/** Which property is plotted/highlighted (keys of the numeric `RunProps`). */
export type PropertyKey =
  | "E_MPa"
  | "E_GPa"
  | "uts_MPa"
  | "strain_at_uts"
  | "yield_pk_MPa"
  | "yield_pk_pct"
  | "yield_off_MPa"
  | "yield_off_pct"
  | "break_MPa"
  | "elong_break"
  | "toughness";

/** The shared "what's shown" selection driving the table and charts. */
export interface Selection {
  /** Highlighted material ids (empty = all). */
  materialIds: string[];
  /** Highlighted specimen ids (empty = all). */
  specimenIds: string[];
  /** The focused property for property-driven views. */
  property: PropertyKey;
}

// --------------------------------------------------------------------------- //
// Derived views (computed by the store, consumed by the UI)                   //
// --------------------------------------------------------------------------- //

/** Pooled statistics for a material, one entry per numeric property. */
export type MaterialStats = Partial<Record<PropertyKey, PropertyStats>>;

/**
 * A material enriched with its resolved specimens (with computed props) and the
 * pooled statistics over its *included* specimens — the shape the table, the
 * side panel, and the charts read from.
 */
export interface MaterialView extends Material {
  /** A stable display color for charts/legends. */
  color: string;
  /** Every member specimen, in order, with computed props. */
  specimens: Specimen[];
  /** The subset not excluded from statistics. */
  includedSpecimens: Specimen[];
  /** Per-property pooled stats over the included specimens. */
  stats: MaterialStats;
}
