// Export & project I/O for the MALDI workspace.
//
// Everything stays client-side: CSV/JSON files are built in memory and offered as
// downloads; the PDF/Excel report reuses the jsPDF + ExcelJS patterns from the
// kinetics workspace. The full-project JSON round-trips through IndexedDB —
// Float64Array spectra are converted to plain number[] for JSON and reconstructed
// on import, so a saved project reproduces the exact view on another machine.

import ExcelJS from "exceljs";
import { jsPDF } from "jspdf";
import { adductById, neutralMass } from "./adducts";
import type { EndGroupCandidate } from "./endgroups";
import type { Finding } from "./interpret";
import type { MolWeightStats } from "./molweight";
import type {
  Adduct,
  Peak,
  ProjectRecord,
  ProjectState,
  Series,
  SpectrumData,
} from "./types";

// --- download plumbing -------------------------------------------------------

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function safeName(name: string): string {
  return (name || "maldi").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "maldi";
}

function formatEquation(slope: number, intercept: number): string {
  const slopeStr = slope.toFixed(4);
  if (Math.abs(intercept) < 1e-6) return `y = ${slopeStr}·n`;
  const sign = intercept < 0 ? "-" : "+";
  return `y = ${slopeStr}·n ${sign} ${Math.abs(intercept).toFixed(4)}`;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function downloadText(text: string, filename: string, mime = "text/plain"): void {
  triggerDownload(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}

function csvCell(value: string | number | undefined | null): string {
  if (value == null) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: (string | number | undefined | null)[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

// --- CSV exports -------------------------------------------------------------

/** Export the peak table as CSV (every column the table shows). */
export function exportPeaksCsv(peaks: Peak[], baseName: string): void {
  const header = [
    "mz", "centroid", "intensity", "snr", "width", "confidence", "accepted", "locked", "ignored", "flag", "label",
  ];
  const rows: (string | number | undefined)[][] = [header];
  for (const p of [...peaks].sort((a, b) => (a.centroid ?? a.mz) - (b.centroid ?? b.mz))) {
    rows.push([
      (p.centroid ?? p.mz).toFixed(5),
      p.centroid != null ? p.centroid.toFixed(5) : "",
      p.intensity,
      p.snr != null ? p.snr.toFixed(2) : "",
      p.width != null ? p.width.toFixed(4) : "",
      p.confidence != null ? p.confidence.toFixed(3) : "",
      p.accepted === false ? "no" : "yes",
      p.locked ? "yes" : "",
      p.ignored ? "yes" : "",
      p.flag ?? "",
      p.label ?? "",
    ]);
  }
  downloadText(toCsv(rows), `${safeName(baseName)}-peaks-${timestampSlug()}.csv`, "text/csv");
}

/** Export a spectrum (raw or processed) as a two-column CSV. */
export function exportSpectrumCsv(spectrum: SpectrumData, baseName: string, label: string): void {
  const rows: (string | number)[][] = [["mz", "intensity"]];
  for (let i = 0; i < spectrum.mz.length; i += 1) {
    rows.push([spectrum.mz[i], spectrum.intensity[i]]);
  }
  downloadText(toCsv(rows), `${safeName(baseName)}-${label}-${timestampSlug()}.csv`, "text/csv");
}

/** Export the assigned series (one row per member peak) as CSV. */
export function exportSeriesCsv(series: Series[], adducts: Adduct[], baseName: string): void {
  const header = ["seriesId", "adduct", "label", "description", "endGroupLabel", "repeatMass", "endGroupMass", "score", "meanErrorDa", "n", "peakId"];
  const rows: (string | number | undefined)[][] = [header];
  for (const s of series) {
    const adduct = adductById(adducts, s.adductId).label;
    for (const m of s.members) {
      rows.push([
        s.id, adduct, s.label ?? "", s.description ?? "", s.endGroupLabel ?? "",
        s.repeatMass.toFixed(4), s.endGroupMass.toFixed(4),
        s.score, s.meanErrorDa?.toFixed(4) ?? "", m.n, m.peakId,
      ]);
    }
  }
  downloadText(toCsv(rows), `${safeName(baseName)}-series-${timestampSlug()}.csv`, "text/csv");
}

// --- Full-project JSON (also the import format) ------------------------------

interface SerializableSpectrum {
  mz: number[];
  intensity: number[];
}

interface SerializableProject {
  format: "maldi-project";
  version: 1;
  record: {
    id: string;
    name: string;
    createdAt: number;
    updatedAt: number;
    state: Omit<ProjectState, "rawSpectrum" | "processedSpectrum"> & {
      rawSpectrum: SerializableSpectrum | null;
      processedSpectrum: SerializableSpectrum | null;
    };
  };
}

function serializeSpectrum(s: SpectrumData | null): SerializableSpectrum | null {
  if (!s) return null;
  return { mz: Array.from(s.mz), intensity: Array.from(s.intensity) };
}

function deserializeSpectrum(s: SerializableSpectrum | null): SpectrumData | null {
  if (!s) return null;
  return { mz: Float64Array.from(s.mz), intensity: Float64Array.from(s.intensity) };
}

/** Serialize a project record to a portable JSON string. */
export function serializeProject(record: ProjectRecord): string {
  const payload: SerializableProject = {
    format: "maldi-project",
    version: 1,
    record: {
      id: record.id,
      name: record.name,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      state: {
        ...record.state,
        rawSpectrum: serializeSpectrum(record.state.rawSpectrum),
        processedSpectrum: serializeSpectrum(record.state.processedSpectrum),
      },
    },
  };
  return JSON.stringify(payload, null, 2);
}

/** Parse a project JSON string back into a record (Float64Arrays restored). */
export function deserializeProject(text: string): ProjectRecord {
  const parsed = JSON.parse(text) as Partial<SerializableProject>;
  if (parsed.format !== "maldi-project" || !parsed.record) {
    throw new Error("Not a MALDI project file.");
  }
  const r = parsed.record;
  return {
    id: r.id,
    name: r.name,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    state: {
      ...r.state,
      rawSpectrum: deserializeSpectrum(r.state.rawSpectrum),
      processedSpectrum: deserializeSpectrum(r.state.processedSpectrum),
    },
  };
}

/** Download the full project as JSON. */
export function exportProjectJson(record: ProjectRecord): void {
  downloadText(serializeProject(record), `${safeName(record.name)}-${timestampSlug()}.maldi.json`, "application/json");
}

// --- Report (PDF + Excel) ----------------------------------------------------

export interface ReportPayload {
  projectName: string;
  sourceName: string;
  pointCount: number;
  peaks: Peak[];
  series: Series[];
  adducts: Adduct[];
  repeatMass?: number;
  molWeight?: MolWeightStats | null;
  endGroupCandidates?: EndGroupCandidate[];
  findings?: Finding[];
  /** PNG data URL of the on-screen spectrum, captured by the caller. */
  spectrumPng?: string | null;
  /** Ids of series currently selected/highlighted in the UI. Empty = export all. */
  selectedSeriesIds?: string[];
}

function topPeaks(peaks: Peak[], limit: number): Peak[] {
  return [...peaks]
    .filter((p) => p.accepted !== false && !p.ignored)
    .sort((a, b) => b.intensity - a.intensity)
    .slice(0, limit)
    .sort((a, b) => (a.centroid ?? a.mz) - (b.centroid ?? b.mz));
}

// --- End-group regression (mass vs oligomer number) --------------------------

/** A least-squares fit of neutral mass against oligomer number n for one end
 *  group: slope ≈ the repeat unit, intercept ≈ the end-group neutral mass, and R²
 *  measures how cleanly the ladder obeys mass = endGroup + n·repeat. */
export interface EndGroupFit {
  /** Adduct label, e.g. "[M+Na]+". */
  adductLabel: string;
  /** Residual end-group mass (mod repeat) the candidate was clustered on. */
  residualMass: number;
  /** Nearest library end group, if any. */
  libraryMatch?: string;
  /** Fitted slope — the apparent repeat-unit mass (Da). */
  repeatFit: number;
  /** Fitted intercept — the apparent end-group neutral mass (Da). */
  endGroupFit: number;
  /** Coefficient of determination, 0..1. */
  r2: number;
  /** The per-oligomer points used in the fit. */
  points: { n: number; mass: number; predicted: number }[];
}

/** Ordinary least squares of y on x, plus R². */
function linearFit(xs: number[], ys: number[]): { slope: number; intercept: number; r2: number } {
  const n = xs.length;
  const xbar = xs.reduce((a, b) => a + b, 0) / n;
  const ybar = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - xbar;
    const dy = ys[i] - ybar;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = ybar - slope * xbar;
  let ssRes = 0;
  for (let i = 0; i < n; i += 1) {
    const pred = intercept + slope * xs[i];
    ssRes += (ys[i] - pred) ** 2;
  }
  const r2 = syy > 0 ? Math.max(0, 1 - ssRes / syy) : 1;
  return { slope, intercept, r2 };
}

/**
 * Build a mass-vs-n regression for each end group in the report. Prefers the
 * solved end-group candidates (each is one end group); if none were solved, falls
 * back to the assigned series (each carries its own end group + adduct). Returns
 * fits best-first, skipping any with fewer than three points.
 */
export function collectEndGroupFits(payload: ReportPayload): EndGroupFit[] {
  const sources: { adductId: string; residualMass: number; libraryMatch?: string; members: { peakId: string; n: number }[] }[] =
    payload.endGroupCandidates && payload.endGroupCandidates.length
      ? payload.endGroupCandidates.map((c) => ({
          adductId: c.adductId,
          residualMass: c.residualMass,
          libraryMatch: c.libraryMatch,
          members: c.members ?? [],
        }))
      : payload.series.map((s) => ({
          adductId: s.adductId,
          residualMass: s.endGroupMass,
          members: s.members,
        }));

  const peakById = new Map(payload.peaks.map((p) => [p.id, p] as const));
  const fits: EndGroupFit[] = [];
  for (const src of sources) {
    const adduct = adductById(payload.adducts, src.adductId);
    const xs: number[] = [];
    const ys: number[] = [];
    for (const m of src.members) {
      const peak = peakById.get(m.peakId);
      if (!peak) continue;
      xs.push(m.n);
      ys.push(neutralMass(peak.centroid ?? peak.mz, adduct));
    }
    if (xs.length < 3 || new Set(xs).size < 2) continue;
    const { slope, intercept, r2 } = linearFit(xs, ys);
    const points = xs
      .map((n, i) => ({ n, mass: ys[i], predicted: intercept + slope * n }))
      .sort((a, b) => a.n - b.n);
    fits.push({
      adductLabel: adduct.label,
      residualMass: src.residualMass,
      libraryMatch: src.libraryMatch,
      repeatFit: slope,
      endGroupFit: intercept,
      r2,
      points,
    });
  }
  // Best-fitting (highest R², then most points) first.
  fits.sort((a, b) => b.r2 - a.r2 || b.points.length - a.points.length);
  return fits;
}

/** Draw one mass-vs-n scatter + fit line with its R² into the PDF. */
function drawRegressionChart(
  doc: jsPDF,
  x0: number,
  y0: number,
  w: number,
  fit: EndGroupFit,
): void {
  const titleH = 12;
  const chartH = 104;
  const pad = 6;
  // Title.
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(0);
  const lib = fit.libraryMatch ? ` (${fit.libraryMatch})` : "";
  doc.text(`${fit.adductLabel} · end ${fit.residualMass.toFixed(2)} Da${lib}`.slice(0, 64), x0, y0 + 9);

  const bx = x0;
  const by = y0 + titleH;
  const bw = w;
  const bh = chartH;
  doc.setDrawColor(205);
  doc.setLineWidth(0.5);
  doc.rect(bx, by, bw, bh);

  const ns = fit.points.map((p) => p.n);
  const ms = fit.points.map((p) => p.mass);
  const xMin = Math.min(...ns);
  let xMax = Math.max(...ns);
  const yMin = Math.min(...ms);
  let yMax = Math.max(...ms);
  if (xMax === xMin) xMax = xMin + 1;
  if (yMax === yMin) yMax = yMin + 1;
  const px = (n: number) => bx + pad + ((n - xMin) / (xMax - xMin)) * (bw - 2 * pad);
  const py = (m: number) => by + bh - pad - ((m - yMin) / (yMax - yMin)) * (bh - 2 * pad);

  // Fit line across the n-range.
  doc.setDrawColor(14, 165, 233);
  doc.setLineWidth(1);
  doc.line(px(xMin), py(fit.endGroupFit + fit.repeatFit * xMin), px(xMax), py(fit.endGroupFit + fit.repeatFit * xMax));

  // Data points.
  doc.setFillColor(217, 70, 239);
  for (const p of fit.points) doc.circle(px(p.n), py(p.mass), 1.4, "F");

  // Stats line under the chart.
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(90);
  doc.text(
    `repeat ${fit.repeatFit.toFixed(3)} Da · end group ${fit.endGroupFit.toFixed(2)} Da · R² ${fit.r2.toFixed(4)} · ${fit.points.length} pts`,
    bx,
    by + bh + 10,
  );
  doc.setTextColor(0);
}

/** Generate a publication-style PDF report of the current analysis. */
export function exportReportPdf(payload: ReportPayload): void {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 40;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  const ensureSpace = (needed: number) => {
    if (y + needed > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
  };

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("MALDI Interpretation Report", margin, y);
  y += 20;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(110);
  doc.text(
    `${payload.projectName}   •   source: ${payload.sourceName || "—"}   •   ${payload.pointCount.toLocaleString()} points   •   ${new Date().toLocaleString()}`,
    margin,
    y,
  );
  doc.setTextColor(0);
  y += 22;

  // Spectrum image.
  if (payload.spectrumPng) {
    const imgWidth = contentWidth;
    const imgHeight = imgWidth * 0.42;
    ensureSpace(imgHeight + 16);
    doc.addImage(payload.spectrumPng, "PNG", margin, y, imgWidth, imgHeight);
    y += imgHeight + 16;
  }

  // Findings.
  if (payload.findings && payload.findings.length) {
    ensureSpace(40);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("Interpretation", margin, y);
    y += 14;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    for (const f of payload.findings) {
      const lines = doc.splitTextToSize(`• ${f.text}`, contentWidth);
      ensureSpace(lines.length * 12 + 2);
      doc.text(lines, margin, y);
      y += lines.length * 12 + 2;
    }
    y += 8;
  }

  // Molecular weight.
  if (payload.molWeight && payload.molWeight.count > 0) {
    const mw = payload.molWeight;
    ensureSpace(60);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("MALDI-apparent molecular weight", margin, y);
    y += 14;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    const dp = mw.dpn != null ? `   DPn = ${mw.dpn.toFixed(1)}   DPw = ${mw.dpw?.toFixed(1)}` : "";
    doc.text(
      `Mn = ${mw.mn.toFixed(1)}   Mw = ${mw.mw.toFixed(1)}   Mz = ${mw.mz.toFixed(1)}   Đ = ${mw.dispersity.toFixed(3)}${dp}`,
      margin,
      y,
    );
    y += 12;
    doc.setTextColor(140);
    doc.text(`(${mw.massBasis} basis, ${mw.count} peaks — intensities are not quantitative)`, margin, y);
    doc.setTextColor(0);
    y += 18;
  }

  // Series.
  if (payload.series.length) {
    ensureSpace(40);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("Assigned series", margin, y);
    y += 14;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    for (const s of [...payload.series].sort((a, b) => b.score - a.score).slice(0, 10)) {
      ensureSpace(12);
      const nameTag = s.label ? `${s.label}  \u00b7  ` : "";
      doc.text(
        `${nameTag}${adductById(payload.adducts, s.adductId).label}  repeat ${s.repeatMass.toFixed(2)} Da  end ${s.endGroupMass.toFixed(2)} Da${s.endGroupLabel ? ` (${s.endGroupLabel})` : ""}  ${s.members.length} peaks  err ${(s.meanErrorDa ?? 0).toFixed(3)}  score ${Math.round(s.score * 100)}%`,
        margin + 8,
        y,
      );
      y += 12;
      if (s.description) {
        ensureSpace(10);
        const lines = doc.splitTextToSize(s.description, contentWidth - 16);
        for (const line of lines.slice(0, 2)) {
          doc.text(line, margin + 16, y);
          y += 10;
        }
      }
    }
    y += 8;
  }

  // End-group regression (mass = end group + n × repeat), with R² per end group.
  const egFits = collectEndGroupFits(payload).slice(0, 6);
  if (egFits.length) {
    ensureSpace(40);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(0);
    doc.text("End-group regression", margin, y);
    y += 12;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text("neutral mass = end group + n × repeat unit; R² gauges how cleanly each ladder fits", margin, y);
    doc.setTextColor(0);
    y += 14;

    const gap = 18;
    const cellW = (contentWidth - gap) / 2;
    const rowH = 12 + 104 + 18; // title + chart + stats/padding
    for (let i = 0; i < egFits.length; i += 2) {
      ensureSpace(rowH);
      const rowY = y;
      drawRegressionChart(doc, margin, rowY, cellW, egFits[i]);
      if (egFits[i + 1]) drawRegressionChart(doc, margin + cellW + gap, rowY, cellW, egFits[i + 1]);
      y = rowY + rowH;
    }
    y += 4;
  }

  // Peak table (top by intensity).
  const peaks = topPeaks(payload.peaks, 40);
  if (peaks.length) {
    ensureSpace(30);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text(`Peaks (top ${peaks.length} by intensity)`, margin, y);
    y += 14;
    doc.setFontSize(8);
    doc.text("m/z", margin, y);
    doc.text("intensity", margin + 90, y);
    doc.text("S/N", margin + 170, y);
    doc.text("flag/label", margin + 220, y);
    y += 11;
    doc.setFont("helvetica", "normal");
    for (const p of peaks) {
      ensureSpace(11);
      doc.text((p.centroid ?? p.mz).toFixed(4), margin, y);
      doc.text(p.intensity.toFixed(0), margin + 90, y);
      doc.text(p.snr != null ? p.snr.toFixed(1) : "—", margin + 170, y);
      doc.text((p.flag ?? p.label ?? "").slice(0, 60), margin + 220, y);
      y += 11;
    }
  }

  doc.save(`${safeName(payload.projectName)}-report-${timestampSlug()}.pdf`);
}

/** Generate a multi-sheet Excel workbook of the analysis. */
export async function exportReportExcel(payload: ReportPayload): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NMR Predict — MALDI";
  wb.created = new Date();

  // Summary.
  const summary = wb.addWorksheet("Summary");
  summary.addRow(["Project", payload.projectName]);
  summary.addRow(["Source", payload.sourceName]);
  summary.addRow(["Points", payload.pointCount]);
  summary.addRow(["Peaks", payload.peaks.length]);
  summary.addRow(["Repeat unit (Da)", payload.repeatMass ?? ""]);
  summary.addRow([]);
  if (payload.molWeight && payload.molWeight.count > 0) {
    const mw = payload.molWeight;
    summary.addRow(["MALDI-apparent molecular weight", `(${mw.massBasis} basis)`]);
    summary.addRow(["Mn", mw.mn]);
    summary.addRow(["Mw", mw.mw]);
    summary.addRow(["Mz", mw.mz]);
    summary.addRow(["Đ (dispersity)", mw.dispersity]);
    if (mw.dpn != null) {
      summary.addRow(["DPn", mw.dpn]);
      summary.addRow(["DPw", mw.dpw ?? ""]);
    }
    summary.addRow([]);
  }
  if (payload.findings?.length) {
    summary.addRow(["Interpretation"]);
    for (const f of payload.findings) summary.addRow(["", f.text]);
  }
  summary.getColumn(1).width = 32;
  summary.getColumn(2).width = 80;

  // Series (consolidated sheet: raw peaks at the top, then one block per
  // selected series with live formulas for n, predicted, end group and R²).
  const selectedIds = payload.selectedSeriesIds ?? [];
  const seriesToExport = selectedIds.length ? payload.series.filter((s) => selectedIds.includes(s.id)) : payload.series;
  const ws = wb.addWorksheet("Series");
  const colWidths = [8, 14, 14, 14, 14, 14, 14];
  ws.columns.forEach((c, i) => {
    if (i < colWidths.length) c.width = colWidths[i];
  });

  ws.getCell("A1").value = "Raw peaks";
  ws.getCell("A1").font = { bold: true };
  ws.mergeCells("A1:H1");
  const peakHeaderRow = 2;
  ws.getCell(`A${peakHeaderRow}`).value = "m/z";
  ws.getCell(`B${peakHeaderRow}`).value = "intensity";
  ws.getCell(`C${peakHeaderRow}`).value = "S/N";
  ws.getCell(`D${peakHeaderRow}`).value = "width";
  ws.getCell(`E${peakHeaderRow}`).value = "confidence";
  ws.getCell(`F${peakHeaderRow}`).value = "accepted";
  ws.getCell(`G${peakHeaderRow}`).value = "flag";
  ws.getCell(`H${peakHeaderRow}`).value = "label";
  for (let c = 1; c <= 8; c += 1) ws.getCell(peakHeaderRow, c).font = { bold: true };
  const sortedPeaks = [...payload.peaks].sort((a, b) => (a.centroid ?? a.mz) - (b.centroid ?? b.mz));
  for (let i = 0; i < sortedPeaks.length; i += 1) {
    const p = sortedPeaks[i];
    const r = peakHeaderRow + 1 + i;
    ws.getCell(`A${r}`).value = p.centroid ?? p.mz;
    ws.getCell(`A${r}`).numFmt = "0.0000";
    ws.getCell(`B${r}`).value = p.intensity;
    ws.getCell(`C${r}`).value = p.snr ?? "";
    ws.getCell(`D${r}`).value = p.width ?? "";
    ws.getCell(`E${r}`).value = p.confidence ?? "";
    ws.getCell(`F${r}`).value = p.accepted === false ? "no" : "yes";
    ws.getCell(`G${r}`).value = p.flag ?? "";
    ws.getCell(`H${r}`).value = p.label ?? "";
  }
  ws.getColumn(8).width = 28;
  let row = peakHeaderRow + 1 + sortedPeaks.length + 2;

  if (seriesToExport.length) {
    const peakById = new Map(payload.peaks.map((p) => [p.id, p] as const));

    ws.getCell(`A${row}`).value = "Series";
    ws.getCell(`A${row}`).font = { bold: true };
    ws.mergeCells(`A${row}:G${row}`);
    row += 2;

    for (let seriesIndex = 0; seriesIndex < seriesToExport.length; seriesIndex += 1) {
      const s = seriesToExport[seriesIndex];
      const adduct = adductById(payload.adducts, s.adductId);
      const members = [...s.members].sort((a, b) => a.n - b.n);
      const xs: number[] = [];
      const ys: number[] = [];
      const points: { peak: Peak; n: number; rawMz: number; neutral: number }[] = [];
      for (const m of members) {
        const peak = peakById.get(m.peakId);
        if (!peak) continue;
        const rawMz = peak.centroid ?? peak.mz;
        const neutral = neutralMass(rawMz, adduct);
        xs.push(m.n);
        ys.push(neutral);
        points.push({ peak, n: m.n, rawMz, neutral });
      }
      if (points.length < 2) continue;

      const { slope, intercept, r2 } = linearFit(xs, ys);
      const firstNRow = row + 5;
      const lastNRow = firstNRow + points.length - 1;
      const nCol = "A";
      const rawCol = "B";
      const neutralCol = "D";
      const predictedCol = "E";
      const residualCol = "F";
      const nRange = `${nCol}${firstNRow}:${nCol}${lastNRow}`;
      const neutralRange = `${neutralCol}${firstNRow}:${neutralCol}${lastNRow}`;
      const slopeCell = `B${row + 1}`;
      const interceptCell = `D${row + 1}`;

      ws.getCell(`A${row}`).value = `Series ${seriesIndex + 1}`;
      ws.getCell(`A${row}`).font = { bold: true };
      ws.mergeCells(`A${row}:G${row}`);
      row += 1;

      const endGroupLabel = s.endGroupLabel ? ` (${s.endGroupLabel})` : "";
      ws.getCell(`A${row}`).value = `Adduct: ${adduct.id} (${adduct.label})`;
      ws.getCell(`B${row}`).value = "Slope =";
      ws.getCell(`C${row}`).value = { formula: `SLOPE(${neutralRange},${nRange})` };
      ws.getCell(`C${row}`).numFmt = "0.0000";
      ws.getCell(`D${row}`).value = "Intercept =";
      ws.getCell(`E${row}`).value = { formula: `INTERCEPT(${neutralRange},${nRange})` };
      ws.getCell(`E${row}`).numFmt = "0.0000\" Da\"";
      ws.getCell(`F${row}`).value = "R² =";
      ws.getCell(`G${row}`).value = { formula: `RSQ(${neutralRange},${nRange})` };
      ws.getCell(`G${row}`).numFmt = "0.0000";
      row += 1;

      ws.getCell(`A${row}`).value = `Repeat: ${s.repeatMass.toFixed(2)} Da`;
      ws.getCell(`B${row}`).value = `End group: ${s.endGroupMass.toFixed(2)} Da${endGroupLabel}`;
      ws.mergeCells(`B${row}:G${row}`);
      row += 1;

      ws.getCell(`A${row}`).value = `Equation: ${formatEquation(slope, intercept)}`;
      ws.mergeCells(`A${row}:G${row}`);
      row += 1;

      ws.getCell(`A${row}`).value = "(Edit the top n cell — the n column, predicted, residual, slope, intercept and R² all recalculate.)";
      ws.mergeCells(`A${row}:G${row}`);
      ws.getCell(`A${row}`).font = { italic: true };
      row += 1;

      ws.getCell(`A${row}`).value = "n";
      ws.getCell(`B${row}`).value = "m/z (raw)";
      ws.getCell(`C${row}`).value = "intensity";
      ws.getCell(`D${row}`).value = "neutral mass";
      ws.getCell(`E${row}`).value = "predicted";
      ws.getCell(`F${row}`).value = "residual";
      ws.getCell(`G${row}`).value = "fit line";
      for (let c = 1; c <= 7; c += 1) ws.getCell(row, c).font = { bold: true };
      row += 1;

      for (let i = 0; i < points.length; i += 1) {
        const pt = points[i];
        const currentRow = row + i;
        const nCell = `${nCol}${currentRow}`;
        const neutralCell = `${neutralCol}${currentRow}`;
        const predictedCell = `${predictedCol}${currentRow}`;

        ws.getCell(`A${currentRow}`).value = i === 0 ? pt.n : { formula: `=${nCol}${currentRow - 1}+1` };
        ws.getCell(`B${currentRow}`).value = pt.rawMz;
        ws.getCell(`B${currentRow}`).numFmt = "0.0000";
        ws.getCell(`C${currentRow}`).value = pt.peak.intensity;
        ws.getCell(`D${currentRow}`).value = pt.neutral;
        ws.getCell(`D${currentRow}`).numFmt = "0.0000";
        ws.getCell(`E${currentRow}`).value = { formula: `=${slopeCell}*${nCell}+${interceptCell}` };
        ws.getCell(`E${currentRow}`).numFmt = "0.0000";
        ws.getCell(`F${currentRow}`).value = { formula: `=${neutralCell}-${predictedCell}` };
        ws.getCell(`F${currentRow}`).numFmt = "0.0000";
        ws.getCell(`G${currentRow}`).value = { formula: `=${slopeCell}*${nCell}+${interceptCell}` };
        ws.getCell(`G${currentRow}`).numFmt = "0.0000";
      }
      row += points.length;

      ws.getCell(`A${row}`).value = "Select the n and neutral mass columns, insert an Excel scatter chart, and add a linear trendline.";
      ws.mergeCells(`A${row}:G${row}`);
      row += 1;
      row += 1;
    }
  }

  // Spectrum image.
  if (payload.spectrumPng) {
    const chart = wb.addWorksheet("Spectrum");
    const imageId = wb.addImage({ base64: payload.spectrumPng.replace(/^data:image\/png;base64,/, ""), extension: "png" });
    chart.addImage(imageId, { tl: { col: 0, row: 0 }, ext: { width: 900, height: 380 } });
  }

  const buffer = await wb.xlsx.writeBuffer();
  triggerDownload(
    new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    `${safeName(payload.projectName)}-report-${timestampSlug()}.xlsx`,
  );
}
