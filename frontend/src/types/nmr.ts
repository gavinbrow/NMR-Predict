// Shared NMR Predict types — mirror the FastAPI backend contract.
export type Nucleus = "1H" | "13C" | "15N" | "19F" | "31P" | string;
export type Mode = "individual" | "consensus" | string;
export type ConformerStrategy = "fast" | "goat" | "accurate" | "single" | string;

export interface Engine {
  name: string;
  label?: string;
  ready: boolean;
  implemented?: boolean;
  reason?: string;
  default_weight?: number;
  supported_nuclei?: Nucleus[];
}

export interface OptionsResponse {
  nuclei: Nucleus[];
  modes: Mode[];
  conformer_strategies: ConformerStrategy[];
  engine_names: string[];
}

export interface ValidateResponse {
  valid: boolean;
  error?: string | null;
  canonical_smiles?: string | null;
}

export interface Shift {
  atom_index: number;
  element?: string;
  shift: number; // ppm
  intensity?: number;
  engine?: string; // present in individual mode
  std?: number; // present in consensus mode
  source_id?: string;
  source_label?: string;
  source_smiles?: string;
  attached_atom_index?: number;
  assignment_group?: string;
  multiplicity?: string;
  coupling_hz?: number;
  neighbor_count?: number;
}

export interface PredictResponse {
  smiles: string;
  nucleus: Nucleus;
  mode: Mode;
  shifts: Shift[];
  engines_used: string[];
  warnings?: string[];
}

export interface PredictRequest {
  smiles: string;
  engines: string[];
  mode: Mode;
  nucleus: Nucleus;
  conformer_strategy: ConformerStrategy;
  weights?: Record<string, number>;
}
