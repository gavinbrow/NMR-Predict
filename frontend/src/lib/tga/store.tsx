// TGA workspace store — the single source of truth the whole tab reads from.
//
// This file holds the React layer: a Context wrapping a `useReducer` over the
// raw state (in `store-core.ts`), plus the memoized derived data — each run's
// computed `TgaAnalysis`. The derived layer is keyed only on the inputs that
// matter (the run's curves and the params), so changing an `AnalysisParams`
// value re-runs the compute engine across every run exactly once. The provider
// lives at the page root; because the TGA route is kept alive in `App.tsx`, the
// store survives tab switches.

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
import { computeAnalysis } from "./compute";
import { clearState, loadState, saveState } from "./persistence";
import { buildFromParsed, INITIAL_STATE, reducer } from "./store-core";
import type {
  AnalysisParams,
  ParsedTgaFile,
  TgaAnalysis,
  TgaLoadedFile,
  TgaMaterial,
  TgaRun,
  TgaState,
} from "./types";

/** A run with its computed analysis attached — the shape the UI consumes. */
export interface TgaRunAnalyzed extends TgaRun {
  analysis: TgaAnalysis;
}

export interface TgaStore {
  // Raw state
  files: TgaLoadedFile[];
  materials: TgaMaterial[];
  params: AnalysisParams;
  blankRunId: string | null;
  // Derived
  runs: TgaRunAnalyzed[];
  runById: Map<string, TgaRunAnalyzed>;
  /** Runs not assigned to any material (e.g. after a manual delete). */
  unassignedRuns: TgaRunAnalyzed[];
  hasData: boolean;
  /** The raw (underived) state — what the project exporter serializes. */
  rawState: TgaState;
  // Actions
  addParsedFiles: (parsed: ParsedTgaFile[]) => void;
  /** Replace the whole workspace, e.g. when opening a `.tgaproj` file. */
  loadProject: (state: TgaState) => void;
  removeFile: (fileId: string) => void;
  removeRun: (runId: string) => void;
  clearAll: () => void;
  setParams: (params: Partial<AnalysisParams>) => void;
  setRunColor: (runId: string, color: string) => void;
  setRunScale: (runId: string, scale: number) => void;
  setRunOffset: (runId: string, offset: number) => void;
  toggleRunVisible: (runId: string) => void;
  renameRun: (runId: string, label: string) => void;
  setBlankRun: (runId: string | null) => void;
  renameMaterial: (id: string, name: string) => void;
  moveRun: (runId: string, toMaterialId: string) => void;
  mergeMaterials: (sourceId: string, targetId: string) => void;
  createMaterialFrom: (runIds: string[], name: string) => void;
  deleteMaterial: (id: string) => void;
}

const TgaContext = createContext<TgaStore | null>(null);

export function TgaProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  // Persistence: restore a saved workspace once on mount, then save a snapshot
  // (debounced) whenever it changes. `hydrated` gates saving so the initial
  // empty state can't clobber a snapshot before it loads. `latestState` lets the
  // async load check the live state and skip restoring if work is already under
  // way — the user's current workspace wins.
  const hydrated = useRef(false);
  const latestState = useRef(state);
  latestState.current = state;
  useEffect(() => {
    let cancelled = false;
    void loadState().then((saved) => {
      const cur = latestState.current;
      const curEmpty = cur.files.length === 0 && cur.runs.length === 0;
      if (!cancelled && curEmpty && saved && (saved.files.length > 0 || saved.runs.length > 0)) {
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
      if (state.files.length === 0 && state.runs.length === 0) void clearState();
      else void saveState(state);
    }, 400);
    return () => clearTimeout(id);
  }, [state]);

  // Derived: every run with its computed analysis. Recomputes only when the
  // curves or the analysis params change. The blank run's correction is applied
  // here so the memo is keyed on the blank id too.
  const runs = useMemo<TgaRunAnalyzed[]>(
    () =>
      state.runs.map((r) => {
        const blank = state.blankRunId
          ? state.runs.find((b) => b.id === state.blankRunId)
          : null;
        const blankData = blank && blank.id !== r.id
          ? { tempC: blank.tempC, weightMg: blank.weightMg }
          : null;
        const analysis = computeAnalysis(
          r.weightMg,
          r.tempC,
          r.timeMin,
          state.params,
          { sampleSizeMg: r.meta.sampleSizeMg },
          blankData,
        );
        return { ...r, analysis };
      }),
    [state.runs, state.params, state.blankRunId],
  );

  const runById = useMemo(() => {
    const map = new Map<string, TgaRunAnalyzed>();
    for (const r of runs) map.set(r.id, r);
    return map;
  }, [runs]);

  const unassignedRuns = useMemo<TgaRunAnalyzed[]>(() => {
    const assigned = new Set(state.materials.flatMap((m) => m.runIds));
    return runs.filter((r) => !assigned.has(r.id));
  }, [runs, state.materials]);

  const addParsedFiles = useCallback((parsed: ParsedTgaFile[]) => {
    for (const p of parsed) {
      const { file, runs: rs, material } = buildFromParsed(p);
      dispatch({ type: "ADD_FILE", file, runs: rs, material });
    }
  }, []);

  const value = useMemo<TgaStore>(
    () => ({
      files: state.files,
      materials: state.materials,
      params: state.params,
      blankRunId: state.blankRunId,
      runs,
      runById,
      unassignedRuns,
      hasData: state.files.length > 0 || state.runs.length > 0,
      rawState: state,
      addParsedFiles,
      loadProject: (next) => dispatch({ type: "LOAD_STATE", state: next }),
      removeFile: (fileId) => dispatch({ type: "REMOVE_FILE", fileId }),
      removeRun: (runId) => dispatch({ type: "REMOVE_RUN", runId }),
      clearAll: () => dispatch({ type: "CLEAR_ALL" }),
      setParams: (params) => dispatch({ type: "SET_PARAMS", params }),
      setRunColor: (runId, color) => dispatch({ type: "SET_RUN_COLOR", runId, color }),
      setRunScale: (runId, scale) => dispatch({ type: "SET_RUN_SCALE", runId, scale }),
      setRunOffset: (runId, offset) => dispatch({ type: "SET_RUN_OFFSET", runId, offset }),
      toggleRunVisible: (runId) => dispatch({ type: "TOGGLE_RUN_VISIBLE", runId }),
      renameRun: (runId, label) => dispatch({ type: "RENAME_RUN", runId, label }),
      setBlankRun: (runId) => dispatch({ type: "SET_BLANK_RUN", runId }),
      renameMaterial: (id, name) => dispatch({ type: "RENAME_MATERIAL", id, name }),
      moveRun: (runId, toMaterialId) => dispatch({ type: "MOVE_RUN", runId, toMaterialId }),
      mergeMaterials: (sourceId, targetId) => dispatch({ type: "MERGE_MATERIALS", sourceId, targetId }),
      createMaterialFrom: (runIds, name) => dispatch({ type: "CREATE_MATERIAL_FROM", runIds, name }),
      deleteMaterial: (id) => dispatch({ type: "DELETE_MATERIAL", id }),
    }),
    [state, runs, runById, unassignedRuns, addParsedFiles],
  );

  return <TgaContext.Provider value={value}>{children}</TgaContext.Provider>;
}

/** Access the TGA store. Must be used within a {@link TgaProvider}. */
export function useTgaStore(): TgaStore {
  const ctx = useContext(TgaContext);
  if (!ctx) throw new Error("useTgaStore must be used within a TgaProvider");
  return ctx;
}