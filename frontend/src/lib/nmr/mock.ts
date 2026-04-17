import type {
  Engine,
  OptionsResponse,
  PredictRequest,
  PredictResponse,
  ValidateResponse,
} from "@/types/nmr";

export const mockOptions: OptionsResponse = {
  nuclei: ["1H", "13C", "15N", "19F", "31P"],
  modes: ["individual", "consensus"],
  conformer_strategies: ["fast", "accurate", "single"],
  engine_names: ["cdk", "nmrshiftdb", "cascade", "orca", "mestrenova"],
};

export const mockEngines: Engine[] = [
  { name: "cdk", label: "CDK (HOSE)", ready: true, implemented: true, default_weight: 0.4, supported_nuclei: ["1H", "13C"] },
  { name: "nmrshiftdb", label: "NMRShiftDB", ready: true, implemented: true, default_weight: 0.3, supported_nuclei: ["1H", "13C", "15N"] },
  { name: "cascade", label: "CASCADE (ML)", ready: true, implemented: true, default_weight: 0.3, supported_nuclei: ["1H", "13C"] },
  { name: "orca", label: "ORCA (DFT)", ready: false, implemented: true, reason: "ORCA binary not found on PATH", default_weight: 0.0, supported_nuclei: ["1H", "13C", "15N", "19F", "31P"] },
  { name: "mestrenova", label: "MestReNova", ready: false, implemented: false, reason: "Engine not yet implemented", default_weight: 0.0, supported_nuclei: ["1H", "13C"] },
];

export function mockValidate(smiles: string): ValidateResponse {
  const trimmed = smiles.trim();
  if (!trimmed) return { valid: false, error: "SMILES is empty" };
  // Naive check — balanced parens/brackets and only allowed chars.
  const allowed = /^[A-Za-z0-9@+\-\[\]\(\)=#$\/\\.%:*]+$/;
  if (!allowed.test(trimmed)) return { valid: false, error: "Invalid characters in SMILES" };
  let depth = 0;
  for (const c of trimmed) {
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (depth < 0) return { valid: false, error: "Unbalanced parentheses" };
  }
  if (depth !== 0) return { valid: false, error: "Unbalanced parentheses" };
  return { valid: true, canonical_smiles: trimmed };
}

/** Deterministic pseudo-random using a string seed — keeps mock spectra stable. */
function seededRandom(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Estimate atom count for the mock spectrum from a SMILES string. */
function estimateAtoms(smiles: string, nucleus: string): number {
  const upper = smiles.replace(/\[[^\]]*\]/g, "X");
  if (nucleus === "1H") {
    // Rough: count C/N/O and assume ~1.5 hydrogens per heavy atom.
    const heavy = (upper.match(/[CNOFPS]/gi) ?? []).length;
    return Math.max(2, Math.min(40, Math.round(heavy * 1.5)));
  }
  if (nucleus === "13C") return Math.max(1, Math.min(40, (upper.match(/[Cc]/g) ?? []).length));
  if (nucleus === "15N") return Math.max(1, (upper.match(/[Nn]/g) ?? []).length || 1);
  if (nucleus === "19F") return Math.max(1, (upper.match(/F/g) ?? []).length || 1);
  if (nucleus === "31P") return Math.max(1, (upper.match(/P/g) ?? []).length || 1);
  return 5;
}

const NUCLEUS_RANGE: Record<string, [number, number]> = {
  "1H": [0.5, 10],
  "13C": [10, 200],
  "15N": [0, 400],
  "19F": [-250, 50],
  "31P": [-50, 250],
};

export function mockPredict(req: PredictRequest): PredictResponse {
  const rand = seededRandom(`${req.smiles}|${req.nucleus}|${req.mode}`);
  const n = estimateAtoms(req.smiles, req.nucleus);
  const [lo, hi] = NUCLEUS_RANGE[req.nucleus] ?? [0, 200];
  const span = hi - lo;
  const element = req.nucleus.replace(/^\d+/, "");

  const baseShifts = Array.from({ length: n }, (_, i) => ({
    atom_index: i,
    element,
    base: lo + rand() * span,
  }));

  const shifts =
    req.mode === "individual"
      ? req.engines.flatMap((engine) =>
          baseShifts.map((b) => ({
            atom_index: b.atom_index,
            element: b.element,
            shift: b.base + (rand() - 0.5) * span * 0.04,
            intensity: 0.6 + rand() * 0.4,
            engine,
          })),
        )
      : baseShifts.map((b) => ({
          atom_index: b.atom_index,
          element: b.element,
          shift: b.base + (rand() - 0.5) * span * 0.01,
          intensity: 0.7 + rand() * 0.3,
          std: rand() * span * 0.02,
        }));

  return {
    smiles: req.smiles,
    nucleus: req.nucleus,
    mode: req.mode,
    shifts,
    engines_used: req.engines,
    warnings: [],
  };
}
