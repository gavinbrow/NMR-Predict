// Built-in polymer repeat-unit library + chemistry templates (Phase 4).
//
// A repeat-unit library lets the workspace name a detected Δm spacing ("≈44.03 Da
// → ethylene oxide / PEG") and pre-fill repeat + likely adducts from a known
// polymer class. Templates bundle a repeat unit with sensible end groups and
// adducts so a user can start from, say, "PMMA, Na/K" in one click. User-defined
// templates extend these and persist in IndexedDB (see project.ts).

import { exactMass, parseFormula } from "./formula";

export interface RepeatUnitEntry {
  id: string;
  name: string;
  /** Repeat-unit molecular formula (omitted for mass-only, user-supplied entries). */
  formula?: string;
  /** Monoisotopic repeat mass (Da); derived from the formula when one is given. */
  mass: number;
  /** Common abbreviation, e.g. "PEG". */
  abbr?: string;
}

function entry(id: string, name: string, formula: string, abbr?: string): RepeatUnitEntry {
  return { id, name, formula, abbr, mass: exactMass(parseFormula(formula)) };
}

/** A repeat unit known only by its measured mass (no formula), e.g. user-supplied. */
function massEntry(id: string, name: string, mass: number, abbr?: string): RepeatUnitEntry {
  return { id, name, mass, abbr: abbr ?? name };
}

/** Common synthetic-polymer repeat units, with monoisotopic masses. */
export const REPEAT_UNIT_LIBRARY: RepeatUnitEntry[] = [
  entry("peg", "Ethylene oxide (PEG/PEO)", "C2H4O", "PEG"),
  entry("ppg", "Propylene oxide (PPG)", "C3H6O", "PPG"),
  entry("ptmeg", "Tetrahydrofuran (PTMEG/PTHF)", "C4H8O", "PTHF"),
  entry("pdms", "Dimethylsiloxane (PDMS)", "C2H6OSi", "PDMS"),
  entry("pmma", "Methyl methacrylate (PMMA)", "C5H8O2", "PMMA"),
  entry("pma", "Methyl acrylate (PMA)", "C4H6O2", "PMA"),
  entry("ps", "Styrene (PS)", "C8H8", "PS"),
  entry("pla", "Lactide unit (PLA)", "C3H4O2", "PLA"),
  entry("pcl", "Caprolactone (PCL)", "C6H10O2", "PCL"),
  entry("pvp", "Vinylpyrrolidone (PVP)", "C6H9NO", "PVP"),
  entry("pib", "Isobutylene (PIB)", "C4H8", "PIB"),
  entry("pei", "Ethylenimine (PEI)", "C2H5N", "PEI"),
  entry("nylon6", "Caprolactam (Nylon-6)", "C6H11NO", "PA6"),
  entry("pet", "Ethylene terephthalate (PET)", "C10H8O4", "PET"),
  entry("pdmaema", "DMAEMA", "C8H15NO2", "PDMAEMA"),
  entry("pvc", "Vinyl chloride (PVC)", "C2H3Cl", "PVC"),
  // User-supplied repeat units (measured mass only).
  massEntry("dac0", "DAC0", 222.14),
  massEntry("dac1", "DAC1", 224.15),
  massEntry("dac2", "DAC2", 280.22),
  massEntry("dc1", "DC1", 240.14),
  massEntry("dc2", "DC2", 226.12),
  massEntry("dc4", "DC4", 282.11),
  massEntry("dc-1", "DC-1", 198.09),
];

/** Nearest repeat-unit library entry to a mass, within tolerance (Da). */
export function matchRepeatUnit(mass: number, toleranceDa = 0.15): RepeatUnitEntry | null {
  let best: RepeatUnitEntry | null = null;
  let bestDelta = toleranceDa;
  for (const e of REPEAT_UNIT_LIBRARY) {
    const delta = Math.abs(e.mass - mass);
    if (delta <= bestDelta) {
      bestDelta = delta;
      best = e;
    }
  }
  return best;
}

export interface ChemistryTemplate {
  id: string;
  name: string;
  /** Repeat mass (Da). */
  repeatMass: number;
  /** Optional repeat formula for display. */
  repeatFormula?: string;
  /** Optional end-group mass (Da). */
  endGroupMass?: number;
  /** Adduct ids to pre-select (matches adducts.ts ids). */
  adductIds: string[];
  /** True for the shipped templates (not user-created). */
  builtin?: boolean;
  note?: string;
  createdAt?: number;
}

/** Shipped starting templates for the most common MALDI polymer analyses. */
export const BUILTIN_TEMPLATES: ChemistryTemplate[] = [
  {
    id: "tpl-peg-na",
    name: "PEG diol, Na/K",
    repeatMass: REPEAT_UNIT_LIBRARY[0].mass,
    repeatFormula: "C2H4O",
    endGroupMass: 18.010565,
    adductIds: ["Na", "K", "H"],
    builtin: true,
    note: "Poly(ethylene glycol), H/OH termini; alkali adducts dominate.",
  },
  {
    id: "tpl-pmma-na",
    name: "PMMA, Na/K",
    repeatMass: REPEAT_UNIT_LIBRARY.find((e) => e.id === "pmma")!.mass,
    repeatFormula: "C5H8O2",
    adductIds: ["Na", "K"],
    builtin: true,
    note: "Poly(methyl methacrylate); commonly sodiated.",
  },
  {
    id: "tpl-pdms-ag",
    name: "PDMS, Ag/Na",
    repeatMass: REPEAT_UNIT_LIBRARY.find((e) => e.id === "pdms")!.mass,
    repeatFormula: "C2H6OSi",
    adductIds: ["Ag", "Na"],
    builtin: true,
    note: "Poly(dimethylsiloxane); silver cationization is common.",
  },
  {
    id: "tpl-ps-ag",
    name: "Polystyrene, Ag",
    repeatMass: REPEAT_UNIT_LIBRARY.find((e) => e.id === "ps")!.mass,
    repeatFormula: "C8H8",
    adductIds: ["Ag"],
    builtin: true,
    note: "Non-polar; silver adduct via dithranol/DCTB.",
  },
  // User-supplied DAC / DC repeat units (measured masses), commonly sodiated.
  ...(
    [
      ["dac0", "DAC0", 222.14],
      ["dac1", "DAC1", 224.15],
      ["dac2", "DAC2", 280.22],
      ["dc1", "DC1", 240.14],
      ["dc2", "DC2", 226.12],
      ["dc4", "DC4", 282.11],
      ["dc-1", "DC-1", 198.09],
    ] as const
  ).map(([id, name, mass]) => ({
    id: `tpl-${id}`,
    name: `${name} (${mass}), Na/K`,
    repeatMass: mass,
    adductIds: ["Na", "K", "H"],
    builtin: true,
    note: "User-supplied repeat unit.",
  })),
];
