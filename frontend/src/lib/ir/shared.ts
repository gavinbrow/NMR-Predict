// Shared display + table helpers used by both modes (View & Export and the
// Kinetics overlay). They tie the baseline math (§6) to the chosen y-axis and
// produce the wide export table on a common wavenumber grid.

import { correctBaseline } from "./baseline";
import { interp } from "./numerics";
import type { BaselineMethod, BaselinePoint, Spectrum, YAxis } from "./types";

/** The wavenumber grid of the densest spectrum (most points). */
export function commonGrid(specs: Spectrum[]): number[] {
  if (specs.length === 0) return [];
  let densest = specs[0];
  for (const s of specs) {
    if (s.wavenumber.length > densest.wavenumber.length) densest = s;
  }
  return densest.wavenumber.slice();
}

/**
 * Baseline-correct a spectrum in absorbance space, then return the requested
 * y-axis: corrected absorbance, or `100·10^(−A)` for %T.
 */
export function displayY(
  spec: Spectrum,
  yaxis: YAxis,
  method: BaselineMethod,
  p1?: number,
  p2?: number,
  anchors?: BaselinePoint[],
): number[] {
  const corrected = correctBaseline(method, spec.wavenumber, spec.absorbance, p1, p2, anchors);
  if (yaxis === "Absorbance") return corrected;
  return corrected.map((a) => 100 * Math.pow(10, -a));
}

/** A wide table for export: a wavenumber column plus one column per spectrum. */
export interface SpectraTable {
  /** Column headers: `["wavenumber_cm-1", ...spec.name]`. */
  headers: string[];
  /** The shared wavenumber grid. */
  grid: number[];
  /** Row-major data: `rows[r] = [grid[r], y0[r], y1[r], …]`. */
  rows: number[][];
}

/**
 * Interpolate every spectrum's `displayY` onto the common grid and assemble a
 * wide table (`wavenumber_cm-1` first, then one column per spectrum name).
 */
export function buildTable(
  specs: Spectrum[],
  yaxis: YAxis,
  method: BaselineMethod,
  p1?: number,
  p2?: number,
  anchors?: BaselinePoint[],
): SpectraTable {
  const grid = commonGrid(specs);
  const columns = specs.map((spec) =>
    interp(grid, spec.wavenumber, displayY(spec, yaxis, method, p1, p2, anchors)),
  );
  const headers = ["wavenumber_cm-1", ...specs.map((s) => s.name)];
  const rows = grid.map((w, r) => [w, ...columns.map((c) => c[r])]);
  return { headers, grid, rows };
}
