// Remembered column mappings for generic CSV / spreadsheet imports.
//
// Keyed by header signature (the joined, lowercased header text), so the second
// import of the same export layout never asks again — even for a differently
// named file. Kept out of the dialog component so the import hook can consult
// it without pulling a component module in, and so the dialog file only exports
// components (fast refresh).
//
// Every access fails soft: a blocked or corrupt localStorage just means the
// dialog opens with the auto-detected guess, which is the pre-memory behaviour.

import type { ColumnMap } from "./types";

const REMEMBERED_KEY = "tga.columnMaps.v1";

/** All remembered mappings, `headerSignature → ColumnMap`. */
export function loadRememberedMaps(): Record<string, ColumnMap> {
  try {
    const raw = localStorage.getItem(REMEMBERED_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, ColumnMap>) : {};
  } catch {
    return {};
  }
}

/** Remember a mapping against a header signature. No-op for an empty signature. */
export function rememberMap(signature: string, map: ColumnMap): void {
  if (!signature) return;
  try {
    const all = loadRememberedMaps();
    all[signature] = map;
    localStorage.setItem(REMEMBERED_KEY, JSON.stringify(all));
  } catch {
    /* storage full or blocked — the mapping still applies to this import */
  }
}
