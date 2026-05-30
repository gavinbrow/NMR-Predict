// IndexedDB persistence for MALDI projects.
//
// Projects live entirely client-side (local-first, no backend). A project record
// wraps a full {@link ProjectState}; raw spectra are kept as Float64Arrays, which
// IndexedDB stores via structured clone with no serialization step.
//
// This is the Phase 0 skeleton: open / create / save / load / list / delete. The
// schema's single store and `by-updated` index are enough for the project picker;
// later phases extend ProjectState, not this storage layer.

import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import {
  emptyProjectState,
  type ProjectRecord,
  type ProjectState,
  type ProjectSummary,
} from "./types";
import type { ChemistryTemplate } from "./repeatLibrary";

const DB_NAME = "maldi";
const DB_VERSION = 2;
const STORE = "projects";
const TEMPLATE_STORE = "templates";

interface MaldiDB extends DBSchema {
  projects: {
    key: string;
    value: ProjectRecord;
    indexes: { "by-updated": number };
  };
  templates: {
    key: string;
    value: ChemistryTemplate;
  };
}

let dbPromise: Promise<IDBPDatabase<MaldiDB>> | null = null;

function getDb(): Promise<IDBPDatabase<MaldiDB>> {
  if (!dbPromise) {
    dbPromise = openDB<MaldiDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("by-updated", "updatedAt");
        }
        if (!db.objectStoreNames.contains(TEMPLATE_STORE)) {
          db.createObjectStore(TEMPLATE_STORE, { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `proj-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Create and persist a new project, returning the stored record. */
export async function createProject(
  name: string,
  state: ProjectState = emptyProjectState(),
): Promise<ProjectRecord> {
  const now = Date.now();
  const record: ProjectRecord = {
    id: newId(),
    name,
    createdAt: now,
    updatedAt: now,
    state,
  };
  const db = await getDb();
  await db.put(STORE, record);
  return record;
}

/** Persist an existing project, stamping `updatedAt`. Returns the saved record. */
export async function saveProject(record: ProjectRecord): Promise<ProjectRecord> {
  const updated: ProjectRecord = { ...record, updatedAt: Date.now() };
  const db = await getDb();
  await db.put(STORE, updated);
  return updated;
}

/** Load a full project record by id, or `undefined` if it does not exist. */
export async function loadProject(id: string): Promise<ProjectRecord | undefined> {
  const db = await getDb();
  return db.get(STORE, id);
}

/** List all projects as lightweight summaries, most-recently-updated first. */
export async function listProjects(): Promise<ProjectSummary[]> {
  const db = await getDb();
  const records = await db.getAll(STORE);
  return records
    .map((record) => ({
      id: record.id,
      name: record.name,
      sourceName: record.state.sourceName,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      pointCount: record.state.rawSpectrum?.mz.length ?? 0,
      peakCount: record.state.peaks.length,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Delete a project by id. No-op if it does not exist. */
export async function deleteProject(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE, id);
}

// --- User chemistry templates -----------------------------------------------

/** List user-saved chemistry templates (newest first). */
export async function listTemplates(): Promise<ChemistryTemplate[]> {
  const db = await getDb();
  const all = await db.getAll(TEMPLATE_STORE);
  return all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** Save (create or overwrite) a chemistry template. */
export async function saveTemplate(template: ChemistryTemplate): Promise<ChemistryTemplate> {
  const record: ChemistryTemplate = {
    ...template,
    id: template.id || (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `tpl-${Date.now()}`),
    createdAt: template.createdAt ?? Date.now(),
    builtin: false,
  };
  const db = await getDb();
  await db.put(TEMPLATE_STORE, record);
  return record;
}

/** Delete a saved template by id. */
export async function deleteTemplate(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(TEMPLATE_STORE, id);
}
