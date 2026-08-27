// Pure, React-free core of the TGA store: the raw state shape, the reducer,
// and the helpers that turn a parsed file into store records. Kept separate
// from `store.tsx` so the reducer is unit-testable without the DOM and so the
// Provider file only exports components/hooks (fast-refresh friendly).
// Mirrors `lib/tensile/store-core.ts`.

import { DEFAULT_PARAMS, type AnalysisParams, type TgaLoadedFile, type TgaMaterial, type TgaRun, type TgaState } from "./types";
import type { ParsedRun, ParsedTgaFile } from "./types";

/** Distinct line colours, cycled across runs. */
const PALETTE = [
  "#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed",
  "#0891b2", "#db2777", "#65a30d", "#ea580c", "#0d9488",
  "#9333ea", "#ca8a04", "#0284c7", "#e11d48", "#4f46e5",
];

/** Pick a colour for run `index` — the same palette the figure engine uses. */
export function runColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

/** A monotonic id counter ensures stable colours across add/remove cycles. */
let colorCounter = 0;
/** Reset the colour counter (test-only — keeps tests deterministic). */
export function resetColorCounter(): void {
  colorCounter = 0;
}

/** Mint a stable unique id with a prefix. Uses `crypto.randomUUID` when
 *  available, else a Date+random fallback. */
export function newId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Derive a material name from a file name: strip the extension and a trailing
 *  date stamp, so `tit2-1_DCPD_PETMP_4-29-26.xls` becomes `tit2-1_DCPD_PETMP`. */
export function materialNameFromFile(fileName: string): string {
  const noExt = fileName.replace(/\.[^.]+$/, "");
  const noDate = noExt.replace(/[_-]\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/, "");
  return noDate || noExt || fileName;
}

export const INITIAL_STATE: TgaState = {
  files: [],
  runs: [],
  materials: [],
  params: DEFAULT_PARAMS,
  blankRunId: null,
};

/** Turn a parsed file into store records: a file, its runs (with ids/colours),
 *  and a default material holding all the file's runs. */
export function buildFromParsed(
  parsed: ParsedTgaFile,
): { file: TgaLoadedFile; runs: TgaRun[]; material: TgaMaterial | null } {
  const fileId = newId("file");
  const runs: TgaRun[] = parsed.runs.map((run: ParsedRun) => {
    const id = newId("run");
    const color = runColor(colorCounter++);
    return {
      id,
      fileId,
      fileName: parsed.fileName,
      label: run.label,
      color,
      meta: run.meta,
      segments: run.segments,
      timeMin: run.timeMin,
      tempC: run.tempC,
      weightMg: run.weightMg,
      ...(run.weightPctFile ? { weightPctFile: run.weightPctFile } : {}),
      ...(run.dtgFile ? { dtgFile: run.dtgFile } : {}),
      scale: 1,
      offset: 0,
      visible: true,
      materialId: null,
    };
  });
  const file: TgaLoadedFile = {
    id: fileId,
    fileName: parsed.fileName,
    runCount: runs.length,
    warnings: parsed.warnings,
  };
  // Default grouping: one material per file (auto-named), holding all its runs.
  const material: TgaMaterial | null =
    runs.length > 0
      ? {
          id: newId("mat"),
          name: materialNameFromFile(parsed.fileName),
          runIds: runs.map((r) => r.id),
        }
      : null;
  if (material) {
    for (const r of runs) r.materialId = material.id;
  }
  return { file, runs, material };
}

/** Remove a run id from every material and drop materials left empty. */
function pruneMaterials(materials: TgaMaterial[], removedIds: Set<string>): TgaMaterial[] {
  return materials
    .map((m) => ({ ...m, runIds: m.runIds.filter((id) => !removedIds.has(id)) }))
    .filter((m) => m.runIds.length > 0);
}

export type Action =
  | { type: "LOAD_STATE"; state: TgaState }
  | { type: "ADD_FILE"; file: TgaLoadedFile; runs: TgaRun[]; material: TgaMaterial | null }
  | { type: "REMOVE_FILE"; fileId: string }
  | { type: "REMOVE_RUN"; runId: string }
  | { type: "CLEAR_ALL" }
  | { type: "SET_PARAMS"; params: Partial<AnalysisParams> }
  | { type: "SET_RUN_COLOR"; runId: string; color: string }
  | { type: "SET_RUN_SCALE"; runId: string; scale: number }
  | { type: "SET_RUN_OFFSET"; runId: string; offset: number }
  | { type: "TOGGLE_RUN_VISIBLE"; runId: string }
  | { type: "RENAME_RUN"; runId: string; label: string }
  | { type: "SET_BLANK_RUN"; runId: string | null }
  | { type: "RENAME_MATERIAL"; id: string; name: string }
  | { type: "MOVE_RUN"; runId: string; toMaterialId: string }
  | { type: "MERGE_MATERIALS"; sourceId: string; targetId: string }
  | { type: "CREATE_MATERIAL_FROM"; runIds: string[]; name: string }
  | { type: "DELETE_MATERIAL"; id: string };

export function reducer(state: TgaState, action: Action): TgaState {
  switch (action.type) {
    case "LOAD_STATE":
      return {
        ...INITIAL_STATE,
        ...action.state,
        params: { ...DEFAULT_PARAMS, ...action.state.params },
      };
    case "ADD_FILE": {
      const materials = action.material
        ? [...state.materials, action.material]
        : state.materials;
      return {
        ...state,
        files: [...state.files, action.file],
        runs: [...state.runs, ...action.runs],
        materials,
      };
    }
    case "REMOVE_FILE": {
      const removedRunIds = new Set(
        state.runs.filter((r) => r.fileId === action.fileId).map((r) => r.id),
      );
      const materials = pruneMaterials(state.materials, removedRunIds);
      return {
        ...state,
        files: state.files.filter((f) => f.id !== action.fileId),
        runs: state.runs.filter((r) => r.fileId !== action.fileId),
        materials,
        blankRunId: removedRunIds.has(state.blankRunId ?? "") ? null : state.blankRunId,
      };
    }
    case "REMOVE_RUN": {
      const removed = new Set([action.runId]);
      const materials = pruneMaterials(state.materials, removed);
      return {
        ...state,
        runs: state.runs.filter((r) => r.id !== action.runId),
        materials,
        blankRunId: state.blankRunId === action.runId ? null : state.blankRunId,
      };
    }
    case "CLEAR_ALL":
      return { ...INITIAL_STATE, params: state.params };
    case "SET_PARAMS":
      return { ...state, params: { ...state.params, ...action.params } };
    case "SET_RUN_COLOR":
      return {
        ...state,
        runs: state.runs.map((r) => (r.id === action.runId ? { ...r, color: action.color } : r)),
      };
    case "SET_RUN_SCALE":
      return {
        ...state,
        runs: state.runs.map((r) =>
          r.id === action.runId ? { ...r, scale: Number.isFinite(action.scale) ? action.scale : 1 } : r,
        ),
      };
    case "SET_RUN_OFFSET":
      return {
        ...state,
        runs: state.runs.map((r) =>
          r.id === action.runId ? { ...r, offset: Number.isFinite(action.offset) ? action.offset : 0 } : r,
        ),
      };
    case "TOGGLE_RUN_VISIBLE":
      return {
        ...state,
        runs: state.runs.map((r) =>
          r.id === action.runId ? { ...r, visible: !r.visible } : r,
        ),
      };
    case "RENAME_RUN":
      return {
        ...state,
        runs: state.runs.map((r) =>
          r.id === action.runId ? { ...r, label: action.label } : r,
        ),
      };
    case "SET_BLANK_RUN":
      return { ...state, blankRunId: action.runId };
    case "RENAME_MATERIAL":
      return {
        ...state,
        materials: state.materials.map((m) =>
          m.id === action.id ? { ...m, name: action.name } : m,
        ),
      };
    case "MOVE_RUN": {
      if (!state.materials.some((m) => m.id === action.toMaterialId)) return state;
      const materials = state.materials.map((m) => ({
        ...m,
        runIds: m.runIds.filter((id) => id !== action.runId),
      }));
      const target = materials.find((m) => m.id === action.toMaterialId);
      if (target) target.runIds.push(action.runId);
      return {
        ...state,
        runs: state.runs.map((r) =>
          r.id === action.runId ? { ...r, materialId: action.toMaterialId } : r,
        ),
        materials: materials.filter((m) => m.runIds.length > 0 || m.id === action.toMaterialId),
      };
    }
    case "MERGE_MATERIALS": {
      if (action.sourceId === action.targetId) return state;
      const source = state.materials.find((m) => m.id === action.sourceId);
      if (!source) return state;
      const materials = state.materials
        .filter((m) => m.id !== action.sourceId)
        .map((m) =>
          m.id === action.targetId
            ? { ...m, runIds: [...new Set([...m.runIds, ...source.runIds])] }
            : m,
        );
      return {
        ...state,
        runs: state.runs.map((r) =>
          r.materialId === action.sourceId ? { ...r, materialId: action.targetId } : r,
        ),
        materials,
      };
    }
    case "CREATE_MATERIAL_FROM": {
      const valid = action.runIds.filter((id) => state.runs.some((r) => r.id === id));
      if (valid.length === 0) return state;
      const id = newId("mat");
      const materials = state.materials.map((m) => ({
        ...m,
        runIds: m.runIds.filter((rid) => !valid.includes(rid)),
      }));
      materials.push({ id, name: action.name, runIds: valid });
      return {
        ...state,
        runs: state.runs.map((r) =>
          valid.includes(r.id) ? { ...r, materialId: id } : r,
        ),
        materials: materials.filter((m) => m.runIds.length > 0 || m.id === id),
      };
    }
    case "DELETE_MATERIAL": {
      const materials = state.materials.filter((m) => m.id !== action.id);
      return {
        ...state,
        runs: state.runs.map((r) =>
          r.materialId === action.id ? { ...r, materialId: null } : r,
        ),
        materials,
      };
    }
    default:
      return state;
  }
}