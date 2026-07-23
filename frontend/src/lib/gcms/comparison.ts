import { spectrumSimilarity } from "./peaks";
import type { ComparisonSpectrumItem, MassSpectrum } from "./types";

export type ComparisonLayout = "separate" | "overlay" | "stacked";

export interface ComparisonSimilarity {
  aId: string;
  bId: string;
  score: number;
}

export function comparisonSpectrumLabel(documentName: string, spectrum: MassSpectrum): string {
  const range =
    Math.abs(spectrum.rtHi - spectrum.rtLo) < 0.0005
      ? `${spectrum.rtLo.toFixed(3)} min`
      : `${spectrum.rtLo.toFixed(2)}–${spectrum.rtHi.toFixed(2)} min`;
  return `${documentName} — ${range}`;
}

export function comparisonFingerprint(
  documentId: string,
  spectrum: MassSpectrum,
): string {
  return [
    documentId,
    spectrum.rtLo.toFixed(6),
    spectrum.rtHi.toFixed(6),
    spectrum.scanCount,
  ].join(":");
}

export function comparisonXDomain(
  items: ComparisonSpectrumItem[],
): [number, number] | undefined {
  let lo = Infinity;
  let hi = -Infinity;
  for (const item of items) {
    const mz = item.spectrum.mz;
    if (mz.length === 0) continue;
    const a = mz[0];
    const b = mz[mz.length - 1];
    if (Number.isFinite(a) && a < lo) lo = a;
    if (Number.isFinite(b) && b > hi) hi = b;
  }
  return Number.isFinite(lo) && Number.isFinite(hi) && lo < hi ? [lo, hi] : undefined;
}

export function comparisonSimilarities(
  items: ComparisonSpectrumItem[],
  binTolerance: number,
): ComparisonSimilarity[] {
  const out: ComparisonSimilarity[] = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      out.push({
        aId: items[i].id,
        bId: items[j].id,
        score: spectrumSimilarity(items[i].spectrum, items[j].spectrum, binTolerance),
      });
    }
  }
  return out;
}

export function normalizeComparisonSpectrum(spectrum: MassSpectrum): MassSpectrum {
  let max = 0;
  for (let i = 0; i < spectrum.intensity.length; i += 1) {
    const value = spectrum.intensity[i];
    if (Number.isFinite(value) && value > max) max = value;
  }
  if (!(max > 0)) return spectrum;
  const intensity = new Float64Array(spectrum.intensity.length);
  for (let i = 0; i < intensity.length; i += 1) {
    intensity[i] = (spectrum.intensity[i] / max) * 100;
  }
  return {
    ...spectrum,
    intensity,
    basePeak: spectrum.basePeak
      ? { mz: spectrum.basePeak.mz, intensity: 100 }
      : null,
  };
}
