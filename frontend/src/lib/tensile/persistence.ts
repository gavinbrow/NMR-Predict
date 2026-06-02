// Phase 10 persistence — remember the workspace between sessions in IndexedDB
// (via `idb`, already an app dependency). We store a single snapshot of the raw
// store state (files, specimens, materials, params, selection); the derived
// `props`/stats are recomputed on load, so only the inputs are persisted. Curve
// arrays go through the structured-clone algorithm unchanged.
//
// Everything stays on the user's machine. A corrupt/oversized snapshot fails
// soft: load returns null and the tab starts fresh.

import { openDB, type IDBPDatabase } from "idb";
import type { TensileState } from "./store-core";

const DB_NAME = "tensile-workspace";
const STORE = "state";
const KEY = "current";
const VERSION = 1;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      },
    });
  }
  return dbPromise;
}

/** Persist the raw store state (best-effort; swallows quota/serialization errors). */
export async function saveState(state: TensileState): Promise<void> {
  try {
    const db = await getDb();
    // Strip anything non-cloneable defensively by round-tripping through JSON-safe
    // structuredClone — the state is already plain data, so this is just a guard.
    await db.put(STORE, structuredClone(state), KEY);
  } catch {
    // Persistence is a convenience, not a guarantee — never throw into the UI.
  }
}

/** Load the persisted state, or null when none/invalid. */
export async function loadState(): Promise<TensileState | null> {
  try {
    const db = await getDb();
    const value = (await db.get(STORE, KEY)) as TensileState | undefined;
    if (!value || !Array.isArray(value.files) || !Array.isArray(value.specimens)) return null;
    return value;
  } catch {
    return null;
  }
}

/** Forget the persisted workspace. */
export async function clearState(): Promise<void> {
  try {
    const db = await getDb();
    await db.delete(STORE, KEY);
  } catch {
    // ignore
  }
}
