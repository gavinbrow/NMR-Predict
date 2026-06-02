// Display formatting for tensile values. Centralizes the "NaN → N/A" rule and
// the per-property decimal places so the table, the cards, and the charts all
// render numbers the same way.

import { PROPERTY_META } from "./compute";
import type { PropertyKey } from "./types";

const META_BY_KEY = new Map(PROPERTY_META.map((m) => [m.key, m]));

/** Format a numeric property value, rendering non-finite as "N/A". */
export function formatValue(key: PropertyKey, value: number): string {
  if (!Number.isFinite(value)) return "N/A";
  const decimals = META_BY_KEY.get(key)?.decimals ?? 2;
  return value.toFixed(decimals);
}

/** Format a "mean ± SD" string for a property (or "N/A" when n = 0). */
export function formatMeanSd(key: PropertyKey, mean: number, sd: number): string {
  if (!Number.isFinite(mean)) return "N/A";
  const decimals = META_BY_KEY.get(key)?.decimals ?? 2;
  return `${mean.toFixed(decimals)} ± ${(Number.isFinite(sd) ? sd : 0).toFixed(decimals)}`;
}

/** The label + unit for a property, e.g. "Young's modulus (MPa)". */
export function propertyLabel(key: PropertyKey): string {
  const m = META_BY_KEY.get(key);
  return m ? `${m.label} (${m.unit})` : key;
}

/** The short unit suffix for a property, e.g. "MPa". */
export function propertyUnit(key: PropertyKey): string {
  return META_BY_KEY.get(key)?.unit ?? "";
}
