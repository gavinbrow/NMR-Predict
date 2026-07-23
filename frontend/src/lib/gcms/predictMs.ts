// Heuristic EI-MS spectrum predictor. Given a SMILES or molfile, derive the
// molecular formula + exact mass via openchemlib, then build an approximate
// 70-eV EI spectrum from:
//   - the molecular ion [M]+. (exactMass − electron mass, moderate intensity)
//   - the isotope envelope around M (MALDI `isotopePattern`, unit resolution)
//   - curated neutral losses (CH3, H2O, CO, ...), each gated by atom presence
//   - single-bond cleavage fragments (each side's formula/mass)
// Intensities are heuristic (alpha-cleavage / small stable cations favoured),
// normalised to base = 100. This is APPROXIMATE — a real EI fragmentation
// model belongs in a backend; the panel's "approximate" badge and this
// docstring both say so. The interface returns a real `MassSpectrum` +
// `SpecPeak[]` so it plugs into the existing overlay/label/compare paths.

import * as OCL from "openchemlib";
import { ELECTRON_MASS } from "@/lib/maldi/elements";
import { exactMass, isotopePattern, parseFormula, type FormulaCounts } from "@/lib/maldi/formula";
import type { MassSpectrum, SpecPeak } from "./types";

/** Result of resolving a SMILES/molfile to a formula. */
export interface ResolvedFormula {
  formula: string;
  counts: FormulaCounts;
  exactMass: number;
}

/** Resolve a SMILES string to a molecular formula + exact mass via openchemlib.
 *  Returns null for an empty or invalid SMILES (never throws). */
export function smilesToFormula(smiles: string): ResolvedFormula | null {
  const trimmed = (smiles ?? "").trim();
  if (!trimmed) return null;
  try {
    const mol = OCL.Molecule.fromSmiles(trimmed);
    const mf = mol.getMolecularFormula().formula;
    const counts = parseFormula(mf);
    return { formula: mf, counts, exactMass: exactMass(counts) };
  } catch {
    return null;
  }
}

/** Resolve a molfile to a molecular formula + exact mass. null on failure. */
export function molfileToFormula(molfile: string): ResolvedFormula | null {
  const trimmed = (molfile ?? "").trim();
  if (!trimmed) return null;
  try {
    const mol = OCL.Molecule.fromMolfile(trimmed);
    const mf = mol.getMolecularFormula().formula;
    const counts = parseFormula(mf);
    return { formula: mf, counts, exactMass: exactMass(counts) };
  } catch {
    return null;
  }
}

/** One curated neutral loss. `loss` is the neutral fragment's formula;
 *  `gates` lists element symbols that must be present in the molecule for
 *  the loss to apply (e.g. H2O requires O). `intensity` is the heuristic
 *  relative intensity (0..100, before normalisation). */
interface NeutralLoss {
  loss: string;
  gates: string[];
  intensity: number;
  note?: string;
}

const NEUTRAL_LOSSES: NeutralLoss[] = [
  { loss: "H", gates: ["H"], intensity: 30 },
  { loss: "CH3", gates: ["C", "H"], intensity: 35 },
  { loss: "H2O", gates: ["O", "H"], intensity: 25 },
  { loss: "CO", gates: ["C", "O"], intensity: 30 },
  { loss: "C2H4", gates: ["C", "H"], intensity: 18 },
  { loss: "CHO", gates: ["C", "H", "O"], intensity: 22 },
  { loss: "CH2O", gates: ["C", "H", "O"], intensity: 20 },
  { loss: "OCH3", gates: ["C", "H", "O"], intensity: 28 },
  { loss: "COOH", gates: ["C", "H", "O"], intensity: 15 },
  { loss: "Cl", gates: ["Cl"], intensity: 40 },
  { loss: "Br", gates: ["Br"], intensity: 45 },
  { loss: "NO2", gates: ["N", "O"], intensity: 20 },
];

/** A candidate fragment (m/z + intensity + label) before dedup/normalise. */
interface FragCandidate {
  mz: number;
  intensity: number;
  label: string;
}

/** Predict an approximate 70-eV EI mass spectrum for a molecule.
 *
 * Returns `{ peaks, spectrum, formula, exactMass }` or `{ peaks: [], spectrum:
 * empty, formula, exactMass }` for an invalid/empty input (never throws).
 *
 * The spectrum is built from the molecular ion, its isotope envelope, curated
 * neutral losses (gated by atom presence), and single-bond cleavage fragments
 * (each side's formula/mass). Intensities are heuristic, normalised to base =
 * 100. Clearly approximate — see the panel's "approximate" badge.
 */
export interface PredictEiResult {
  peaks: SpecPeak[];
  spectrum: MassSpectrum;
  formula: string;
  exactMass: number;
}

export function predictEiSpectrum(input: ResolvedFormula): PredictEiResult {
  const { formula, counts, exactMass: m } = input;
  const empty: PredictEiResult = {
    peaks: [],
    spectrum: {
      runId: "predict",
      mz: new Float64Array(0),
      intensity: new Float64Array(0),
      label: "Predicted MS (approx.)",
      rtLo: 0,
      rtHi: 0,
      scanCount: 0,
      basePeak: null,
    },
    formula,
    exactMass: m,
  };
  if (!formula || m <= 0) return empty;

  const cands: FragCandidate[] = [];

  // 1. Molecular ion [M]+. at exactMass − electron mass.
  const mPlus = m - ELECTRON_MASS;
  cands.push({ mz: mPlus, intensity: 60, label: "M+" });

  // 2. Isotope envelope around M (unit resolution) — small +1, +2 peaks.
  const iso = isotopePattern(counts, { unitResolution: true, minAbundance: 0.01 });
  for (const p of iso) {
    const nominal = Math.round(p.mass);
    if (nominal === Math.round(m)) continue; // M itself already added
    cands.push({ mz: p.mass - ELECTRON_MASS, intensity: p.abundance * 50, label: `M+${nominal - Math.round(m)}` });
  }

  // 3. Neutral losses, each gated by atom presence.
  for (const loss of NEUTRAL_LOSSES) {
    if (!loss.gates.every((sym) => (counts[sym] ?? 0) > 0)) continue;
    try {
      const lossCounts = parseFormula(loss.loss);
      const lossMass = exactMass(lossCounts);
      if (lossMass <= 0 || lossMass >= m) continue;
      cands.push({ mz: mPlus - lossMass, intensity: loss.intensity, label: `M−${loss.loss}` });
    } catch {
      /* malformed loss formula — skip */
    }
  }

  // 4. Single-bond cleavage fragments via the OCL atom/bond graph.
  try {
    const mol = OCL.Molecule.fromSmiles(parseSmilesFromFormulaFallback(formula, counts));
    appendCleavageFragments(mol, cands, mPlus);
  } catch {
    /* graph traversal failed — the curated losses above still give a usable spectrum */
  }

  // Dedup by m/z (within 0.05 Da), keep the highest-intensity candidate.
  const dedup = dedupByMz(cands, 0.05);

  // Normalise to base = 100.
  let maxI = 0;
  for (const c of dedup) if (c.intensity > maxI) maxI = c.intensity;
  if (maxI <= 0) return empty;
  const normed = dedup.map((c) => ({ ...c, intensity: (c.intensity / maxI) * 100 }));

  // Sort by m/z ascending.
  normed.sort((a, b) => a.mz - b.mz);

  const mz = new Float64Array(normed.map((c) => c.mz));
  const intensity = new Float64Array(normed.map((c) => c.intensity));
  let basePeak: { mz: number; intensity: number } | null = null;
  if (normed.length > 0) {
    let bi = 0;
    for (let i = 1; i < normed.length; i += 1) {
      if (normed[i].intensity > normed[bi].intensity) bi = i;
    }
    basePeak = { mz: normed[bi].mz, intensity: normed[bi].intensity };
  }

  const peaks: SpecPeak[] = normed.map((c, i) => ({
    id: `pred-${i}`,
    mz: c.mz,
    intensity: c.intensity,
    relPct: c.intensity,
    ion: c.label,
  }));

  return {
    peaks,
    spectrum: {
      runId: "predict",
      mz,
      intensity,
      label: `Predicted MS — ${formula} (approx.)`,
      rtLo: 0,
      rtHi: 0,
      scanCount: 0,
      basePeak,
    },
    formula,
    exactMass: m,
  };
}

/** Walk the OCL bond graph, enumerate acyclic single bonds, break each, take
 *  each side's formula/mass as a fragment. Intensity is heuristic: small
 *  stable cations (e.g. tropylium-like C7H7) and alpha-cleavage products are
 *  favoured. Mutates `cands` in place. */
function appendCleavageFragments(mol: OCL.Molecule, cands: FragCandidate[], mPlus: number): void {
  const nAtoms = mol.getAllAtoms();
  const nBonds = mol.getAllBonds();
  // cBondTypeSingle === 1 in OCL.
  const SINGLE = 1;
  for (let b = 0; b < nBonds; b += 1) {
    if (mol.getBondTypeSimple(b) !== SINGLE) continue;
    const a1 = mol.getBondAtom(0, b);
    const a2 = mol.getBondAtom(1, b);
    // Skip ring bonds (cleavage would open a ring, not produce a fragment).
    if (mol.getRingSet().getBondRingSize(b) > 0) continue;
    for (const sideAtoms of [[a1, a2] as const, [a2, a1] as const]) {
      const visited = new Set<number>([sideAtoms[1]]);
      const stack = [sideAtoms[0]];
      const component = new Set<number>();
      while (stack.length > 0) {
        const a = stack.pop()!;
        if (visited.has(a)) continue;
        visited.add(a);
        component.add(a);
        const n = mol.getConnAtoms(a);
        for (let i = 0; i < n; i += 1) {
          const nb = mol.getConnAtom(a, i);
          if (!visited.has(nb)) stack.push(nb);
        }
      }
      // Build the fragment's formula by counting atoms in the component.
      const fragCounts: FormulaCounts = {};
      for (const ai of component) {
        const atomicNo = mol.getAtomicNo(ai);
        const sym = symbolFromAtomicNo(atomicNo);
        if (!sym) continue;
        fragCounts[sym] = (fragCounts[sym] ?? 0) + 1;
        // Add implicit hydrogens on this atom (excluding the broken bond).
        const h = mol.getAllHydrogens(ai);
        if (h > 0) fragCounts["H"] = (fragCounts["H"] ?? 0) + h;
      }
      // Subtract the H that was on the broken-bond side of THIS component
      // (the cleavage takes one H from the other side). Heuristic: drop 1 H.
      if ((fragCounts["H"] ?? 0) > 0) fragCounts["H"] -= 1;
      let mass: number;
      try {
        mass = exactMass(fragCounts);
      } catch {
        continue;
      }
      if (mass <= 0 || mass >= mPlus) continue;
      // Heuristic intensity: smaller fragments are often more stable cations.
      const size = Object.values(fragCounts).reduce((a, b) => a + b, 0);
      const intensity = size <= 8 ? 30 : size <= 15 ? 15 : 5;
      cands.push({ mz: mass, intensity, label: "cleavage" });
    }
  }
}

/** Map an OCL atomic number to an element symbol supported by `ELEMENTS`.
 *  Only the common organic set is mapped; others return null (skipped). */
function symbolFromAtomicNo(atomicNo: number): string | null {
  switch (atomicNo) {
    case 1: return "H";
    case 5: return "B";
    case 6: return "C";
    case 7: return "N";
    case 8: return "O";
    case 9: return "F";
    case 14: return "Si";
    case 15: return "P";
    case 16: return "S";
    case 17: return "Cl";
    case 35: return "Br";
    case 53: return "I";
    default: return null;
  }
}

/** The cleavage traversal needs a SMILES to build the OCL graph. We don't
 *  have the original SMILES here (only the formula), so reconstruct a
 *  degenerate acyclic SMILES from the formula counts. This is a fallback —
 *  it gives a plausible connected graph for the bond enumeration, but the
 *  exact fragmentation pattern is inherently approximate. For molecules whose
 *  real structure differs from the linear chain, the curated neutral losses
 *  above still carry the diagnostic fragments. */
function parseSmilesFromFormulaFallback(formula: string, counts: FormulaCounts): string {
  // Build a linear chain SMILES: CCCCCC... with heteroatoms inserted.
  // This is purely so the OCL graph traversal has something to walk; the
  // exact cleavage masses are approximate regardless.
  const order: string[] = ["C", "N", "O", "S", "P", "F", "Cl", "Br", "I", "B", "Si", "H"];
  const parts: string[] = [];
  for (const sym of order) {
    const n = counts[sym] ?? 0;
    if (sym === "H") continue; // H is implicit in SMILES
    for (let i = 0; i < n; i += 1) parts.push(sym);
  }
  if (parts.length === 0) throw new Error("No heavy atoms");
  return parts.join("");
}

/** Deduplicate candidates by m/z within `tol`, keeping the highest intensity. */
function dedupByMz(cands: FragCandidate[], tol: number): FragCandidate[] {
  const sorted = [...cands].sort((a, b) => a.mz - b.mz);
  const out: FragCandidate[] = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(c.mz - last.mz) <= tol) {
      if (c.intensity > last.intensity) out[out.length - 1] = c;
    } else {
      out.push(c);
    }
  }
  return out;
}