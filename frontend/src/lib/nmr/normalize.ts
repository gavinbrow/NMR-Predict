import type { Engine, OptionsResponse, PredictRequest, PredictResponse, Shift } from "@/types/nmr";

type BackendEngineInfo = {
  name: string;
  default_weight?: number;
  implemented?: boolean;
  ready: boolean;
  message?: string | null;
  reason?: string | null;
};

type BackendOptionsResponse = {
  nuclei: OptionsResponse["nuclei"];
  modes: OptionsResponse["modes"];
  conformer_strategies: OptionsResponse["conformer_strategies"];
  engines: string[];
};

type BackendAtomShift = {
  atom_index: number;
  symbol: string;
  shift_ppm: number;
  confidence?: number | null;
  attached_atom_index?: number | null;
  assignment_group?: string | null;
  multiplicity?: string | null;
  coupling_hz?: number | null;
  neighbor_count?: number | null;
};

type BackendConsensusAtomShift = BackendAtomShift & {
  contributing_engines: string[];
  std_ppm?: number | null;
};

type BackendEngineResult = {
  engine: string;
  status: "ok" | "pending" | "error";
  shifts: BackendAtomShift[];
  message?: string | null;
};

type BackendPredictResponse = {
  canonical_smiles: string;
  atom_symbols: string[];
  engines: Record<string, BackendEngineResult>;
  consensus?: {
    shifts: BackendConsensusAtomShift[];
    weights_used: Record<string, number>;
  } | null;
};

function isBackendOptionsResponse(value: OptionsResponse | BackendOptionsResponse): value is BackendOptionsResponse {
  return Array.isArray((value as BackendOptionsResponse).engines);
}

function isBackendPredictResponse(value: PredictResponse | BackendPredictResponse): value is BackendPredictResponse {
  return !Array.isArray((value as PredictResponse).shifts) && typeof value === "object" && value !== null;
}

function warningForEngine(name: string, result: BackendEngineResult) {
  if (result.status === "ok") return null;
  return `${name}: ${result.message ?? `status ${result.status}`}`;
}

function toUiShift(
  shift: BackendAtomShift | BackendConsensusAtomShift,
  extras?: Partial<Pick<Shift, "engine" | "std">>,
): Shift {
  return {
    atom_index: shift.atom_index,
    element: shift.symbol,
    shift: shift.shift_ppm,
    intensity: shift.confidence ?? 1,
    engine: extras?.engine,
    std: extras?.std,
    attached_atom_index: shift.attached_atom_index ?? undefined,
    assignment_group: shift.assignment_group ?? undefined,
    multiplicity: shift.multiplicity ?? undefined,
    coupling_hz: shift.coupling_hz ?? undefined,
    neighbor_count: shift.neighbor_count ?? undefined,
  };
}

export function normalizeOptionsResponse(
  response: OptionsResponse | BackendOptionsResponse,
): OptionsResponse {
  if (!isBackendOptionsResponse(response)) return response;

  return {
    nuclei: response.nuclei,
    modes: response.modes,
    conformer_strategies: response.conformer_strategies,
    engine_names: response.engines,
  };
}

export function normalizeEnginesResponse(
  response: Array<Engine | BackendEngineInfo>,
): Engine[] {
  return response.map((engine) => ({
    ...engine,
    reason: engine.reason ?? engine.message ?? undefined,
  }));
}

export function normalizePredictResponse(
  response: PredictResponse | BackendPredictResponse,
  request: PredictRequest,
): PredictResponse {
  if (!isBackendPredictResponse(response)) return response;

  const engineEntries = Object.entries(response.engines ?? {});
  const warnings = engineEntries
    .map(([name, result]) => warningForEngine(name, result))
    .filter((warning): warning is string => Boolean(warning));

  const shifts =
    request.mode === "consensus"
      ? (response.consensus?.shifts ?? []).map((shift) =>
          toUiShift(shift, { std: shift.std_ppm ?? undefined }),
        )
      : engineEntries.flatMap(([name, result]) =>
          (result.shifts ?? []).map((shift) => toUiShift(shift, { engine: name })),
        );

  const enginesUsed =
    request.mode === "consensus"
      ? Object.keys(response.consensus?.weights_used ?? {})
      : request.engines;

  return {
    smiles: response.canonical_smiles,
    nucleus: request.nucleus,
    mode: request.mode,
    shifts,
    engines_used: enginesUsed.length > 0 ? enginesUsed : request.engines,
    warnings,
  };
}
