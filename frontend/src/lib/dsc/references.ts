// ΔH°100 crystallinity reference library (§3.7 of the plan): a built-in table
// of 100 %-crystalline reference enthalpies plus user entries persisted in
// localStorage under `"dsc.references.v1"`, fail-soft exactly like
// `lib/tga/columnMaps.ts`'s remembered mappings.

import type { DscReference } from "./types";

/** Built-in library (J/g, 100 % crystalline reference enthalpies), each with
 *  a short source note. Ids are stable strings so a run's `referenceId` keeps
 *  resolving across reloads. */
export const BUILT_IN_REFERENCES: DscReference[] = [
  { id: "pe", name: "PE", enthalpy100JPerG: 293, builtIn: true, note: "Polyethylene" },
  {
    id: "pp-iso",
    name: "PP (isotactic)",
    enthalpy100JPerG: 207,
    builtIn: true,
    note: "Isotactic polypropylene",
  },
  {
    id: "pp-syn",
    name: "PP (syndiotactic)",
    enthalpy100JPerG: 190,
    builtIn: true,
    note: "Syndiotactic polypropylene",
  },
  { id: "pet", name: "PET", enthalpy100JPerG: 140, builtIn: true, note: "Poly(ethylene terephthalate)" },
  { id: "pbt", name: "PBT", enthalpy100JPerG: 142, builtIn: true, note: "Poly(butylene terephthalate)" },
  { id: "pa6", name: "PA6", enthalpy100JPerG: 230, builtIn: true, note: "Polyamide 6 (nylon 6)" },
  { id: "pa66", name: "PA66", enthalpy100JPerG: 255, builtIn: true, note: "Polyamide 66 (nylon 66)" },
  { id: "pla", name: "PLA/PLLA", enthalpy100JPerG: 93.7, builtIn: true, note: "Poly(lactic acid)" },
  { id: "pga", name: "PGA", enthalpy100JPerG: 183.2, builtIn: true, note: "Poly(glycolic acid)" },
  { id: "pcl", name: "PCL", enthalpy100JPerG: 139.5, builtIn: true, note: "Poly(caprolactone)" },
  { id: "peek", name: "PEEK", enthalpy100JPerG: 130, builtIn: true, note: "Poly(ether ether ketone)" },
  { id: "pom", name: "POM", enthalpy100JPerG: 326, builtIn: true, note: "Polyoxymethylene (acetal)" },
  { id: "pvdf", name: "PVDF", enthalpy100JPerG: 104.7, builtIn: true, note: "Poly(vinylidene fluoride)" },
  { id: "ptfe", name: "PTFE", enthalpy100JPerG: 82, builtIn: true, note: "Polytetrafluoroethylene" },
  { id: "phb", name: "PHB", enthalpy100JPerG: 146, builtIn: true, note: "Poly(hydroxybutyrate)" },
  {
    id: "phbv",
    name: "PHBV",
    enthalpy100JPerG: 146,
    builtIn: true,
    note: "Poly(hydroxybutyrate-co-valerate)",
  },
  { id: "peo", name: "PEO", enthalpy100JPerG: 196.8, builtIn: true, note: "Poly(ethylene oxide)" },
  { id: "pva", name: "PVA", enthalpy100JPerG: 138.6, builtIn: true, note: "Poly(vinyl alcohol)" },
  { id: "pvc", name: "PVC", enthalpy100JPerG: 176, builtIn: true, note: "Poly(vinyl chloride)" },
];

const REMEMBERED_KEY = "dsc.references.v1";

/** All user-entered references from localStorage. Fails soft: a blocked or
 *  corrupt store just yields no user entries, leaving the built-in library. */
export function loadUserReferences(): DscReference[] {
  try {
    const raw = localStorage.getItem(REMEMBERED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DscReference[]) : [];
  } catch {
    return [];
  }
}

/** Persist the full list of user-entered references. No-op (fails soft) when
 *  storage is blocked or full — the entries still apply for this session. */
export function saveUserReferences(refs: DscReference[]): void {
  try {
    localStorage.setItem(REMEMBERED_KEY, JSON.stringify(refs));
  } catch {
    /* storage full or blocked — entries still apply to this session */
  }
}

/** Built-in library plus the user's saved entries, built-ins first. */
export function allReferences(): DscReference[] {
  return [...BUILT_IN_REFERENCES, ...loadUserReferences()];
}

/**
 * % crystallinity: `Xc = (|ΔHm| − |ΔHcc|) / (ref × polymerFraction) × 100`.
 * `meltJPerG` and `coldCrystJPerG` are enthalpy MAGNITUDES (J/g); pass 0 for
 * a run with no cold-crystallization exotherm. Returns `null` when `ref` or
 * `polymerFraction` is not positive, so a filled composite with an unset
 * polymer fraction reports "—" rather than a wrong number.
 */
export function crystallinity(
  meltJPerG: number,
  coldCrystJPerG: number,
  ref: number,
  polymerFraction: number,
): number | null {
  if (!Number.isFinite(ref) || ref <= 0) return null;
  if (!Number.isFinite(polymerFraction) || polymerFraction <= 0) return null;
  if (!Number.isFinite(meltJPerG) || !Number.isFinite(coldCrystJPerG)) return null;
  const net = Math.abs(meltJPerG) - Math.abs(coldCrystJPerG);
  return (net / (ref * polymerFraction)) * 100;
}
