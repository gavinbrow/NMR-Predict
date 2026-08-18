/**
 * GC/MS workspace data model.
 *
 * `MsRun` stores its points CSR-style (compressed sparse row, like SciPy's CSR):
 * instead of one `{mz, intensity}[]` per scan, all scans' points are concatenated
 * into two flat arrays (`mz`, `intensity`) and `scanOffset` indexes them. Scan
 * `i` occupies the half-open range `[scanOffset[i], scanOffset[i + 1])`. A
 * 3306-scan run with ~50 points per scan is therefore three typed arrays plus a
 * 3307-length offset array, which is dramatically cheaper than 3306 small
 * objects and is structured-cloneable across the worker boundary.
 *
 * Within every scan, `mz` is ASCENDING. The view layer's binary searches and the
 * `unionMzColumns` grid merge both rely on this invariant.
 *
 * This is a type-only module — interfaces and type aliases only. Other packages
 * (parsers, the worker, the plot components) are written against this contract,
 * so do not change field names or shapes without coordinating.
 */

/** One loaded run. Points are stored CSR-style so a 3306-scan run is 3 typed arrays. */
export interface MsRun {
  id: string;                    // crypto.randomUUID()
  name: string;                  // "ACSDCPD.D"
  sourcePath: string;            // folder/path for the panel title line
  format:
    | "agilent-ms"
    | "agilent-ch"
    | "waters-raw"
    | "mzml"
    | "mzxml"
    | "mgf"
    | "andi"
    | "csv"
    | "jcamp";
  detector: "ms" | "uv" | "fid"; // "ms" => has scans; others are chromatogram-only

  // per-scan, length = scanCount
  rtMin: Float64Array;
  tic: Float64Array;
  basePeakMz: Float64Array;
  basePeakIntensity: Float64Array;
  msLevel: Uint8Array;

  // ragged point store: scan i occupies [scanOffset[i], scanOffset[i+1])
  scanOffset: Uint32Array;       // length scanCount + 1
  mz: Float64Array;              // ASCENDING within every scan
  intensity: Float32Array;

  scanCount: number;
  pointCount: number;
  mzRange: [number, number];
  rtRange: [number, number];
  ticRange: [number, number];
  meta: RunMeta;
  warnings: string[];
  /** Additional detector channels that belong to the same vendor run folder. */
  chromatograms?: RunChromatogram[];
}

/** A non-MS chromatogram stored beside the primary data file in a vendor run. */
export interface RunChromatogram {
  name: string;
  sourcePath: string;
  detector: "uv" | "fid";
  rtMin: Float64Array;
  intensity: Float64Array;
  rtRange: [number, number];
  intensityRange: [number, number];
  meta: RunMeta;
  warnings: string[];
}

/** A chromatogram drawn in the top panel. */
export interface ChromTrace {
  id: string;
  runId: string;
  kind: "TIC" | "BPC" | "XIC" | "UV" | "FID" | "TIC-bg";
  label: string;                 // "TIC", "XIC 162.30 +/- 0.30"
  rtMin: Float64Array;
  intensity: Float64Array;
  color: string;
  visible: boolean;
  offset: number;                // session-only
  scale: number;                 // session-only; per-trace intensity gain (1 = unscaled)
}

/** A spectrum drawn in the bottom panel. */
export interface MassSpectrum {
  runId: string;
  mz: Float64Array;              // ascending
  intensity: Float64Array;
  label: string;                 // "MS scan 1247 - RT 7.401" | "MS + spectrum 3.09..7.09"
  rtLo: number;
  rtHi: number;
  scanCount: number;             // scans combined
  basePeak: { mz: number; intensity: number } | null;
}

export interface ChromPeak {
  id: string;
  runId: string;
  traceId: string;
  rtApex: number;
  rtStart: number;
  rtEnd: number;
  scanApex: number;
  height: number;
  area: number;
  areaPct: number;
  basePeakMz: number | null;
  name?: string;                 // user-editable
}

export interface SpecPeak {
  id: string;
  mz: number;
  intensity: number;
  relPct: number;
  /** Predicted-spectrum only (bug 4a): which ion this stick is ("M+", "M+1",
   *  "M−CH3", "cleavage", ...) — set by `predictEiSpectrum`, undefined for
   *  every real (measured) peak. */
  ion?: string;
}

/** A spectrum peak explicitly added by the user against a specific run/slot.
 *  Kept separate from the derived `specPeaks` list so it survives re-picks. */
export interface ManualSpecPeak extends SpecPeak {
  runId: string;
  slotId: string;
}

/** A picked mass-spectrum peak with the chromatographic peak that produced it.
 * Live-view rows use `sourceLabel` without chromatographic RT bounds. */
export interface SpectrumPeakRow extends SpecPeak {
  sourcePeakId?: string;
  sourceLabel: string;
  sourceRtStart?: number;
  sourceRtEnd?: number;
}

export interface GcmsTuneInfo {
  tuneFile?: string;
  tuneDate?: string;
  emissionCurrent?: number;
  electronEnergy?: number;
  emVolts?: number;
  massAxisGain?: number;
  massAxisOffset?: number;
  entries?: { key: string; value: string }[];
}

export interface RunMeta {
  operator?: string;
  sample?: string;
  method?: string;
  instrument?: string;
  serialNumber?: string;
  acquiredDate?: string;
  inlet?: string;
  tuneFile?: string;
  tuneDate?: string;
  ionization?: "EI" | "CI" | "ESI" | "APCI" | "unknown";
  ciReagent?: string;
  polarity?: "+" | "-" | null;
  scanMode?: string;
  lowMass?: number;
  highMass?: number;
  solventDelayMin?: number;
  runTimeMin?: number;
  sourceTemp?: number;
  quadTemp?: number;
  ovenInitialTempC?: number;
  ovenRamps?: { rate: number; finalTemp: number; finalTime: number }[];
  scanSegments?: { start: number; lowMass: number; highMass: number }[];
  threshold?: number;
  tune?: GcmsTuneInfo;
  raw?: { acqmeth?: string; prePost?: string; cnorm?: string };
}

/** A run as presented in the workspace. color/visible/offset are SESSION-ONLY:
 *  never persisted, never undoable. */
export interface GcmsDocument {
  id: string;
  name: string;
  run: MsRun;
  color: string;
  visible: boolean;
  offset: number;
}

/** Generic XY pair used by the view layer and the plot components. */
export interface XYSeries {
  x: Float64Array;
  y: Float64Array;
}

// ---------------------------------------------------------------------------
// Spectrum slots (Phase 4 task A) — the bottom panel is no longer a single
// derived spectrum; it's an explicit list of "slots" the user can add to,
// freeze, and re-mode. `lib/gcms/slots.ts` resolves these against an `MsRun`.
// ---------------------------------------------------------------------------

/**
 * How a {@link SpectrumSlot}'s spectrum is derived from the active run:
 *  - "cursor" follows the live pin/hover (falling back to the highest-TIC
 *    scan) — this is what the ORIGINAL single `spectra` memo always showed.
 *  - "scan" is a frozen single scan at a fixed RT ("Add spectrum").
 *  - "range" sums one or more RT windows (multi-region select, task D); more
 *    than one region is a user gesture (shift-drag), not a single combined
 *    window.
 */
export type SpectrumSlotSource =
  | { kind: "cursor" }
  | { kind: "scan"; rt: number }
  | { kind: "range"; regions: [number, number][] };

/**
 * One row in the bottom spectrum stack. `mode` controls how the slot's
 * resolved spectrum is composited with the others:
 *  - "stack" — its own panel.
 *  - "overlay" — drawn into the panel of the PRECEDING stack/background slot
 *    (array order), not a panel of its own.
 *  - "background" — subtracted from every non-background slot's spectrum
 *    (see `applyBackgroundSubtraction` in `lib/gcms/slots.ts`), while still
 *    rendering its OWN (unsubtracted) panel so the user can see what they're
 *    subtracting. Switching a background slot's mode back to "stack" turns
 *    the subtraction off without deleting it.
 */
export interface SpectrumSlot {
  id: string;
  source: SpectrumSlotSource;
  /** Run sampled by a chromatogram drag. Cursor/frozen slots omit this and
   * continue to follow the active document. */
  runId?: string;
  label: string;
  color: string;
  mode: "stack" | "overlay" | "background";
}

/**
 * A frozen spectrum saved for cross-document comparison. Unlike
 * {@link SpectrumSlot}, this stores the already-resolved spectrum so it is
 * independent of the active run and remains usable after its source document
 * is switched or closed.
 */
export interface ComparisonSpectrumItem {
  id: string;
  documentId: string;
  documentName: string;
  sourceSlotId: string;
  label: string;
  color: string;
  spectrum: MassSpectrum;
  peaks: SpecPeak[];
}
