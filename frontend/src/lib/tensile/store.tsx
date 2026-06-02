// Tensile workspace store (Phase 3) — the single source of truth the whole tab
// reads from.
//
// This file holds the React layer: a Context wrapping a `useReducer` over the
// raw state (in `store-core.ts`), plus the memoized derived data — each
// specimen's computed `props`, and each material's pooled statistics. The
// derived layer is keyed only on the inputs that matter (the curves and the
// params), so changing an `AnalysisParams` value re-runs the compute engine
// across every specimen exactly once. The provider lives at the page root;
// because the Tensile route is kept alive in `App.tsx`, the store survives tab
// switches.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { extractRun, PROPERTY_META, summarize } from "./compute";
import { clearState, loadState, saveState } from "./persistence";
import {
  buildFromParsed,
  effectivePercent,
  INITIAL_STATE,
  materialColor,
  reducer,
} from "./store-core";
import type {
  AnalysisParams,
  LoadedFile,
  Material,
  MaterialStats,
  MaterialView,
  ParsedWorkbook,
  PropertyKey,
  Selection,
  Specimen,
} from "./types";

export interface TensileStore {
  // Raw state
  files: LoadedFile[];
  materials: Material[];
  params: AnalysisParams;
  selection: Selection;
  // Derived
  specimens: Specimen[];
  specimenById: Map<string, Specimen>;
  materialViews: MaterialView[];
  /** Specimens not assigned to any material (e.g. after a manual delete). */
  unassignedSpecimens: Specimen[];
  hasData: boolean;
  // Actions
  addParsedWorkbooks: (parsed: ParsedWorkbook[]) => void;
  removeFile: (fileId: string) => void;
  clearAll: () => void;
  setParams: (params: Partial<AnalysisParams>) => void;
  renameMaterial: (id: string, name: string) => void;
  setExcluded: (specimenId: string, excluded: boolean) => void;
  moveSpecimen: (specimenId: string, toMaterialId: string) => void;
  mergeMaterials: (sourceId: string, targetId: string) => void;
  createMaterialFrom: (specimenIds: string[], name: string) => void;
  deleteMaterial: (id: string) => void;
  setSelection: (selection: Partial<Selection>) => void;
  setProperty: (property: PropertyKey) => void;
  toggleMaterialSelected: (id: string) => void;
  toggleSpecimenSelected: (id: string) => void;
  clearSelection: () => void;
}

const TensileContext = createContext<TensileStore | null>(null);

export function TensileProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  // Persistence (Phase 10): restore a saved workspace once on mount, then save a
  // snapshot of the raw state (debounced) whenever it changes. `hydrated` gates
  // saving so the initial empty state can't clobber a snapshot before it loads.
  const hydrated = useRef(false);
  // The page is lazy-mounted on first visit, so the async load can resolve after
  // the user has already dropped a file. `latestState` lets us check the live
  // state when the snapshot arrives and skip restoring if work is already under
  // way — the user's current workspace wins and is saved over the old snapshot.
  const latestState = useRef(state);
  latestState.current = state;
  useEffect(() => {
    let cancelled = false;
    loadState().then((saved) => {
      const cur = latestState.current;
      const curEmpty = cur.files.length === 0 && cur.specimens.length === 0;
      if (!cancelled && curEmpty && saved && (saved.files.length > 0 || saved.specimens.length > 0)) {
        dispatch({ type: "LOAD_STATE", state: saved });
      }
      hydrated.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    const id = setTimeout(() => {
      if (state.files.length === 0 && state.specimens.length === 0) void clearState();
      else void saveState(state);
    }, 400);
    return () => clearTimeout(id);
  }, [state]);

  // Derived: every specimen with its computed props. Recomputes only when the
  // curves or the analysis params change.
  const specimens = useMemo<Specimen[]>(
    () =>
      state.specimens.map((s) => ({
        ...s,
        props: extractRun(
          s.raw.strain,
          s.raw.stress,
          effectivePercent(s, state.params),
          state.params,
        ),
      })),
    [state.specimens, state.params],
  );

  const specimenById = useMemo(() => {
    const map = new Map<string, Specimen>();
    for (const s of specimens) map.set(s.id, s);
    return map;
  }, [specimens]);

  // Derived: each material with resolved specimens and pooled stats.
  const materialViews = useMemo<MaterialView[]>(() => {
    return state.materials.map((m, i) => {
      const members = m.specimenIds
        .map((id) => specimenById.get(id))
        .filter((s): s is Specimen => s != null);
      const included = members.filter((s) => !s.excluded);
      const stats: MaterialStats = {};
      for (const { key } of PROPERTY_META) {
        stats[key] = summarize(included.map((s) => s.props[key] as number));
      }
      return {
        ...m,
        color: materialColor(i),
        specimens: members,
        includedSpecimens: included,
        stats,
      };
    });
  }, [state.materials, specimenById]);

  const unassignedSpecimens = useMemo<Specimen[]>(() => {
    const assigned = new Set(state.materials.flatMap((m) => m.specimenIds));
    return specimens.filter((s) => !assigned.has(s.id));
  }, [specimens, state.materials]);

  const addParsedWorkbooks = useCallback((parsed: ParsedWorkbook[]) => {
    for (const p of parsed) {
      const { file, specimens: specs, material } = buildFromParsed(p);
      dispatch({ type: "ADD_FILE", file, specimens: specs, material });
    }
  }, []);

  const value = useMemo<TensileStore>(
    () => ({
      files: state.files,
      materials: state.materials,
      params: state.params,
      selection: state.selection,
      specimens,
      specimenById,
      materialViews,
      unassignedSpecimens,
      hasData: state.files.length > 0,
      addParsedWorkbooks,
      removeFile: (fileId) => dispatch({ type: "REMOVE_FILE", fileId }),
      clearAll: () => dispatch({ type: "CLEAR_ALL" }),
      setParams: (params) => dispatch({ type: "SET_PARAMS", params }),
      renameMaterial: (id, name) => dispatch({ type: "RENAME_MATERIAL", id, name }),
      setExcluded: (specimenId, excluded) =>
        dispatch({ type: "SET_EXCLUDED", specimenId, excluded }),
      moveSpecimen: (specimenId, toMaterialId) =>
        dispatch({ type: "MOVE_SPECIMEN", specimenId, toMaterialId }),
      mergeMaterials: (sourceId, targetId) =>
        dispatch({ type: "MERGE_MATERIALS", sourceId, targetId }),
      createMaterialFrom: (specimenIds, name) =>
        dispatch({ type: "CREATE_MATERIAL_FROM", specimenIds, name }),
      deleteMaterial: (id) => dispatch({ type: "DELETE_MATERIAL", id }),
      setSelection: (selection) => dispatch({ type: "SET_SELECTION", selection }),
      setProperty: (property) => dispatch({ type: "SET_SELECTION", selection: { property } }),
      toggleMaterialSelected: (id) => dispatch({ type: "TOGGLE_MATERIAL_SELECTED", id }),
      toggleSpecimenSelected: (id) => dispatch({ type: "TOGGLE_SPECIMEN_SELECTED", id }),
      clearSelection: () => dispatch({ type: "CLEAR_SELECTION" }),
    }),
    [
      state.files,
      state.materials,
      state.params,
      state.selection,
      specimens,
      specimenById,
      materialViews,
      unassignedSpecimens,
      addParsedWorkbooks,
    ],
  );

  return <TensileContext.Provider value={value}>{children}</TensileContext.Provider>;
}

/** Access the Tensile store. Must be used within a {@link TensileProvider}. */
export function useTensileStore(): TensileStore {
  const ctx = useContext(TensileContext);
  if (!ctx) throw new Error("useTensileStore must be used within a TensileProvider");
  return ctx;
}
