import { scanSpectrum } from "./chrom";
import { spectrumSimilarity } from "./peaks";
import type { MassSpectrum, MsRun } from "./types";

export interface PredictedScanCandidate {
  rtMin: number;
  score: number;
  matchedIons: number;
  diagnosticIons: number;
  coverage: number;
}

export interface PredictedRunMatch {
  accepted: boolean;
  best: PredictedScanCandidate | null;
  candidates: PredictedScanCandidate[];
  reason: string;
}

interface DiagnosticIon {
  mz: number;
  weight: number;
}

/** Select a small set of strong, separated ions. A single common fragment is
 * not enough evidence for a compound-level match. */
export function selectDiagnosticIons(
  predicted: MassSpectrum,
  mzRange: [number, number],
  maxIons = 10,
): DiagnosticIon[] {
  let base = 0;
  for (const value of predicted.intensity) {
    if (Number.isFinite(value) && value > base) base = value;
  }
  if (!(base > 0)) return [];

  const candidates: DiagnosticIon[] = [];
  for (let i = 0; i < predicted.mz.length; i += 1) {
    const mz = predicted.mz[i];
    const intensity = predicted.intensity[i];
    const rel = (intensity / base) * 100;
    if (
      Number.isFinite(mz) &&
      Number.isFinite(rel) &&
      rel >= 7 &&
      mz >= mzRange[0] - 0.5 &&
      mz <= mzRange[1] + 0.5
    ) {
      candidates.push({ mz, weight: rel });
    }
  }
  candidates.sort((a, b) => b.weight - a.weight || a.mz - b.mz);

  const selected: DiagnosticIon[] = [];
  for (const ion of candidates) {
    if (selected.some((other) => Math.abs(other.mz - ion.mz) < 0.75)) continue;
    selected.push(ion);
    if (selected.length >= maxIons) break;
  }
  return selected;
}

function scanIonRelativeIntensity(
  run: MsRun,
  scanIndex: number,
  targetMz: number,
  tolerance: number,
): number {
  const lo = run.scanOffset[scanIndex];
  const hi = run.scanOffset[scanIndex + 1];
  let hit = 0;
  for (let i = lo; i < hi; i += 1) {
    if (Math.abs(run.mz[i] - targetMz) <= tolerance && run.intensity[i] > hit) {
      hit = run.intensity[i];
    }
  }
  const base = run.basePeakIntensity[scanIndex];
  return base > 0 ? (hit / base) * 100 : 0;
}

/**
 * Search a run for a predicted EI spectrum using independent evidence:
 * full-spectrum cosine similarity, the number of diagnostic ions present, and
 * predicted-intensity coverage. Candidates that share only one common ion are
 * reported as weak evidence rather than a false positive.
 */
export function matchPredictedSpectrumInRun(
  run: MsRun,
  predicted: MassSpectrum,
  tolerance = 0.5,
): PredictedRunMatch {
  if (run.scanCount === 0) {
    return { accepted: false, best: null, candidates: [], reason: "The file has no MS scans." };
  }

  const diagnostic = selectDiagnosticIons(predicted, run.mzRange);
  const predictedMax =
    predicted.mz.length > 0 ? predicted.mz[predicted.mz.length - 1] : NaN;
  const acquisitionExcludesMolecularRegion =
    Number.isFinite(predictedMax) && predictedMax > run.mzRange[1] + tolerance;
  if (diagnostic.length < 2) {
    return {
      accepted: false,
      best: null,
      candidates: [],
      reason: acquisitionExcludesMolecularRegion
        ? `Too few predicted ions fall inside the acquired m/z ${run.mzRange[0].toFixed(0)}–${run.mzRange[1].toFixed(0)} range.`
        : "The prediction does not contain enough diagnostic ions to search reliably.",
    };
  }

  const totalWeight = diagnostic.reduce((sum, ion) => sum + ion.weight, 0);
  const scored: Array<PredictedScanCandidate & { rank: number }> = [];
  for (let scanIndex = 0; scanIndex < run.scanCount; scanIndex += 1) {
    let matchedIons = 0;
    let matchedWeight = 0;
    for (const ion of diagnostic) {
      // Ignore trace-level noise: a predicted ion must reach at least 2% of
      // the measured scan's base peak to count as independent evidence.
      if (scanIonRelativeIntensity(run, scanIndex, ion.mz, tolerance) >= 2) {
        matchedIons += 1;
        matchedWeight += ion.weight;
      }
    }
    const coverage = totalWeight > 0 ? matchedWeight / totalWeight : 0;
    const score = spectrumSimilarity(predicted, scanSpectrum(run, scanIndex), tolerance);
    const rank =
      score * 0.55 +
      coverage * 0.35 +
      (matchedIons / diagnostic.length) * 0.1;
    scored.push({
      rtMin: run.rtMin[scanIndex],
      score,
      matchedIons,
      diagnosticIons: diagnostic.length,
      coverage,
      rank,
    });
  }
  scored.sort((a, b) => b.rank - a.rank || b.score - a.score);

  // Consecutive scans from one chromatographic feature are one result, not
  // several apparently independent matches.
  const distinct: PredictedScanCandidate[] = [];
  for (const candidate of scored) {
    if (distinct.some((other) => Math.abs(other.rtMin - candidate.rtMin) < 0.08)) continue;
    const { rank: _rank, ...publicCandidate } = candidate;
    distinct.push(publicCandidate);
    if (distinct.length >= 3) break;
  }
  const best = distinct[0] ?? null;
  if (!best) {
    return { accepted: false, best: null, candidates: [], reason: "No usable scan was found." };
  }

  const requiredIons = Math.min(5, Math.max(3, Math.ceil(diagnostic.length * 0.5)));
  const accepted =
    !acquisitionExcludesMolecularRegion &&
    best.score >= 0.45 &&
    best.matchedIons >= requiredIons &&
    best.coverage >= 0.55;
  const reason = accepted
    ? "Multiple diagnostic ions support this candidate."
    : acquisitionExcludesMolecularRegion
      ? `No confident identification is possible because the prediction extends beyond the acquired m/z ${run.mzRange[0].toFixed(0)}–${run.mzRange[1].toFixed(0)} range.`
      : `No confident match: the best scan needs ≥45% similarity, ≥${requiredIons} diagnostic ions, and ≥55% predicted-ion coverage.`;

  return { accepted, best, candidates: distinct, reason };
}
