import { useEffect, useRef } from "react";
import type { ProjectState } from "@/lib/maldi/types";

/** A restorable point-in-time for one spectrum's analysis. `processed` is dropped
 *  (re-derived after restore) and `exportHistory` is excluded (append-only log). */
export interface UndoSnapshot {
  state: ProjectState;
  projectName: string;
}

interface HistoryEntry {
  past: UndoSnapshot[];
  future: UndoSnapshot[];
  current: UndoSnapshot | null;
}

export interface UseMaldiUndoArgs {
  activeDocId: string | null;
  /** Undoable state values; the checkpoint effect watches these (debounced). */
  deps: unknown[];
  getSnapshot: () => UndoSnapshot;
  restore: (s: UndoSnapshot) => void;
}

/** Compare snapshots by the references/primitives that actually change on edits.
 *  Each edit creates a new array/object reference for the field it touches, so
 *  reference equality is both cheap and sufficient here. */
function snapshotEqual(a: UndoSnapshot, b: UndoSnapshot): boolean {
  if (a.projectName !== b.projectName) return false;
  const sa = a.state;
  const sb = b.state;
  return (
    sa.sourceName === sb.sourceName &&
    sa.peaks === sb.peaks &&
    sa.series === sb.series &&
    sa.processing === sb.processing &&
    sa.adducts === sb.adducts &&
    sa.selectedAdductIds === sb.selectedAdductIds &&
    sa.pickParams === sb.pickParams &&
    sa.repeatMass === sb.repeatMass &&
    sa.repeatMasses === sb.repeatMasses &&
    sa.endGroupMass === sb.endGroupMass &&
    sa.repeatIsotopeAware === sb.repeatIsotopeAware &&
    sa.copolymerA === sb.copolymerA &&
    sa.copolymerB === sb.copolymerB &&
    sa.rawSpectrum === sb.rawSpectrum
  );
}

/**
 * Per-spectrum undo/redo for the MALDI workspace. Each open document carries its
 * own history (keyed by doc id) in a ref so checkpoints never re-render. Edits are
 * checkpointed ~400 ms after they settle; Ctrl/Cmd+Z undoes, Shift+Z or Ctrl+Y
 * redoes. Native text-undo inside inputs/textareas is left intact, and undo never
 * crosses a document boundary.
 */
export function useMaldiUndo({ activeDocId, deps, getSnapshot, restore }: UseMaldiUndoArgs) {
  const historyRef = useRef<Map<string, HistoryEntry>>(new Map());
  const isRestoringRef = useRef(false);
  const getSnapshotRef = useRef(getSnapshot);
  const restoreRef = useRef(restore);
  const activeDocIdRef = useRef(activeDocId);
  getSnapshotRef.current = getSnapshot;
  restoreRef.current = restore;
  activeDocIdRef.current = activeDocId;

  const key = (id: string | null) => id ?? "__none__";
  const ensure = (id: string | null): HistoryEntry => {
    let e = historyRef.current.get(key(id));
    if (!e) {
      e = { past: [], future: [], current: null };
      historyRef.current.set(key(id), e);
    }
    return e;
  };

  // Document switch: seed the new doc's baseline without checkpointing the switch.
  useEffect(() => {
    isRestoringRef.current = true;
    ensure(activeDocId).current = getSnapshotRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDocId]);

  // Debounced checkpoint of the undoable state.
  useEffect(() => {
    if (isRestoringRef.current) {
      // A restore (undo/redo or doc switch) just landed: adopt it as the baseline.
      isRestoringRef.current = false;
      ensure(activeDocIdRef.current).current = getSnapshotRef.current();
      return;
    }
    const handle = window.setTimeout(() => {
      const snap = getSnapshotRef.current();
      const e = ensure(activeDocIdRef.current);
      if (e.current && snapshotEqual(e.current, snap)) return;
      if (e.current) {
        e.past.push(e.current);
        if (e.past.length > 50) e.past.shift();
      }
      e.future = [];
      e.current = snap;
    }, 400);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // Keyboard: Ctrl/Cmd+Z undo, Shift+Z or Ctrl+Y redo. Bail in editable fields.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const k = event.key.toLowerCase();
      const isUndo = k === "z" && !event.shiftKey;
      const isRedo = (k === "z" && event.shiftKey) || k === "y";
      if (!isUndo && !isRedo) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      event.preventDefault();
      const e = ensure(activeDocIdRef.current);
      if (isUndo) {
        const prev = e.past.pop();
        if (!prev) return;
        if (e.current) e.future.push(e.current);
        e.current = prev;
        isRestoringRef.current = true;
        restoreRef.current(prev);
      } else {
        const next = e.future.pop();
        if (!next) return;
        if (e.current) e.past.push(e.current);
        e.current = next;
        isRestoringRef.current = true;
        restoreRef.current(next);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearHistory = (id: string) => {
    historyRef.current.delete(key(id));
  };
  const clearAll = () => {
    historyRef.current.clear();
  };

  return { clearHistory, clearAll };
}
