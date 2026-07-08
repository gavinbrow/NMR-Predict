// Shared types for the MALDI workspace: the spectrum/peak/series data model, the
// persisted project shape, and the typed Web Worker message protocol.
//
// The worker protocol is built around a single `WorkerOpMap`: each compute
// operation declares its request and result types in one place, and both the
// worker dispatcher and the client are typed off that map. Adding an op in a
// later phase means adding one entry here — the client/worker signatures follow.

// ---------------------------------------------------------------------------
// Core data model
// ---------------------------------------------------------------------------

/**
 * A pair of parallel arrays. `mz[i]` and `intensity[i]` describe one point.
 * Float64Array is structured-cloneable, so it crosses the worker boundary and
 * lands in IndexedDB without conversion.
 */
export interface SpectrumData {
  mz: Float64Array;
  intensity: Float64Array;
}

/** One processing step, stored in order so processed data is always re-derivable. */
export interface ProcessingStep {
  /** Stable id for list keys / reordering in the UI. */
  id: string;
  kind: ProcessingKind;
  /** Free-form parameter bag echoed back into the UI so assumptions stay visible. */
  params: Record<string, number | string | boolean | null>;
  /** User can disable a step without deleting it (keeps automation reversible). */
  enabled: boolean;
}

export type ProcessingKind =
  | "baseline"
  | "smooth"
  | "normalize"
  | "crop"
  | "calibrate";

/** A picked peak. Optional fields are filled in by later-phase annotation. */
export interface Peak {
  id: string;
  mz: number;
  intensity: number;
  /** Local signal-to-noise from the sliding-window estimate. */
  snr?: number;
  /** Full width (in m/z) at the picking threshold. */
  width?: number;
  /** Centroid-refined m/z, when centroiding is enabled. */
  centroid?: number;
  /** 0..1 picker confidence. */
  confidence?: number;
  /** User decisions — automation is always overridable. */
  accepted?: boolean;
  locked?: boolean;
  ignored?: boolean;
  /** Library/background flag (e.g. matrix, salt, solvent) — flagged, never deleted. */
  flag?: string;
  label?: string;
  /** User-assigned colour (hex) for this peak, surfaced on the plot + table. */
  color?: string;
}

/** A candidate ionization adduct, e.g. [M+Na]+. */
export interface Adduct {
  id: string;
  label: string;
  /** Net mass added to the neutral (already accounting for the electron). */
  massShift: number;
  /** Number of charges (positive for cations). */
  charge: number;
  builtin: boolean;
}

/** An assigned oligomer series: m/z ≈ endGroupMass + n·repeatMass + adduct. */
export interface Series {
  id: string;
  label: string;
  repeatMass: number;
  endGroupMass: number;
  adductId: string;
  /** Peak ids that matched this series, with their oligomer number n. */
  members: { peakId: string; n: number }[];
  /** Scoring breakdown surfaced in the UI. */
  score: number;
  meanErrorDa?: number;
  /** R² of the neutral-mass-vs-n regression (how cleanly the ladder fits). */
  r2?: number;
  /** Free-form description / annotation set after the analyst identifies the series. */
  description?: string;
  /** Name of the assigned end group (from the library or manual entry). */
  endGroupLabel?: string;
  /** User-assigned colour (hex); falls back to the positional palette when unset. */
  color?: string;
  /** When true, manual/assigned end-group mass is preserved across member edits. */
  endGroupLocked?: boolean;
  /** When another adduct reading of the SAME peaks has been confirmed, this holds
   *  that confirmed series' id. Superseded series are hidden from the pending list
   *  but kept in state so a delete can restore them. */
  supersededBy?: string;
}

// ---------------------------------------------------------------------------
// Persisted project (IndexedDB)
// ---------------------------------------------------------------------------

/**
 * Everything needed to reproduce a workspace view. `rawSpectrum` is written once
 * and never overwritten; `processedSpectrum` is a cache that can always be
 * rebuilt from `rawSpectrum` + `processing`. The remaining fields capture the
 * interpretation state so reloading a project restores the exact view.
 */
export interface ProjectState {
  /** Original imported file name, for display. */
  sourceName: string;
  rawSpectrum: SpectrumData | null;
  processedSpectrum: SpectrumData | null;
  /** Ordered list of processing steps. */
  processing: ProcessingStep[];
  peaks: Peak[];
  /** User-defined custom adducts (built-ins are not persisted). */
  adducts: Adduct[];
  series: Series[];
  /** Ids of the adducts currently selected for annotation. */
  selectedAdductIds?: string[];
  /** Peak-picking parameters last used. */
  pickParams?: PeakPickParams;
  /** Active repeat unit for series / end-group analysis. */
  repeatMass?: number;
  /** Base repeat unit for the Kendrick plot. */
  baseRepeat?: number;
  /** Active end-group mass for the current repeat unit. */
  endGroupMass?: number;
  /** Fold isotope-shifted spacings into one repeat unit on detect. */
  repeatIsotopeAware?: boolean;
  /** Split a repeat unit into its distinct interleaved ladders. */
  splitSeries?: boolean;
  /** Copolymer repeat A mass (for copolymer detection). */
  copolymerA?: number;
  /** Copolymer repeat B mass (for copolymer detection). */
  copolymerB?: number;
  /** Log of exports performed from this project. */
  exportHistory?: ExportRecord[];
}

/** One entry in a project's export history. */
export interface ExportRecord {
  /** What was exported (e.g. "report-pdf", "peaks-csv", "project-json"). */
  kind: string;
  /** Display label shown in the history list. */
  label: string;
  at: number;
}

/** A stored project record (envelope around {@link ProjectState}). */
export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  state: ProjectState;
}

/** Lightweight row for the project picker — avoids loading full spectra. */
export interface ProjectSummary {
  id: string;
  name: string;
  sourceName: string;
  createdAt: number;
  updatedAt: number;
  pointCount: number;
  peakCount: number;
}

/** A fresh, empty project state. */
export function emptyProjectState(sourceName = ""): ProjectState {
  return {
    sourceName,
    rawSpectrum: null,
    processedSpectrum: null,
    processing: [],
    peaks: [],
    adducts: [],
    series: [],
  };
}

// ---------------------------------------------------------------------------
// Worker protocol
// ---------------------------------------------------------------------------

// Type-only imports of each compute module's request/result shapes. These are
// erased at build time, so referencing them here does NOT pull the heavy compute
// (and its libraries) into the main-thread bundle — only the worker imports the
// runtime. The result is a single typed contract the worker and client share.
import type { FlagOptions, FlagResult } from "./library";
import type { ParseOptions, ParseResult } from "./parse";
import type { PeakPickParams } from "./peaks";
import type { AssignOptions, RepeatCandidate, RepeatDetectOptions } from "./polymers";
import type { CopolymerOptions, CopolymerSeries } from "./polymers";
import type { KendrickPoint } from "./kendrick";
import type { EndGroupCandidate, EndGroupOptions } from "./endgroups";
import type { FormulaCandidate, FormulaCandidateOptions } from "./formula";
import type { LossEvent, LossDetectOptions } from "./losses";
import type { MsParseResult } from "./parseMs";

/**
 * Every worker operation: `request` is the payload sent in, `result` is what
 * comes back. `ping` is a liveness/echo check; the rest are the Phase 1/2 compute
 * ops. Adding an op here is the only change the worker and client need — both are
 * typed off this map.
 */
export interface WorkerOpMap {
  ping: {
    request: { echo?: string };
    result: { pong: true; echo?: string; receivedAt: number };
  };
  parse: {
    request: { text: string; options?: ParseOptions };
    result: ParseResult;
  };
  process: {
    request: { raw: SpectrumData; steps: ProcessingStep[] };
    result: { processed: SpectrumData };
  };
  pickPeaks: {
    request: { spectrum: SpectrumData; params: PeakPickParams };
    result: { peaks: Peak[] };
  };
  flagBackground: {
    request: { peaks: Peak[]; options?: FlagOptions };
    result: FlagResult;
  };
  detectRepeatUnits: {
    request: { peaks: Peak[]; options?: RepeatDetectOptions };
    result: { candidates: RepeatCandidate[] };
  };
  assignSeries: {
    request: { peaks: Peak[]; repeatMass: number; adducts: Adduct[]; options?: AssignOptions };
    result: { series: Series[] };
  };
  kendrick: {
    request: { peaks: Peak[]; baseRepeat: number };
    result: { points: KendrickPoint[] };
  };
  solveEndGroups: {
    request: {
      peaks: Peak[];
      repeatMass: number;
      adducts: Adduct[];
      options?: EndGroupOptions;
    };
    result: { candidates: EndGroupCandidate[] };
  };
  formulaCandidates: {
    request: { targetNeutralMass: number; options?: FormulaCandidateOptions };
    result: { candidates: FormulaCandidate[] };
  };
  detectLosses: {
    request: { peaks: Peak[]; options?: LossDetectOptions };
    result: { events: LossEvent[] };
  };
  detectCopolymer: {
    request: { peaks: Peak[]; adducts: Adduct[]; options?: CopolymerOptions };
    result: { series: CopolymerSeries[] };
  };
  parseMs: {
    request: { buffer: ArrayBuffer; fileName: string };
    result: MsParseResult;
  };
}

export type WorkerOp = keyof WorkerOpMap;
export type WorkerRequestPayload<Op extends WorkerOp> = WorkerOpMap[Op]["request"];
export type WorkerResultPayload<Op extends WorkerOp> = WorkerOpMap[Op]["result"];

/** Client → worker: a correlated request, or a cancellation of a prior id. */
export type WorkerRequestMessage =
  | {
      kind: "request";
      /** Correlation id, unique per in-flight request. */
      id: string;
      op: WorkerOp;
      payload: WorkerRequestPayload<WorkerOp>;
    }
  | { kind: "cancel"; id: string };

/** Worker → client: terminal success/error, or an interim progress tick. */
export type WorkerResponseMessage =
  | { kind: "result"; id: string; result: WorkerResultPayload<WorkerOp> }
  | { kind: "error"; id: string; error: { name: string; message: string } }
  | { kind: "progress"; id: string; progress: number; message?: string };