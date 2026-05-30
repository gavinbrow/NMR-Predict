// Single source of truth for element masses used across the MALDI workspace.
//
// Every mass-bearing module (adducts, formula calculator, isotope simulation,
// end-group solver, molecular-weight stats) reads from here so there is exactly
// one authoritative value per isotope. Values are the 2021 CODATA / AME atomic
// masses; isotopic abundances are IUPAC representative values. Masses are in
// unified atomic mass units (Da); abundances are mole fractions that sum to ~1.0
// per element.
//
// This replaces RDKit's element tables from the original backend design — keeping
// it as plain data makes formula→mass and isotope envelopes transparent and
// testable in the browser with no native dependency.

export interface Isotope {
  /** Exact (monoisotopic-for-this-nuclide) mass in Da. */
  mass: number;
  /** Natural abundance as a mole fraction (0..1). */
  abundance: number;
}

export interface Element {
  symbol: string;
  /** Atomic number — handy for sorting / Kendrick / display. */
  z: number;
  /** Mass of the most abundant isotope (the "monoisotopic" mass). */
  monoisotopicMass: number;
  /** All natural isotopes, ordered by mass ascending. */
  isotopes: Isotope[];
}

/** Rest mass of the electron in Da — adduct/ion masses must account for it. */
export const ELECTRON_MASS = 0.00054857990907;

// The supported element set for the MALDI tools. Restricting to these keeps the
// formula-candidate search tractable and matches the chemistry these polymers
// and matrices are actually made of.
export const ELEMENTS: Record<string, Element> = {
  H: {
    symbol: "H",
    z: 1,
    monoisotopicMass: 1.0078250319,
    isotopes: [
      { mass: 1.0078250319, abundance: 0.999885 },
      { mass: 2.0141017779, abundance: 0.000115 },
    ],
  },
  Li: {
    symbol: "Li",
    z: 3,
    monoisotopicMass: 7.016003437,
    isotopes: [
      { mass: 6.0151228874, abundance: 0.0759 },
      { mass: 7.016003437, abundance: 0.9241 },
    ],
  },
  C: {
    symbol: "C",
    z: 6,
    monoisotopicMass: 12.0,
    isotopes: [
      { mass: 12.0, abundance: 0.9893 },
      { mass: 13.0033548378, abundance: 0.0107 },
    ],
  },
  N: {
    symbol: "N",
    z: 7,
    monoisotopicMass: 14.0030740052,
    isotopes: [
      { mass: 14.0030740052, abundance: 0.99636 },
      { mass: 15.0001088984, abundance: 0.00364 },
    ],
  },
  O: {
    symbol: "O",
    z: 8,
    monoisotopicMass: 15.9949146221,
    isotopes: [
      { mass: 15.9949146221, abundance: 0.99757 },
      { mass: 16.9991315, abundance: 0.00038 },
      { mass: 17.9991604, abundance: 0.00205 },
    ],
  },
  F: {
    symbol: "F",
    z: 9,
    monoisotopicMass: 18.9984031627,
    isotopes: [{ mass: 18.9984031627, abundance: 1.0 }],
  },
  Na: {
    symbol: "Na",
    z: 11,
    monoisotopicMass: 22.9897692809,
    isotopes: [{ mass: 22.9897692809, abundance: 1.0 }],
  },
  Si: {
    symbol: "Si",
    z: 14,
    monoisotopicMass: 27.9769265327,
    isotopes: [
      { mass: 27.9769265327, abundance: 0.922297 },
      { mass: 28.9764947, abundance: 0.046832 },
      { mass: 29.9737702, abundance: 0.030872 },
    ],
  },
  P: {
    symbol: "P",
    z: 15,
    monoisotopicMass: 30.97376151,
    isotopes: [{ mass: 30.97376151, abundance: 1.0 }],
  },
  S: {
    symbol: "S",
    z: 16,
    monoisotopicMass: 31.9720707,
    isotopes: [
      { mass: 31.9720707, abundance: 0.9499 },
      { mass: 32.9714585, abundance: 0.0075 },
      { mass: 33.9678668, abundance: 0.0425 },
      { mass: 35.9670809, abundance: 0.0001 },
    ],
  },
  Cl: {
    symbol: "Cl",
    z: 17,
    monoisotopicMass: 34.96885271,
    isotopes: [
      { mass: 34.96885271, abundance: 0.7576 },
      { mass: 36.9659026, abundance: 0.2424 },
    ],
  },
  K: {
    symbol: "K",
    z: 19,
    monoisotopicMass: 38.9637069,
    isotopes: [
      { mass: 38.9637069, abundance: 0.932581 },
      { mass: 39.9639987, abundance: 0.000117 },
      { mass: 40.961826, abundance: 0.067302 },
    ],
  },
  Br: {
    symbol: "Br",
    z: 35,
    monoisotopicMass: 78.9183376,
    isotopes: [
      { mass: 78.9183376, abundance: 0.5069 },
      { mass: 80.9162906, abundance: 0.4931 },
    ],
  },
  Ag: {
    symbol: "Ag",
    z: 47,
    monoisotopicMass: 106.905093,
    isotopes: [
      { mass: 106.905093, abundance: 0.51839 },
      { mass: 108.904756, abundance: 0.48161 },
    ],
  },
  I: {
    symbol: "I",
    z: 53,
    monoisotopicMass: 126.904473,
    isotopes: [{ mass: 126.904473, abundance: 1.0 }],
  },
};

/** Symbols of every supported element, in ascending atomic number. */
export const ELEMENT_SYMBOLS: string[] = Object.values(ELEMENTS)
  .sort((a, b) => a.z - b.z)
  .map((el) => el.symbol);

/**
 * Monoisotopic mass of a single element symbol. Throws on an unsupported symbol
 * so callers fail loudly rather than silently treating it as zero mass.
 */
export function monoisotopicMass(symbol: string): number {
  const el = ELEMENTS[symbol];
  if (!el) throw new Error(`Unsupported element: ${symbol}`);
  return el.monoisotopicMass;
}
