// Matrix / background peak library.
//
// MALDI spectra are littered with peaks that are not the analyte: matrix ions and
// their clusters, alkali-salt adducts, ubiquitous PEG/PDMS contamination, solvent
// and plasticizer ions. This module *flags* such peaks so the interpretation
// steps can down-weight them — it never deletes them (a guardrail), because one
// experiment's contaminant is another's calibrant, and the user must stay in
// control.

import type { Peak } from "./types";

export type LibraryCategory =
  | "matrix"
  | "matrixCluster"
  | "salt"
  | "contaminant"
  | "solvent"
  | "plasticizer"
  | "calibrant";

export interface LibraryEntry {
  id: string;
  label: string;
  category: LibraryCategory;
  /** Singly-charged ion m/z (monoisotopic) of the known background species. */
  mz: number;
  note?: string;
}

/**
 * A starter library of common low-mass MALDI background ions. Masses are the
 * monoisotopic singly-charged ion m/z. This is intentionally conservative and
 * extendable; entries flag, never delete. (Matrix abbreviations: CHCA =
 * α-cyano-4-hydroxycinnamic acid, DHB = 2,5-dihydroxybenzoic acid, SA = sinapinic
 * acid, DCTB, dithranol.)
 */
export const BACKGROUND_LIBRARY: LibraryEntry[] = [
  // CHCA (M = 189.0426)
  { id: "chca-h", label: "CHCA [M+H]+", category: "matrix", mz: 190.0499 },
  { id: "chca-na", label: "CHCA [M+Na]+", category: "matrix", mz: 212.0318 },
  { id: "chca-k", label: "CHCA [M+K]+", category: "matrix", mz: 228.0058 },
  { id: "chca-2h", label: "CHCA [2M+H]+", category: "matrixCluster", mz: 379.0924 },
  { id: "chca-3h", label: "CHCA [3M+H]+", category: "matrixCluster", mz: 568.135 },
  // DHB (M = 154.0266)
  { id: "dhb-h2o-h", label: "DHB [M-H2O+H]+", category: "matrix", mz: 137.0233 },
  { id: "dhb-h", label: "DHB [M+H]+", category: "matrix", mz: 155.0339 },
  { id: "dhb-na", label: "DHB [M+Na]+", category: "matrix", mz: 177.0158 },
  { id: "dhb-2h-h2o", label: "DHB [2M-H2O+H]+", category: "matrixCluster", mz: 273.0757 },
  { id: "dhb-3h-2h2o", label: "DHB [3M-2H2O+H]+", category: "matrixCluster", mz: 409.1129 },
  // Sinapinic acid (M = 224.0685)
  { id: "sa-h", label: "SA [M+H]+", category: "matrix", mz: 225.0757 },
  { id: "sa-na", label: "SA [M+Na]+", category: "matrix", mz: 247.0577 },
  // DCTB (M = 250.1470)
  { id: "dctb-h", label: "DCTB [M+H]+", category: "matrix", mz: 251.1543 },
  { id: "dctb-na", label: "DCTB [M+Na]+", category: "matrix", mz: 273.1362 },
  // Dithranol (M = 226.0630)
  { id: "dithranol-h", label: "Dithranol [M+H]+", category: "matrix", mz: 227.0703 },
  // Common alkali-salt clusters (sodium/potassium formate/acetate adducts vary;
  // these are representative NaI/CsI-style calibration cluster spacings).
  { id: "salt-na-cl", label: "Na2Cl+ salt cluster", category: "salt", mz: 80.9485 },
  { id: "salt-k-cl", label: "K2Cl+ salt cluster", category: "salt", mz: 112.8964 },
  // Plasticizers / solvents
  { id: "dehp", label: "DEHP plasticizer [M+H]+", category: "plasticizer", mz: 391.2843 },
  { id: "dbp", label: "Dibutyl phthalate [M+H]+", category: "plasticizer", mz: 279.1591 },
  { id: "palmitamide", label: "Palmitamide (slip agent) [M+H]+", category: "contaminant", mz: 256.2635 },
  { id: "erucamide", label: "Erucamide (slip agent) [M+H]+", category: "contaminant", mz: 338.3417 },
];

export interface FlagOptions {
  /** Match tolerance in Da (default 0.3). */
  toleranceDa?: number;
  /** Restrict to these categories (default: all). */
  categories?: LibraryCategory[];
  /** Don't overwrite a flag already set on a peak (e.g. "isotope"). */
  preserveExisting?: boolean;
}

export interface FlagResult {
  peaks: Peak[];
  /** Count of peaks newly flagged, by category. */
  counts: Record<string, number>;
}

/**
 * Return a new peak list with library matches tagged via `peak.flag` (set to the
 * matching category). Peaks are never removed. The nearest library entry within
 * tolerance wins.
 */
export function flagBackground(
  peaks: Peak[],
  library: LibraryEntry[] = BACKGROUND_LIBRARY,
  options: FlagOptions = {},
): FlagResult {
  const tol = options.toleranceDa ?? 0.3;
  const allowed = options.categories ? new Set(options.categories) : null;
  const counts: Record<string, number> = {};

  const peaksOut = peaks.map((peak) => {
    if (options.preserveExisting && peak.flag) return peak;
    let bestEntry: LibraryEntry | null = null;
    let bestDelta = Infinity;
    for (const entry of library) {
      if (allowed && !allowed.has(entry.category)) continue;
      const delta = Math.abs(entry.mz - peak.mz);
      if (delta <= tol && delta < bestDelta) {
        bestDelta = delta;
        bestEntry = entry;
      }
    }
    if (!bestEntry) return peak;
    counts[bestEntry.category] = (counts[bestEntry.category] ?? 0) + 1;
    return { ...peak, flag: bestEntry.category, label: peak.label ?? bestEntry.label };
  });

  return { peaks: peaksOut, counts };
}
