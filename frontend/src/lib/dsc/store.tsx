// DSC workspace store — the single source of truth the whole tab reads from.
//
// This file holds the React layer: a Context wrapping a `useReducer` over the
// raw state (in `store-core.ts`), plus the memoized derived data — each run's
// computed `DscAnalysis`. The derived layer recomputes a run's analysis only
// when THAT run's own inputs change (§WP2: a per-run cache, not one memo over
// the whole array), so editing one run's transition window never recomputes
// its neighbours. The provider lives at the page root; because the DSC route
// is kept alive in `App.tsx`, the store survives tab switches.

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
import { autoDetectFeatures, computeDscAnalysis, segmentView, type DscAnalysis } from "./compute";
import { clearState, loadState, saveState } from "./persistence";
import { loadUserReferences, saveUserReferences } from "./references";
import { defaultSegmentId } from "./segments";
import { buildFromParsed, INITIAL_STATE, reducer, type DscState } from "./store-core";
import type {
  DscFeature,
  DscFile,
  DscMaterial,
  DscParams,
  DscReference,
  DscRun,
  ParsedDscFile,
} from "./types";

/** A run with its computed analysis attached — the shape the UI consumes. */
export interface DscRunAnalyzed extends DscRun {
  analysis: DscAnalysis;
}

export interface DscStore {
  // Raw state
  files: DscFile[];
  materials: DscMaterial[];
  params: DscParams;
  references: DscReference[];
  // Derived
  runs: DscRunAnalyzed[];
  runById: Map<string, DscRunAnalyzed>;
  /** Runs not assigned to any material (e.g. after a manual delete). */
  unassignedRuns: DscRunAnalyzed[];
  hasData: boolean;
  /** The raw (underived) state — what the project exporter serializes. */
  rawState: DscState;
  // Actions
  addParsedFiles: (parsed: ParsedDscFile[]) => void;
  /** Replace the whole workspace, e.g. when opening a `.dscproj` file. */
  loadProject: (state: DscState) => void;
  removeFile: (fileId: string) => void;
  removeRun: (runId: string) => void;
  clearAll: () => void;
  setParams: (params: Partial<DscParams>) => void;
  setRunColor: (runId: string, color: string) => void;
  setRunScale: (runId: string, scale: number) => void;
  setRunOffset: (runId: string, offset: number) => void;
  toggleRunVisible: (runId: string) => void;
  renameRun: (runId: string, label: string) => void;
  setActiveSegment: (runId: string, segmentId: string | null) => void;
  setRunMass: (runId: string, massOverrideMg: number | null) => void;
  setPolymerFraction: (runId: string, polymerFraction: number) => void;
  setRunReference: (runId: string, referenceId: string | null) => void;
  addFeature: (runId: string, feature: DscFeature) => void;
  updateFeature: (runId: string, featureId: string, patch: Partial<Omit<DscFeature, "id">>) => void;
  removeFeature: (runId: string, featureId: string) => void;
  resetFeatures: (runId: string) => void;
  renameMaterial: (id: string, name: string) => void;
  moveRun: (runId: string, toMaterialId: string) => void;
  mergeMaterials: (sourceId: string, targetId: string) => void;
  createMaterialFrom: (runIds: string[], name: string) => void;
  deleteMaterial: (id: string) => void;
  addReference: (reference: DscReference) => void;
  updateReference: (id: string, patch: Partial<Omit<DscReference, "id">>) => void;
  deleteReference: (id: string) => void;
}

const DscContext = createContext<DscStore | null>(null);

/** The per-run inputs that change a run's computed analysis, JSON-stringified
 *  into a cache key. Curve arrays (`timeMin`/`tempC`/`heatFlowMw`) are
 *  immutable once a run is parsed, so they're intentionally excluded — only
 *  the analysis-affecting fields the reducer can still change are here. */
function analysisKey(run: DscRun, params: DscParams): string {
  return JSON.stringify([
    run.activeSegmentId,
    run.features,
    run.massOverrideMg,
    run.polymerFraction,
    run.referenceId,
    params,
  ]);
}

export function DscProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE, (initial) => ({
    ...initial,
    references: loadUserReferences(),
  }));

  // Persistence: restore a saved workspace once on mount, then save a
  // snapshot (debounced) whenever it changes. `hydrated` gates saving so the
  // initial empty state can't clobber a snapshot before it loads.
  // `latestState` lets the async load check the live state and skip
  // restoring if work is already under way — the user's current workspace
  // wins.
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

  // The crystallinity reference library is a user preference independent of
  // the workspace snapshot above — `compute.ts` resolves a run's
  // `referenceId` straight from `references.ts`'s `allReferences()`, which
  // reads localStorage — so keep that mirror in sync with the reducer's copy
  // whenever it changes, including when a `.dscproj` open replaces it
  // wholesale via LOAD_STATE.
  useEffect(() => {
    saveUserReferences(state.references);
  }, [state.references]);

  // Sync auto-detection into the store. `computeDscAnalysis` (compute.ts)
  // auto-detects features on the fly for its own return value when a run's
  // active segment has none yet, but that detection is ephemeral — it feeds
  // the summary strip/table only, and never mutates `run.features`. Without
  // this, `FeaturePanel`/`TransitionTable`/`buildDscPlotMarkers`/the figure
  // adapter (all of which read `run.features`, the editable, persisted list)
  // would show nothing for a freshly imported run even though a Tg or melt
  // peak was in fact found. Run the same detection here and persist it the
  // first time a segment has zero features, so it becomes real "auto: true"
  // `DscFeature`s the user can select, drag a window on, or clear. Feature
  // ids are deterministic (segment id + kind + ordinal), so this is a no-op
  // once features exist for that segment — including after `RESET_FEATURES`,
  // which clears the list specifically to let this effect re-detect.
  useEffect(() => {
    if (!state.params.autoDetect) return;
    for (const run of state.runs) {
      const segmentId = run.activeSegmentId ?? defaultSegmentId(run.segments);
      if (!segmentId || run.features.some((f) => f.segmentId === segmentId)) continue;
      const segment = run.segments.find((s) => s.id === segmentId);
      if (!segment || segment.end - segment.start < 2) continue;
      const view = segmentView(run, segment, state.params);
      if (view.tempC.length < 2) continue;
      for (const feature of autoDetectFeatures(view, segment, state.params)) {
        dispatch({ type: "ADD_FEATURE", runId: run.id, feature });
      }
    }
  }, [state.runs, state.params]);

  // Derived: every run with its computed analysis, memoized PER RUN so
  // editing one run's transition window doesn't recompute the rest. The
  // cache is keyed by run id; a stored entry is reused only while its own
  // dependency signature (`analysisKey`) still matches.
  const analysisCache = useRef<Map<string, { key: string; value: DscAnalysis }>>(new Map());
  const runs = useMemo<DscRunAnalyzed[]>(() => {
    const cache = analysisCache.current;
    const seen = new Set<string>();
    const next = state.runs.map((r) => {
      seen.add(r.id);
      const key = analysisKey(r, state.params);
      const cached = cache.get(r.id);
      const analysis = cached && cached.key === key ? cached.value : computeDscAnalysis(r, state.params);
      if (!cached || cached.key !== key) cache.set(r.id, { key, value: analysis });
      return { ...r, analysis };
    });
    // Drop cache entries for runs that no longer exist so a long session of
    // adding/removing files doesn't leak memory.
    for (const id of cache.keys()) {
      if (!seen.has(id)) cache.delete(id);
    }
    return next;
  }, [state.runs, state.params]);

  const runById = useMemo(() => {
    const map = new Map<string, DscRunAnalyzed>();
    for (const r of runs) map.set(r.id, r);
    return map;
  }, [runs]);

  const unassignedRuns = useMemo<DscRunAnalyzed[]>(() => {
    const assigned = new Set(state.materials.flatMap((m) => m.runIds));
    return runs.filter((r) => !assigned.has(r.id));
  }, [runs, state.materials]);

  const addParsedFiles = useCallback((parsed: ParsedDscFile[]) => {
    for (const p of parsed) {
      const { file, runs: rs, material } = buildFromParsed(p);
      dispatch({ type: "ADD_FILE", file, runs: rs, material });
    }
  }, []);

  const value = useMemo<DscStore>(
    () => ({
      files: state.files,
      materials: state.materials,
      params: state.params,
      references: state.references,
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
      setActiveSegment: (runId, segmentId) =>
        dispatch({ type: "SET_ACTIVE_SEGMENT", runId, segmentId }),
      setRunMass: (runId, massOverrideMg) => dispatch({ type: "SET_RUN_MASS", runId, massOverrideMg }),
      setPolymerFraction: (runId, polymerFraction) =>
        dispatch({ type: "SET_POLYMER_FRACTION", runId, polymerFraction }),
      setRunReference: (runId, referenceId) =>
        dispatch({ type: "SET_RUN_REFERENCE", runId, referenceId }),
      addFeature: (runId, feature) => dispatch({ type: "ADD_FEATURE", runId, feature }),
      updateFeature: (runId, featureId, patch) =>
        dispatch({ type: "UPDATE_FEATURE", runId, featureId, patch }),
      removeFeature: (runId, featureId) => dispatch({ type: "REMOVE_FEATURE", runId, featureId }),
      resetFeatures: (runId) => dispatch({ type: "RESET_FEATURES", runId }),
      renameMaterial: (id, name) => dispatch({ type: "RENAME_MATERIAL", id, name }),
      moveRun: (runId, toMaterialId) => dispatch({ type: "MOVE_RUN", runId, toMaterialId }),
      mergeMaterials: (sourceId, targetId) => dispatch({ type: "MERGE_MATERIALS", sourceId, targetId }),
      createMaterialFrom: (runIds, name) => dispatch({ type: "CREATE_MATERIAL_FROM", runIds, name }),
      deleteMaterial: (id) => dispatch({ type: "DELETE_MATERIAL", id }),
      addReference: (reference) => dispatch({ type: "ADD_REFERENCE", reference }),
      updateReference: (id, patch) => dispatch({ type: "UPDATE_REFERENCE", id, patch }),
      deleteReference: (id) => dispatch({ type: "DELETE_REFERENCE", id }),
    }),
    [state, runs, runById, unassignedRuns, addParsedFiles],
  );

  return <DscContext.Provider value={value}>{children}</DscContext.Provider>;
}

/** Access the DSC store. Must be used within a {@link DscProvider}. */
export function useDscStore(): DscStore {
  const ctx = useContext(DscContext);
  if (!ctx) throw new Error("useDscStore must be used within a DscProvider");
  return ctx;
}
