// IndexedDB persistence for the DSC workspace — a single snapshot of the raw
// store state (files, runs, materials, params, references); the derived
// per-run `DscAnalysis` is recomputed on load, so only the inputs are
// persisted. Curve arrays go through the structured-clone algorithm
// unchanged. Everything stays on the user's machine. A corrupt/oversized
// snapshot fails soft: load returns null and the tab starts fresh. Mirrors
// `lib/tga/persistence.ts`.

import { openDB, type IDBPDatabase } from "idb";
import type { DscState } from "./store-core";

const DB_NAME = "dsc-workspace";
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

/** Persist the raw store state (best-effort; swallows errors). */
export async function saveState(state: DscState): Promise<void> {
  try {
    const db = await getDb();
    await db.put(STORE, structuredClone(state), KEY);
  } catch {
    // Persistence is a convenience, not a guarantee — never throw into the UI.
  }
}

/** Load the persisted state, or null when none/invalid. */
export async function loadState(): Promise<DscState | null> {
  try {
    const db = await getDb();
    const value = (await db.get(STORE, KEY)) as DscState | undefined;
    if (!value || !Array.isArray(value.files) || !Array.isArray(value.runs)) return null;
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
