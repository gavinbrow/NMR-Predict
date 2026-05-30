// Export & project I/O for the MALDI workspace.
//
// Everything stays client-side: CSV/JSON files are built in memory and offered as
// downloads; the PDF/Excel report reuses the jsPDF + ExcelJS patterns from the
// kinetics workspace. The full-project JSON round-trips through IndexedDB —
// Float64Array spectra are converted to plain number[] for JSON and reconstructed
// on import, so a saved project reproduces the exact view on another machine.

import ExcelJS from "exceljs";
import { jsPDF } from "jspdf";
import { adductById } from "./adducts";
import type { EndGroupCandidate } from "./endgroups";
import type { Finding } from "./interpret";
import type { LossEvent } from "./losses";
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
  const header = ["seriesId", "adduct", "repeatMass", "endGroupMass", "score", "meanErrorDa", "n", "peakId"];
  const rows: (string | number | undefined)[][] = [header];
  for (const s of series) {
    const adduct = adductById(adducts, s.adductId).label;
    for (const m of s.members) {
      rows.push([
        s.id, adduct, s.repeatMass.toFixed(4), s.endGroupMass.toFixed(4),
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
  losses?: LossEvent[];
  findings?: Finding[];
  /** PNG data URL of the on-screen spectrum, captured by the caller. */
  spectrumPng?: string | null;
}

function topPeaks(peaks: Peak[], limit: number): Peak[] {
  return [...peaks]
    .filter((p) => p.accepted !== false && !p.ignored)
    .sort((a, b) => b.intensity - a.intensity)
    .slice(0, limit)
    .sort((a, b) => (a.centroid ?? a.mz) - (b.centroid ?? b.mz));
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
      doc.text(
        `${adductById(payload.adducts, s.adductId).label}  repeat ${s.repeatMass.toFixed(2)} Da  end ${s.endGroupMass.toFixed(2)} Da  ${s.members.length} peaks  err ${(s.meanErrorDa ?? 0).toFixed(3)}  score ${Math.round(s.score * 100)}%`,
        margin + 8,
        y,
      );
      y += 12;
    }
    y += 8;
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

  // Peaks.
  const peakSheet = wb.addWorksheet("Peaks");
  peakSheet.addRow(["m/z", "intensity", "S/N", "width", "confidence", "accepted", "flag", "label"]).font = { bold: true };
  for (const p of [...payload.peaks].sort((a, b) => (a.centroid ?? a.mz) - (b.centroid ?? b.mz))) {
    peakSheet.addRow([
      p.centroid ?? p.mz,
      p.intensity,
      p.snr ?? "",
      p.width ?? "",
      p.confidence ?? "",
      p.accepted === false ? "no" : "yes",
      p.flag ?? "",
      p.label ?? "",
    ]);
  }
  peakSheet.columns.forEach((c) => (c.width = 14));

  // Series.
  if (payload.series.length) {
    const seriesSheet = wb.addWorksheet("Series");
    seriesSheet.addRow(["adduct", "repeatMass", "endGroupMass", "members", "meanErrorDa", "score", "n", "peakId"]).font = { bold: true };
    for (const s of payload.series) {
      const adduct = adductById(payload.adducts, s.adductId).label;
      for (const m of s.members) {
        seriesSheet.addRow([adduct, s.repeatMass, s.endGroupMass, s.members.length, s.meanErrorDa ?? "", s.score, m.n, m.peakId]);
      }
    }
    seriesSheet.columns.forEach((c) => (c.width = 14));
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
