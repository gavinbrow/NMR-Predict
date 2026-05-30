// Molecular-formula tools: exact/nominal mass, isotope-pattern simulation, and a
// bounded formula-candidate generator. Everything reads element masses and
// natural abundances from the single `elements.ts` table, so masses here stay
// consistent with the adduct and end-group calculators.
//
// Isotope patterns are built by convolving each element's natural isotope
// distribution (Cl/Br/Ag/S envelopes fall out of this automatically). The
// candidate generator is a remaining-mass-pruned depth-first search with an
// RDBE sanity filter — it runs in the worker because the search can be heavy.

import { ELEMENTS, ELEMENT_SYMBOLS } from "./elements";

export type FormulaCounts = Record<string, number>;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a molecular formula into element → count, supporting nested groups with
 * multipliers, e.g. "C2H4O", "CH3(CH2)4CH3", "C6H5OH", "(C2H4O)10H2O". Throws on
 * malformed input or an element outside the supported set so callers fail loudly.
 */
export function parseFormula(formula: string): FormulaCounts {
  const text = formula.replace(/\s+/g, "");
  if (!text) return {};

  let i = 0;

  const parseGroup = (): FormulaCounts => {
    const counts: FormulaCounts = {};
    while (i < text.length) {
      const ch = text[i];
      if (ch === "(" || ch === "[") {
        i += 1;
        const inner = parseGroup();
        const close = ch === "(" ? ")" : "]";
        if (text[i] !== close) throw new Error(`Unbalanced "${ch}" in formula`);
        i += 1;
        const mult = readInt();
        for (const [sym, n] of Object.entries(inner)) {
          counts[sym] = (counts[sym] ?? 0) + n * mult;
        }
      } else if (ch === ")" || ch === "]") {
        break;
      } else if (/[A-Z]/.test(ch)) {
        const sym = readElement();
        const n = readInt();
        if (!ELEMENTS[sym]) throw new Error(`Unsupported element: ${sym}`);
        counts[sym] = (counts[sym] ?? 0) + n;
      } else {
        throw new Error(`Unexpected character "${ch}" in formula`);
      }
    }
    return counts;
  };

  const readElement = (): string => {
    let sym = text[i];
    i += 1;
    if (i < text.length && /[a-z]/.test(text[i])) {
      sym += text[i];
      i += 1;
    }
    return sym;
  };

  const readInt = (): number => {
    let digits = "";
    while (i < text.length && /[0-9]/.test(text[i])) {
      digits += text[i];
      i += 1;
    }
    return digits ? parseInt(digits, 10) : 1;
  };

  const result = parseGroup();
  if (i < text.length) throw new Error(`Trailing characters in formula at "${text.slice(i)}"`);
  return result;
}

/** Canonical Hill-system rendering of a count map (C, H, then alphabetical). */
export function formatFormula(counts: FormulaCounts): string {
  const symbols = Object.keys(counts).filter((s) => counts[s] > 0);
  const ordered: string[] = [];
  if (counts.C) ordered.push("C");
  if (counts.H) ordered.push("H");
  for (const s of symbols.sort()) {
    if (s !== "C" && s !== "H") ordered.push(s);
  }
  return ordered.map((s) => (counts[s] === 1 ? s : `${s}${counts[s]}`)).join("");
}

// ---------------------------------------------------------------------------
// Masses
// ---------------------------------------------------------------------------

/** Monoisotopic (exact) mass of a count map in Da. */
export function exactMass(counts: FormulaCounts): number {
  let mass = 0;
  for (const [sym, n] of Object.entries(counts)) {
    const el = ELEMENTS[sym];
    if (!el) throw new Error(`Unsupported element: ${sym}`);
    mass += el.monoisotopicMass * n;
  }
  return mass;
}

/** Integer nominal mass (sum of the most-abundant isotopes' mass numbers). */
export function nominalMass(counts: FormulaCounts): number {
  let mass = 0;
  for (const [sym, n] of Object.entries(counts)) {
    const el = ELEMENTS[sym];
    if (!el) throw new Error(`Unsupported element: ${sym}`);
    mass += Math.round(el.monoisotopicMass) * n;
  }
  return mass;
}

export interface FormulaMassResult {
  formula: string;
  counts: FormulaCounts;
  exact: number;
  nominal: number;
  /** Ring + double-bond equivalents (degree of unsaturation). */
  rdbe: number;
}

/** Parse a formula and return its masses and RDBE in one call. */
export function formulaMass(formula: string): FormulaMassResult {
  const counts = parseFormula(formula);
  return {
    formula: formatFormula(counts),
    counts,
    exact: exactMass(counts),
    nominal: nominalMass(counts),
    rdbe: rdbe(counts),
  };
}

/**
 * Ring + double-bond equivalents: 1 + Σ nᵢ(vᵢ−2)/2 over atoms with valence vᵢ.
 * Uses representative valences for the supported elements; halogens count as
 * monovalent, O/S divalent, N/P trivalent, C/Si tetravalent.
 */
export function rdbe(counts: FormulaCounts): number {
  const valence: Record<string, number> = {
    C: 4, Si: 4,
    N: 3, P: 3,
    O: 2, S: 2,
    H: 1, F: 1, Cl: 1, Br: 1, I: 1, Li: 1, Na: 1, K: 1, Ag: 1,
  };
  let sum = 0;
  for (const [sym, n] of Object.entries(counts)) {
    const v = valence[sym] ?? 0;
    sum += n * (v - 2);
  }
  return 1 + sum / 2;
}

// ---------------------------------------------------------------------------
// Isotope pattern simulation
// ---------------------------------------------------------------------------

export interface IsotopePeak {
  /** Centroid mass of this isotopologue group (Da). */
  mass: number;
  /** Relative abundance, normalized so the most abundant peak = 1. */
  abundance: number;
}

export interface IsotopeOptions {
  /** Merge tolerance for combining near-identical-mass combinations (Da). */
  mergeTol?: number;
  /** Drop peaks below this fraction of the base peak. Default 1e-3. */
  minAbundance?: number;
  /** Cap on returned peaks (most abundant first by mass order). Default 24. */
  maxPeaks?: number;
  /** Collapse to nominal (unit) mass spacing — typical for MALDI envelopes. */
  unitResolution?: boolean;
}

type Dist = { mass: number; prob: number }[];

function mergeAndPrune(combos: Dist, mergeTol: number, pruneRel: number, cap: number): Dist {
  if (combos.length === 0) return combos;
  combos.sort((a, b) => a.mass - b.mass);
  const merged: Dist = [];
  let curMass = combos[0].mass * combos[0].prob;
  let curProb = combos[0].prob;
  let curRef = combos[0].mass;
  for (let i = 1; i < combos.length; i += 1) {
    const c = combos[i];
    if (c.mass - curRef <= mergeTol) {
      curMass += c.mass * c.prob;
      curProb += c.prob;
    } else {
      merged.push({ mass: curMass / curProb, prob: curProb });
      curMass = c.mass * c.prob;
      curProb = c.prob;
      curRef = c.mass;
    }
  }
  merged.push({ mass: curMass / curProb, prob: curProb });

  let max = 0;
  for (const m of merged) if (m.prob > max) max = m.prob;
  const threshold = max * pruneRel;
  const kept = merged.filter((m) => m.prob >= threshold);
  if (kept.length <= cap) return kept;
  // Too many peaks: keep the most probable `cap`, then re-sort by mass.
  kept.sort((a, b) => b.prob - a.prob);
  return kept.slice(0, cap).sort((a, b) => a.mass - b.mass);
}

function convolve(a: Dist, b: Dist, mergeTol: number, pruneRel: number, cap: number): Dist {
  const combos: Dist = [];
  for (const x of a) for (const y of b) combos.push({ mass: x.mass + y.mass, prob: x.prob * y.prob });
  return mergeAndPrune(combos, mergeTol, pruneRel, cap);
}

/** Distribution of k identical atoms via exponentiation-by-squaring with pruning. */
function powerDist(single: Dist, k: number, mergeTol: number, pruneRel: number, cap: number): Dist {
  let result: Dist = [{ mass: 0, prob: 1 }];
  let base = single;
  let n = k;
  while (n > 0) {
    if (n & 1) result = convolve(result, base, mergeTol, pruneRel, cap);
    n >>= 1;
    if (n > 0) base = convolve(base, base, mergeTol, pruneRel, cap);
  }
  return result;
}

/**
 * Simulate the isotope envelope of a neutral formula. The pattern is the
 * convolution of every element's natural isotope distribution; correct Cl, Br,
 * Ag and S envelopes emerge from the element abundances with no special-casing.
 */
export function isotopePattern(counts: FormulaCounts, options: IsotopeOptions = {}): IsotopePeak[] {
  const mergeTol = options.mergeTol ?? 0.02;
  const minAbundance = options.minAbundance ?? 1e-3;
  const maxPeaks = options.maxPeaks ?? 24;
  const pruneRel = 1e-7;
  const internalCap = 4000;

  let dist: Dist = [{ mass: 0, prob: 1 }];
  for (const [sym, n] of Object.entries(counts)) {
    if (n <= 0) continue;
    const el = ELEMENTS[sym];
    if (!el) throw new Error(`Unsupported element: ${sym}`);
    const single: Dist = el.isotopes.map((iso) => ({ mass: iso.mass, prob: iso.abundance }));
    const elementDist = powerDist(single, n, mergeTol, pruneRel, internalCap);
    dist = convolve(dist, elementDist, mergeTol, pruneRel, internalCap);
  }

  let peaks: IsotopePeak[] = dist.map((d) => ({ mass: d.mass, abundance: d.prob }));

  if (options.unitResolution) {
    const byNominal = new Map<number, { mass: number; prob: number }>();
    for (const p of peaks) {
      const nom = Math.round(p.mass);
      const e = byNominal.get(nom);
      if (e) {
        e.mass += p.mass * p.abundance;
        e.prob += p.abundance;
      } else {
        byNominal.set(nom, { mass: p.mass * p.abundance, prob: p.abundance });
      }
    }
    peaks = [...byNominal.values()].map((e) => ({ mass: e.mass / e.prob, abundance: e.prob }));
  }

  // Normalize to base peak = 1, drop tiny peaks, cap, return by ascending mass.
  let max = 0;
  for (const p of peaks) if (p.abundance > max) max = p.abundance;
  if (max <= 0) return [];
  peaks = peaks
    .map((p) => ({ mass: p.mass, abundance: p.abundance / max }))
    .filter((p) => p.abundance >= minAbundance)
    .sort((a, b) => b.abundance - a.abundance)
    .slice(0, maxPeaks)
    .sort((a, b) => a.mass - b.mass);
  return peaks;
}

// ---------------------------------------------------------------------------
// Formula-candidate generator
// ---------------------------------------------------------------------------

export interface FormulaCandidateOptions {
  /** Elements allowed in the search. Default C, H, N, O. */
  elements?: string[];
  /** Mass match tolerance in Da. Default 0.5. */
  toleranceDa?: number;
  /** Per-element maximum count (overrides the auto mass-derived bound). */
  maxCounts?: Record<string, number>;
  /** Require at least this many of an element (e.g. {C:1}). */
  minCounts?: Record<string, number>;
  /** Lowest acceptable RDBE. Default -0.5 (allows simple acyclic species). */
  rdbeMin?: number;
  /** Highest acceptable RDBE. Default 40. */
  rdbeMax?: number;
  /** Maximum candidates returned (best mass error first). Default 50. */
  maxResults?: number;
}

export interface FormulaCandidate {
  formula: string;
  counts: FormulaCounts;
  exactMass: number;
  /** Signed mass error (candidate − target) in Da and ppm. */
  errorDa: number;
  errorPpm: number;
  rdbe: number;
}

/**
 * Enumerate neutral formulas whose exact mass is within tolerance of
 * `targetNeutralMass`. A remaining-mass-pruned DFS over the allowed elements
 * (heaviest first) keeps the search bounded; an RDBE window discards chemically
 * implausible compositions. Results are sorted by absolute mass error.
 */
export function generateFormulaCandidates(
  targetNeutralMass: number,
  options: FormulaCandidateOptions = {},
): FormulaCandidate[] {
  const allowed = (options.elements ?? ["C", "H", "N", "O"]).filter((s) => ELEMENTS[s]);
  const tol = options.toleranceDa ?? 0.5;
  const rdbeMin = options.rdbeMin ?? -0.5;
  const rdbeMax = options.rdbeMax ?? 40;
  const maxResults = options.maxResults ?? 50;
  if (!(targetNeutralMass > 0) || allowed.length === 0) return [];

  // Search heaviest element first so the remaining-mass bound prunes hard.
  const elems = [...allowed].sort(
    (a, b) => ELEMENTS[b].monoisotopicMass - ELEMENTS[a].monoisotopicMass,
  );
  const masses = elems.map((s) => ELEMENTS[s].monoisotopicMass);
  const maxBound = elems.map((s, idx) => {
    const auto = Math.floor((targetNeutralMass + tol) / masses[idx]);
    const cap = options.maxCounts?.[s];
    return cap != null ? Math.min(cap, auto) : auto;
  });
  const minBound = elems.map((s) => options.minCounts?.[s] ?? 0);

  const counts = new Array(elems.length).fill(0);
  const results: FormulaCandidate[] = [];
  let iterations = 0;
  const ITER_CAP = 5_000_000; // safety valve; runs in the worker, cancelable

  const recurse = (idx: number, massSoFar: number): void => {
    if (iterations > ITER_CAP || results.length >= maxResults * 8) return;
    if (idx === elems.length) {
      const err = massSoFar - targetNeutralMass;
      if (Math.abs(err) <= tol) {
        const c: FormulaCounts = {};
        for (let k = 0; k < elems.length; k += 1) if (counts[k] > 0) c[elems[k]] = counts[k];
        if (Object.keys(c).length === 0) return; // reject the empty composition
        const r = rdbe(c);
        if (r >= rdbeMin && r <= rdbeMax) {
          results.push({
            formula: formatFormula(c),
            counts: { ...c },
            exactMass: massSoFar,
            errorDa: err,
            errorPpm: (err / targetNeutralMass) * 1e6,
            rdbe: r,
          });
        }
      }
      return;
    }
    const m = masses[idx];
    const remainingMin = minRemainingMass(masses, minBound, idx + 1);
    for (let n = minBound[idx]; n <= maxBound[idx]; n += 1) {
      iterations += 1;
      const newMass = massSoFar + n * m;
      // Prune: even with the lightest remaining choices we'd overshoot.
      if (newMass - tol > targetNeutralMass && idx === elems.length - 1) break;
      if (newMass + remainingMin - tol > targetNeutralMass + tol && remainingMin > 0) {
        // Adding more of this element only increases mass — safe to stop.
        if (n > minBound[idx]) break;
      }
      counts[idx] = n;
      recurse(idx + 1, newMass);
    }
    counts[idx] = 0;
  };

  recurse(0, 0);

  results.sort((a, b) => Math.abs(a.errorDa) - Math.abs(b.errorDa));
  return results.slice(0, maxResults);
}

/** Minimum additional mass contributed by the forced minimums from index `from`. */
function minRemainingMass(masses: number[], minBound: number[], from: number): number {
  let m = 0;
  for (let i = from; i < masses.length; i += 1) m += masses[i] * minBound[i];
  return m;
}

/** Re-export for callers that build custom element pickers. */
export { ELEMENT_SYMBOLS };
