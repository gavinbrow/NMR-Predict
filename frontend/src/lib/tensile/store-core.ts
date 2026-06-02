// Pure, React-free core of the Tensile store (Phase 3): the raw state shape, the
// reducer, and the helpers that turn a parsed workbook into store records. Kept
// separate from `store.tsx` so the reducer is unit-testable without the DOM and
// so the Provider file only exports components/hooks (fast-refresh friendly).

import { DEFAULT_PARAMS } from "./compute";
import type {
  AnalysisParams,
  LoadedFile,
  Material,
  ParsedWorkbook,
  Selection,
  Specimen,
} from "./types";

/** A specimen as stored — everything except the derived `props`. */
export type RawSpecimen = Omit<Specimen, "props">;

export interface TensileState {
  files: LoadedFile[];
  specimens: RawSpecimen[];
  materials: Material[];
  params: AnalysisParams;
  selection: Selection;
}

export const INITIAL_STATE: TensileState = {
  files: [],
  specimens: [],
  materials: [],
  params: DEFAULT_PARAMS,
  selection: { materialIds: [], specimenIds: [], property: "E_MPa" },
};

// --------------------------------------------------------------------------- //
// Helpers                                                                     //
// --------------------------------------------------------------------------- //

export function newId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Derive a material name from a file name: strip the extension and a trailing
 * date stamp (e.g. `_4-29-26`), so `tit2-1_DCPD_PETMP_4-29-26.xlsx` becomes
 * `tit2-1_DCPD_PETMP`.
 */
export function materialNameFromFile(fileName: string): string {
  const noExt = fileName.replace(/\.[^.]+$/, "");
  const noDate = noExt.replace(/[_-]\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/, "");
  return noDate || noExt || fileName;
}

// A material color palette (kept in sync with chart usage).
const PALETTE = [
  "#2563eb", // blue
  "#dc2626", // red
  "#16a34a", // green
  "#9333ea", // purple
  "#ea580c", // orange
  "#0891b2", // cyan
  "#ca8a04", // amber
  "#db2777", // pink
  "#4b5563", // slate
  "#65a30d", // lime
];

export function materialColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

/** The effective strain-is-percent flag for a specimen under the current override. */
export function effectivePercent(raw: RawSpecimen, params: AnalysisParams): boolean {
  if (params.strainUnitOverride === "%") return true;
  if (params.strainUnitOverride === "mm/mm") return false;
  return raw.raw.strainIsPercent;
}

// --------------------------------------------------------------------------- //
// Actions + reducer                                                           //
// --------------------------------------------------------------------------- //

export type Action =
  | { type: "LOAD_STATE"; state: TensileState }
  | { type: "ADD_FILE"; file: LoadedFile; specimens: RawSpecimen[]; material: Material | null }
  | { type: "REMOVE_FILE"; fileId: string }
  | { type: "CLEAR_ALL" }
  | { type: "SET_PARAMS"; params: Partial<AnalysisParams> }
  | { type: "RENAME_MATERIAL"; id: string; name: string }
  | { type: "SET_EXCLUDED"; specimenId: string; excluded: boolean }
  | { type: "MOVE_SPECIMEN"; specimenId: string; toMaterialId: string }
  | { type: "MERGE_MATERIALS"; sourceId: string; targetId: string }
  | { type: "CREATE_MATERIAL_FROM"; specimenIds: string[]; name: string }
  | { type: "DELETE_MATERIAL"; id: string }
  | { type: "SET_SELECTION"; selection: Partial<Selection> }
  | { type: "TOGGLE_MATERIAL_SELECTED"; id: string }
  | { type: "TOGGLE_SPECIMEN_SELECTED"; id: string }
  | { type: "CLEAR_SELECTION" };

/** Remove a specimen id from every material and drop materials left empty. */
function pruneMaterials(materials: Material[], removedIds: Set<string>): Material[] {
  return materials
    .map((m) => ({ ...m, specimenIds: m.specimenIds.filter((id) => !removedIds.has(id)) }))
    .filter((m) => m.specimenIds.length > 0);
}

/**
 * Drop selected-material ids that no longer exist after a material was pruned,
 * deleted, or merged away. Without this a stale id lingers in `selection` and the
 * compare views (which filter to the selected ids) would collapse to nothing.
 * Returns the same `selection` object when nothing changed.
 */
function reconcileMaterialSelection(selection: Selection, materials: Material[]): Selection {
  const live = new Set(materials.map((m) => m.id));
  if (selection.materialIds.every((id) => live.has(id))) return selection;
  return { ...selection, materialIds: selection.materialIds.filter((id) => live.has(id)) };
}

export function reducer(state: TensileState, action: Action): TensileState {
  switch (action.type) {
    case "LOAD_STATE":
      // Replace wholesale with a persisted snapshot, backfilling params so an
      // older snapshot missing a newer param still works.
      return { ...INITIAL_STATE, ...action.state, params: { ...DEFAULT_PARAMS, ...action.state.params } };

    case "ADD_FILE": {
      return {
        ...state,
        files: [...state.files, action.file],
        specimens: [...state.specimens, ...action.specimens],
        materials: action.material ? [...state.materials, action.material] : state.materials,
      };
    }

    case "REMOVE_FILE": {
      const removed = new Set(
        state.specimens.filter((s) => s.fileId === action.fileId).map((s) => s.id),
      );
      const materials = pruneMaterials(state.materials, removed);
      const liveMaterials = new Set(materials.map((m) => m.id));
      return {
        ...state,
        files: state.files.filter((f) => f.id !== action.fileId),
        specimens: state.specimens.filter((s) => s.fileId !== action.fileId),
        materials,
        selection: {
          materialIds: state.selection.materialIds.filter((id) => liveMaterials.has(id)),
          specimenIds: state.selection.specimenIds.filter((id) => !removed.has(id)),
          property: state.selection.property,
        },
      };
    }

    case "CLEAR_ALL":
      return { ...INITIAL_STATE, params: state.params };

    case "SET_PARAMS":
      return { ...state, params: { ...state.params, ...action.params } };

    case "RENAME_MATERIAL":
      return {
        ...state,
        materials: state.materials.map((m) =>
          m.id === action.id ? { ...m, name: action.name } : m,
        ),
      };

    case "SET_EXCLUDED":
      return {
        ...state,
        specimens: state.specimens.map((s) =>
          s.id === action.specimenId ? { ...s, excluded: action.excluded } : s,
        ),
      };

    case "MOVE_SPECIMEN": {
      if (!state.materials.some((m) => m.id === action.toMaterialId)) return state;
      const materials = state.materials
        .map((m) => {
          if (m.id === action.toMaterialId) {
            return m.specimenIds.includes(action.specimenId)
              ? m
              : { ...m, specimenIds: [...m.specimenIds, action.specimenId] };
          }
          return { ...m, specimenIds: m.specimenIds.filter((id) => id !== action.specimenId) };
        })
        .filter((m) => m.specimenIds.length > 0);
      return { ...state, materials, selection: reconcileMaterialSelection(state.selection, materials) };
    }

    case "MERGE_MATERIALS": {
      const source = state.materials.find((m) => m.id === action.sourceId);
      if (!source || action.sourceId === action.targetId) return state;
      const materials = state.materials
        .map((m) =>
          m.id === action.targetId
            ? {
                ...m,
                specimenIds: [
                  ...m.specimenIds,
                  ...source.specimenIds.filter((id) => !m.specimenIds.includes(id)),
                ],
              }
            : m,
        )
        .filter((m) => m.id !== action.sourceId);
      return { ...state, materials, selection: reconcileMaterialSelection(state.selection, materials) };
    }

    case "CREATE_MATERIAL_FROM": {
      const ids = action.specimenIds.filter((id) => state.specimens.some((s) => s.id === id));
      if (ids.length === 0) return state;
      const idSet = new Set(ids);
      const newMaterial: Material = { id: newId("mat"), name: action.name, specimenIds: ids };
      const materials = state.materials
        .map((m) => ({ ...m, specimenIds: m.specimenIds.filter((id) => !idSet.has(id)) }))
        .filter((m) => m.specimenIds.length > 0);
      const next = [...materials, newMaterial];
      return { ...state, materials: next, selection: reconcileMaterialSelection(state.selection, next) };
    }

    case "DELETE_MATERIAL": {
      const materials = state.materials.filter((m) => m.id !== action.id);
      return { ...state, materials, selection: reconcileMaterialSelection(state.selection, materials) };
    }

    case "SET_SELECTION":
      return { ...state, selection: { ...state.selection, ...action.selection } };

    case "TOGGLE_MATERIAL_SELECTED": {
      const cur = state.selection.materialIds;
      const next = cur.includes(action.id)
        ? cur.filter((id) => id !== action.id)
        : [...cur, action.id];
      return { ...state, selection: { ...state.selection, materialIds: next } };
    }

    case "TOGGLE_SPECIMEN_SELECTED": {
      const cur = state.selection.specimenIds;
      const next = cur.includes(action.id)
        ? cur.filter((id) => id !== action.id)
        : [...cur, action.id];
      return { ...state, selection: { ...state.selection, specimenIds: next } };
    }

    case "CLEAR_SELECTION":
      return { ...state, selection: { ...state.selection, materialIds: [], specimenIds: [] } };

    default:
      return state;
  }
}

// --------------------------------------------------------------------------- //
// Building blocks for ADD_FILE                                                //
// --------------------------------------------------------------------------- //

/** Turn a parsed workbook into a file record, its raw specimens, and a material. */
export function buildFromParsed(parsed: ParsedWorkbook): {
  file: LoadedFile;
  specimens: RawSpecimen[];
  material: Material | null;
} {
  const fileId = newId("file");
  const specimens: RawSpecimen[] = parsed.runs.map((run) => ({
    id: newId("spec"),
    label: run.label,
    sheet: run.sheet,
    fileId,
    fileName: parsed.fileName,
    raw: run,
    excluded: false,
    // The instrument's own numbers for this specimen, matched by label (Phase 8).
    machine: parsed.machine?.[run.label] ?? parsed.machine?.[run.sheet],
  }));
  const file: LoadedFile = {
    id: fileId,
    fileName: parsed.fileName,
    specimenCount: specimens.length,
    skippedSheets: parsed.skippedSheets,
    detection: parsed.detection,
    strainUnit: parsed.strainUnit,
  };
  // Default grouping: one material per file (auto-named), holding all its runs.
  const material: Material | null =
    specimens.length > 0
      ? {
          id: newId("mat"),
          name: materialNameFromFile(parsed.fileName),
          specimenIds: specimens.map((s) => s.id),
        }
      : null;
  return { file, specimens, material };
}
