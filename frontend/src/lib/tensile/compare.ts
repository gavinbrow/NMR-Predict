// Pure builders for the Phase 7 compare charts. Each turns the store's resolved
// `MaterialView`s (and the analysis params) into the plain data shape one chart
// view consumes — no React, no recharts — so the same data drives both the live
// tabs and the offscreen render used for PDF/PNG export, and so the reshaping is
// unit-testable.

import { cleanCurve, summarize } from "./compute";
import { effectivePercent } from "./store-core";
import type { MaterialView, PropertyKey, Specimen } from "./types";

/** One specimen's cleaned + decimated curve, colored by its material. */
export interface CurveSeries {
  id: string;
  label: string;
  materialName: string;
  color: string;
  excluded: boolean;
  data: { x: number; y: number }[];
}

/** One material's mean ± SD for a property, plus its raw included values. */
export interface BarDatum {
  id: string;
  name: string;
  color: string;
  mean: number;
  sd: number;
  /** Individual included-specimen values (for the optional dots). */
  points: { label: string; value: number }[];
}

/** One specimen as a point in property-vs-property space. */
export interface ScatterPoint {
  id: string;
  label: string;
  materialId: string;
  materialName: string;
  color: string;
  x: number;
  y: number;
}

/** One material's spread of a single property (for the distribution view). */
export interface DistDatum {
  id: string;
  name: string;
  color: string;
  mean: number;
  sd: number;
  values: { label: string; value: number }[];
}

const MAX_PLOT_POINTS = 400;

/**
 * Evenly decimate a curve for display, always keeping the first and last point.
 * `maxPoints` caps the per-curve budget; callers lower it when many curves are
 * overlaid so the figure stays light and interaction stays smooth.
 */
export function decimateCurve(
  s: number[],
  st: number[],
  maxPoints = MAX_PLOT_POINTS,
): { x: number; y: number }[] {
  const n = s.length;
  if (n <= maxPoints) return s.map((x, i) => ({ x, y: st[i] }));
  const step = (n - 1) / (maxPoints - 1);
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < maxPoints; i += 1) {
    const idx = Math.round(i * step);
    out.push({ x: s[idx], y: st[idx] });
  }
  return out;
}

/** Build the overlaid stress–strain series for a set of specimens. */
export function buildCurves(
  materials: MaterialView[],
  specimens: Specimen[],
  params: Parameters<typeof effectivePercent>[1],
  maxPoints = MAX_PLOT_POINTS,
): CurveSeries[] {
  const meta = new Map<string, { name: string; color: string }>();
  for (const mv of materials) {
    for (const id of mv.specimenIds) meta.set(id, { name: mv.name, color: mv.color });
  }
  return specimens.map((s) => {
    const { s: x, st: y } = cleanCurve(s.raw.strain, s.raw.stress, effectivePercent(s, params));
    const m = meta.get(s.id);
    return {
      id: s.id,
      label: s.label,
      materialName: m?.name ?? "—",
      color: m?.color ?? "#64748b",
      excluded: s.excluded,
      data: decimateCurve(x, y, maxPoints),
    };
  });
}

/** Build per-material mean ± SD bars for one property (over included specimens). */
export function buildBars(materials: MaterialView[], property: PropertyKey): BarDatum[] {
  return materials.map((mv) => {
    const points = mv.includedSpecimens
      .map((s) => ({ label: s.label, value: s.props[property] as number }))
      .filter((p) => Number.isFinite(p.value));
    const stat = mv.stats[property];
    return {
      id: mv.id,
      name: mv.name,
      color: mv.color,
      mean: stat?.mean ?? NaN,
      sd: stat && Number.isFinite(stat.sd) ? stat.sd : 0,
      points,
    };
  });
}

/** Build the property-vs-property scatter, one point per included specimen. */
export function buildScatter(
  materials: MaterialView[],
  xKey: PropertyKey,
  yKey: PropertyKey,
): ScatterPoint[] {
  const out: ScatterPoint[] = [];
  for (const mv of materials) {
    for (const s of mv.includedSpecimens) {
      const x = s.props[xKey] as number;
      const y = s.props[yKey] as number;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        out.push({
          id: s.id,
          label: s.label,
          materialId: mv.id,
          materialName: mv.name,
          color: mv.color,
          x,
          y,
        });
      }
    }
  }
  return out;
}

/** Build the per-material distribution of one property (values + mean ± SD). */
export function buildDistribution(materials: MaterialView[], property: PropertyKey): DistDatum[] {
  return materials.map((mv) => {
    const values = mv.includedSpecimens
      .map((s) => ({ label: s.label, value: s.props[property] as number }))
      .filter((p) => Number.isFinite(p.value));
    const stat = summarize(values.map((v) => v.value));
    return {
      id: mv.id,
      name: mv.name,
      color: mv.color,
      mean: stat.mean,
      sd: Number.isFinite(stat.sd) ? stat.sd : 0,
      values,
    };
  });
}
