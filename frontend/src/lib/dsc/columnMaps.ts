// Remembered column mappings for generic CSV / spreadsheet imports.
//
// Keyed by header signature (the joined, lowercased header text, from
// `parse/genericTable.ts`'s `headerSignature`), so the second import of the
// same export layout never asks again — even for a differently named file.
// Kept out of the dialog component so the import hook can consult it without
// pulling a component module in, and so the dialog file only exports
// components (fast refresh). Mirrors `lib/tga/columnMaps.ts`.
//
// Every access fails soft: a blocked or corrupt localStorage just means the
// dialog opens with the auto-detected guess, which is the pre-memory behaviour.

import type { DscColumnMap } from "./types";

const REMEMBERED_KEY = "dsc.columnMaps.v1";

/** All remembered mappings, `headerSignature → DscColumnMap`. */
export function loadRememberedMaps(): Record<string, DscColumnMap> {
  try {
    const raw = localStorage.getItem(REMEMBERED_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, DscColumnMap>) : {};
  } catch {
    return {};
  }
}

/** Remember a mapping against a header signature. No-op for an empty signature. */
export function rememberMap(signature: string, map: DscColumnMap): void {
  if (!signature) return;
  try {
    const all = loadRememberedMaps();
    all[signature] = map;
    localStorage.setItem(REMEMBERED_KEY, JSON.stringify(all));
  } catch {
    /* storage full or blocked — the mapping still applies to this import */
  }
}
