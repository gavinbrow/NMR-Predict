// Ionization adducts.
//
// A core guardrail: never assume every peak is [M+H]+. MALDI of synthetic
// polymers is dominated by [M+Na]+ and [M+K]+, and silver is common for
// non-polar polymers. The user picks which adducts to consider; everything that
// converts between a neutral mass and an observed m/z flows through here, with
// mass shifts derived from the single element table (so they stay consistent
// with the formula and isotope tools).

import { ELECTRON_MASS, monoisotopicMass } from "./elements";
import type { Adduct } from "./types";

/**
 * Net mass added to the neutral for a cation adduct: the summed atom masses of
 * the attached species minus the mass of the removed electron(s).
 */
export function composedShift(atoms: Record<string, number>, charge: number): number {
  let mass = 0;
  for (const [symbol, count] of Object.entries(atoms)) {
    mass += monoisotopicMass(symbol) * count;
  }
  return mass - charge * ELECTRON_MASS;
}

/** The built-in positive-mode adducts, in rough order of MALDI prevalence. */
export const BUILTIN_ADDUCTS: Adduct[] = [
  { id: "H", label: "[M+H]+", massShift: composedShift({ H: 1 }, 1), charge: 1, builtin: true },
  { id: "Na", label: "[M+Na]+", massShift: composedShift({ Na: 1 }, 1), charge: 1, builtin: true },
  { id: "K", label: "[M+K]+", massShift: composedShift({ K: 1 }, 1), charge: 1, builtin: true },
  { id: "Li", label: "[M+Li]+", massShift: composedShift({ Li: 1 }, 1), charge: 1, builtin: true },
  {
    id: "NH4",
    label: "[M+NH4]+",
    massShift: composedShift({ N: 1, H: 4 }, 1),
    charge: 1,
    builtin: true,
  },
  { id: "Ag", label: "[M+Ag]+", massShift: composedShift({ Ag: 1 }, 1), charge: 1, builtin: true },
];

/**
 * The built-in negative-mode adducts. `charge` is negative; m/z is reported as a
 * positive magnitude (mass spectrometers display |m/z|), so the conversions below
 * use |charge|. Deprotonation removes a proton (H atom mass minus the electron);
 * anion attachment adds the species plus the extra electron.
 */
export const NEGATIVE_ADDUCTS: Adduct[] = [
  {
    id: "minusH",
    label: "[M−H]−",
    massShift: -(monoisotopicMass("H") - ELECTRON_MASS),
    charge: -1,
    builtin: true,
  },
  {
    id: "plusCl",
    label: "[M+Cl]−",
    massShift: monoisotopicMass("Cl") + ELECTRON_MASS,
    charge: -1,
    builtin: true,
  },
  {
    id: "formate",
    label: "[M+HCOO]−",
    massShift: composedShift({ H: 1, C: 1, O: 2 }, -1),
    charge: -1,
    builtin: true,
  },
  {
    id: "acetate",
    label: "[M+CH3COO]−",
    massShift: composedShift({ C: 2, H: 3, O: 2 }, -1),
    charge: -1,
    builtin: true,
  },
];

/** All built-in adducts, both polarities. */
export const ALL_BUILTIN_ADDUCTS: Adduct[] = [...BUILTIN_ADDUCTS, ...NEGATIVE_ADDUCTS];

/** Observed m/z for a neutral monoisotopic mass under a given adduct. */
export function ionMz(neutralMass: number, adduct: Adduct): number {
  return (neutralMass + adduct.massShift) / Math.abs(adduct.charge);
}

/** Neutral monoisotopic mass implied by an observed m/z under a given adduct. */
export function neutralMass(mz: number, adduct: Adduct): number {
  return mz * Math.abs(adduct.charge) - adduct.massShift;
}

let customCounter = 0;
/** Create a custom adduct from an atom composition (e.g. {Cs:1}). */
export function makeCustomAdduct(
  label: string,
  atoms: Record<string, number>,
  charge = 1,
): Adduct {
  customCounter += 1;
  return {
    id: `custom-${Date.now()}-${customCounter}`,
    label,
    massShift: composedShift(atoms, charge),
    charge,
    builtin: false,
  };
}

/** Look up an adduct by id within a list, falling back to [M+H]+. */
export function adductById(adducts: Adduct[], id: string): Adduct {
  return adducts.find((a) => a.id === id) ?? BUILTIN_ADDUCTS[0];
}
