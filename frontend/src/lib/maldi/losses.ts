// Fragment / neutral-loss detection.
//
// Beyond the repeat-unit ladder, MALDI spectra often show satellite peaks offset
// from a parent by a *small* characteristic neutral loss (water, CO, CO2, methyl,
// ammonia, common adduct swaps, etc.). Spotting these helps confirm assignments
// and explain otherwise-orphan peaks. This scans every close peak pair against a
// library of named losses and reports matches — it only flags, never deletes.

import type { Peak } from "./types";

export interface LossLibraryEntry {
  id: string;
  label: string;
  /** Neutral mass lost (Da). */
  mass: number;
}

/** Common small neutral losses / gains seen in MALDI and post-source decay. */
export const LOSS_LIBRARY: LossLibraryEntry[] = [
  { id: "h2o", label: "H2O", mass: 18.010565 },
  { id: "2h2o", label: "2×H2O", mass: 36.02113 },
  { id: "nh3", label: "NH3", mass: 17.026549 },
  { id: "co", label: "CO", mass: 27.994915 },
  { id: "co2", label: "CO2", mass: 43.989829 },
  { id: "ch2", label: "CH2", mass: 14.015650 },
  { id: "ch3", label: "CH3", mass: 15.023475 },
  { id: "ch4", label: "CH4", mass: 16.031300 },
  { id: "c2h4", label: "C2H4", mass: 28.031300 },
  { id: "ch2o", label: "CH2O (formaldehyde)", mass: 30.010565 },
  { id: "hcooh", label: "HCOOH (formic acid)", mass: 46.005479 },
  { id: "ch3oh", label: "CH3OH (methanol)", mass: 32.026215 },
  { id: "naAdd", label: "Na↔H (adduct swap)", mass: 21.981944 },
  { id: "kAdd", label: "K↔H (adduct swap)", mass: 37.955882 },
];

export interface LossDetectOptions {
  /** Match tolerance for a loss spacing (Da). Default 0.2. */
  toleranceDa?: number;
  /** Only consider pairs whose Δm is at most this (Da). Default 60. */
  maxDelta?: number;
  /** Restrict to these library ids. */
  losses?: string[];
  /** Minimum relative intensity of the lighter (fragment) peak. Default 0. */
  minRelIntensity?: number;
}

export interface LossEvent {
  id: string;
  /** Parent (heavier) peak id and fragment (lighter) peak id. */
  parentPeakId: string;
  fragmentPeakId: string;
  parentMz: number;
  fragmentMz: number;
  /** Observed mass gap (Da). */
  deltaMass: number;
  /** Matched library loss. */
  lossId: string;
  lossLabel: string;
  /** Signed error vs the library mass (Da). */
  errorDa: number;
}

function peakMz(p: Peak): number {
  return p.centroid ?? p.mz;
}

let lossCounter = 0;
function lossId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  lossCounter += 1;
  return `loss-${Date.now()}-${lossCounter}`;
}

/**
 * Detect neutral-loss relationships between peaks. Returns one event per matched
 * (parent, fragment, loss) triple, best (smallest error) first. The same pair can
 * match more than one library loss only when their masses are within tolerance;
 * the closest match per pair is kept.
 */
export function detectLosses(peaks: Peak[], options: LossDetectOptions = {}): LossEvent[] {
  const tol = options.toleranceDa ?? 0.2;
  const maxDelta = options.maxDelta ?? 60;
  const lib = options.losses
    ? LOSS_LIBRARY.filter((l) => options.losses!.includes(l.id))
    : LOSS_LIBRARY;

  const pts = peaks
    .filter((p) => p.accepted !== false && !p.ignored && p.flag !== "isotope")
    .slice()
    .sort((a, b) => peakMz(a) - peakMz(b));
  if (pts.length < 2) return [];

  const base = pts.reduce((m, p) => Math.max(m, p.intensity), 0) || 1;
  const minInt = (options.minRelIntensity ?? 0) * base;

  const events: LossEvent[] = [];
  for (let i = 0; i < pts.length; i += 1) {
    if (pts[i].intensity < minInt) continue;
    for (let j = i + 1; j < pts.length; j += 1) {
      const delta = peakMz(pts[j]) - peakMz(pts[i]);
      if (delta > maxDelta) break;
      // Best library match for this pair.
      let best: LossLibraryEntry | null = null;
      let bestErr = tol;
      for (const entry of lib) {
        const err = Math.abs(delta - entry.mass);
        if (err <= bestErr) {
          bestErr = err;
          best = entry;
        }
      }
      if (!best) continue;
      events.push({
        id: lossId(),
        parentPeakId: pts[j].id,
        fragmentPeakId: pts[i].id,
        parentMz: peakMz(pts[j]),
        fragmentMz: peakMz(pts[i]),
        deltaMass: delta,
        lossId: best.id,
        lossLabel: best.label,
        errorDa: delta - best.mass,
      });
    }
  }

  events.sort((a, b) => Math.abs(a.errorDa) - Math.abs(b.errorDa));
  return events;
}
