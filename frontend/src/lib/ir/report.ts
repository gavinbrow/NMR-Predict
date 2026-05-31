// Kinetics exports (§9) — CSV, PDF, and Excel of a completed kinetics run.
//
// All three consume a `KineticsReport` (see types.ts). The output data table is
// `time_{unit}, signal_{unit}, conversion_pct`, plus `raw_{mode}_{center}` and
// `ref_{rmode}_{rcenter}` when a reference peak was used. The PDF (jsPDF) embeds
// the two rendered chart PNGs grabbed from the live uPlot canvases; the Excel
// workbook (ExcelJS) carries the data + fit blocks and the same chart images.
//
// Everything stays client-side and is cached by content so repeated downloads of
// an unchanged run don't rebuild the bytes. Caches are invalidated by the caller
// (a fresh run produces a new signature → new cache key).

import ExcelJS from "exceljs";
import { jsPDF } from "jspdf";
import type { KineticsReport, PeakConfig } from "./types";

// --- download plumbing -------------------------------------------------------

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

/** %g-style formatting: `sig` significant figures, trailing zeros trimmed. */
function g(x: number, sig = 4): string {
  if (!Number.isFinite(x)) return "—";
  if (x === 0) return "0";
  return Number(x.toPrecision(sig)).toString();
}

function pct1(fraction: number): string {
  return Number.isFinite(fraction) ? `${(fraction * 100).toFixed(1)}%` : "—";
}

// --- output table ------------------------------------------------------------

interface ReportTable {
  headers: string[];
  /** Row-major numeric data, aligned to `headers`. NaN cells render blank. */
  rows: number[][];
}

function peakTag(prefix: string, peak: PeakConfig): string {
  return `${prefix}_${peak.measure}_${Math.round(peak.center)}`;
}

/** Build the wide output table for a run (the shared shape for CSV/Excel). */
export function buildReportTable(report: KineticsReport): ReportTable {
  const { result, timeUnit, signalUnit } = report;
  const headers = [`time_${timeUnit}`, `signal_${signalUnit}`, "conversion_pct"];
  if (report.useReference && report.refPeak) {
    headers.push(peakTag("raw", report.peak), peakTag("ref", report.refPeak));
  }
  const rows = result.time.map((t, i) => {
    const row = [t, result.signal[i], result.conversion[i] * 100];
    if (report.useReference && report.refPeak) {
      row.push(report.raw?.[i] ?? NaN, report.ref?.[i] ?? NaN);
    }
    return row;
  });
  return { headers, rows };
}

// --- CSV ---------------------------------------------------------------------

function csvCell(value: number): string {
  return Number.isFinite(value) ? String(value) : "";
}

function tableToCsv(table: ReportTable): string {
  const lines = [table.headers.join(",")];
  for (const row of table.rows) lines.push(row.map(csvCell).join(","));
  return lines.join("\r\n");
}

/** Download the run's data table as `kinetics.csv`. */
export function downloadKineticsCsv(report: KineticsReport, filename = "kinetics.csv"): void {
  triggerDownload(
    new Blob([tableToCsv(buildReportTable(report))], { type: "text/csv;charset=utf-8" }),
    filename,
  );
}

// --- shared summary ----------------------------------------------------------

/** The human-readable summary lines shared by the PDF and Excel summary block. */
export function summaryLines(report: KineticsReport): string[] {
  const { peak, refPeak, useReference, result, timeUnit, spectraCount } = report;
  const lines: string[] = [];
  lines.push(
    `Peak tracked: ${peak.center} cm-1 (±${peak.halfwidth}), ${peak.measure}, window baseline: ${peak.baseline}`,
  );
  if (useReference && refPeak) {
    lines.push(
      `Reference peak: ${refPeak.center} cm-1 (±${refPeak.halfwidth}), ${refPeak.measure} — signal = peak / reference`,
    );
  }
  lines.push(`Spectra in series: ${spectraCount}`);
  lines.push("");
  if (result.fitOk) {
    lines.push(`Rate constant k = ${g(result.k)} /${timeUnit}`);
    lines.push(`Half-life = ${g(result.halfLife)} ${timeUnit}`);
    lines.push(`Final conversion (fitted) = ${pct1(result.finalConversion)}`);
    lines.push(`R^2 = ${Number.isFinite(result.r2) ? result.r2.toFixed(4) : "—"}`);
  } else {
    const dataFinal = result.conversion.reduce((m, v) => (Number.isFinite(v) && v > m ? v : m), -Infinity);
    lines.push("First-order fit did not converge.");
    lines.push(`Final conversion (data) = ${pct1(Number.isFinite(dataFinal) ? dataFinal : NaN)}`);
  }
  return lines;
}

// --- PDF ---------------------------------------------------------------------

const pdfCache = new Map<string, Blob>();

/** Build (and cache) the kinetics PDF for a run. */
function buildPdf(report: KineticsReport): Blob {
  const doc = new jsPDF({ unit: "pt", format: "letter", orientation: "portrait" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 48;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("IR Kinetics Report", margin, y);
  y += 22;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(new Date().toLocaleString(), margin, y);
  doc.setTextColor(0);
  y += 20;

  // Monospace summary block.
  doc.setFont("courier", "normal");
  doc.setFontSize(10);
  for (const line of summaryLines(report)) {
    doc.text(line || " ", margin, y);
    y += 14;
  }
  y += 8;

  // Two stacked chart images.
  const imgWidth = contentWidth;
  const imgHeight = imgWidth * 0.5;
  for (const [title, png] of [
    ["Peak disappearance", report.peakPlotPng],
    ["Conversion", report.conversionPlotPng],
  ] as const) {
    if (y + imgHeight + 24 > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(title, margin, y);
    y += 12;
    if (png) {
      doc.addImage(png, "PNG", margin, y, imgWidth, imgHeight);
      y += imgHeight + 16;
    } else {
      doc.setFont("helvetica", "normal");
      doc.setTextColor(140);
      doc.text("(chart unavailable)", margin, y + 12);
      doc.setTextColor(0);
      y += 28;
    }
  }

  // Reaction-order page.
  if (report.orders.length) {
    doc.addPage();
    y = margin;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text("Reaction order — fit & compare (0/1/2)", margin, y);
    y += 22;

    doc.setFontSize(9);
    const cols = [margin, margin + 70, margin + 200, margin + 300, margin + 400];
    doc.text("Order", cols[0], y);
    doc.text("Linearized", cols[1], y);
    doc.text("R^2", cols[2], y);
    doc.text("Rate k", cols[3], y);
    doc.text("k units", cols[4], y);
    y += 12;
    doc.setFont("courier", "normal");
    for (const o of report.orders) {
      doc.text(String(o.order), cols[0], y);
      doc.text(o.label, cols[1], y);
      doc.text(Number.isFinite(o.r2) ? o.r2.toFixed(4) : "—", cols[2], y);
      doc.text(o.ok ? g(o.k) : "—", cols[3], y);
      doc.text(o.ok ? o.kUnits : "—", cols[4], y);
      y += 13;
    }
  }

  return doc.output("blob");
}

/** Download the run's report as `kinetics_report.pdf` (cached by signature). */
export function downloadKineticsPdf(
  report: KineticsReport,
  cacheKey: string,
  filename = "kinetics_report.pdf",
): void {
  let blob = pdfCache.get(cacheKey);
  if (!blob) {
    blob = buildPdf(report);
    pdfCache.set(cacheKey, blob);
  }
  triggerDownload(blob, filename);
}

// --- Excel -------------------------------------------------------------------

const excelCache = new Map<string, ArrayBuffer>();

// Note: ExcelJS has no native chart API, so the chart PNGs grabbed from the live
// uPlot canvases are embedded as images on the Charts sheet. The full data + fit
// blocks are written alongside so the reader can build native charts in Excel.
async function buildExcel(report: KineticsReport): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NMR Predict — IR Kinetics";
  wb.created = new Date();

  // Summary sheet.
  const summary = wb.addWorksheet("Summary");
  summary.getCell("A1").value = "IR Kinetics Report";
  summary.getCell("A1").font = { bold: true, size: 14 };
  let r = 3;
  for (const line of summaryLines(report)) {
    summary.getCell(`A${r}`).value = line;
    r += 1;
  }
  if (report.orders.length) {
    r += 1;
    summary.getCell(`A${r}`).value = "Reaction order — fit & compare (0/1/2)";
    summary.getCell(`A${r}`).font = { bold: true };
    r += 1;
    summary.getRow(r).values = ["Order", "Linearized", "R^2", "Rate k", "k units"];
    summary.getRow(r).font = { bold: true };
    r += 1;
    for (const o of report.orders) {
      summary.getRow(r).values = [
        o.order,
        o.label,
        Number.isFinite(o.r2) ? o.r2 : "—",
        o.ok ? o.k : "—",
        o.ok ? o.kUnits : "—",
      ];
      r += 1;
    }
  }
  summary.getColumn(1).width = 60;
  summary.getColumn(2).width = 18;
  for (let c = 3; c <= 5; c += 1) summary.getColumn(c).width = 16;

  // Kinetics data sheet.
  const sheet = wb.addWorksheet("Kinetics");
  const table = buildReportTable(report);
  const headerRow = sheet.addRow(table.headers);
  headerRow.font = { bold: true };
  for (const row of table.rows) {
    sheet.addRow(row.map((v) => (Number.isFinite(v) ? v : null)));
  }
  // Fit block, a few columns to the right of the data table.
  const fitCol = table.headers.length + 2;
  const put = (rowIdx: number, label: string, value: string | number) => {
    sheet.getCell(rowIdx, fitCol).value = label;
    sheet.getCell(rowIdx, fitCol + 1).value = value;
  };
  sheet.getCell(1, fitCol).value = "First-order fit";
  sheet.getCell(1, fitCol).font = { bold: true };
  put(2, "fit ok", report.result.fitOk ? "yes" : "no");
  put(3, `k (/${report.timeUnit})`, Number.isFinite(report.result.k) ? report.result.k : "—");
  put(4, `half-life (${report.timeUnit})`, Number.isFinite(report.result.halfLife) ? report.result.halfLife : "—");
  put(5, "final conversion", Number.isFinite(report.result.finalConversion) ? report.result.finalConversion : "—");
  put(6, "R^2", Number.isFinite(report.result.r2) ? report.result.r2 : "—");
  put(7, "S0", Number.isFinite(report.result.s0) ? report.result.s0 : "—");
  put(8, "S_inf", Number.isFinite(report.result.sInf) ? report.result.sInf : "—");
  sheet.columns.forEach((c) => {
    if (!c.width) c.width = 16;
  });

  // Charts (embedded images — see note above).
  if (report.peakPlotPng || report.conversionPlotPng) {
    const charts = wb.addWorksheet("Charts");
    let topRow = 0;
    for (const png of [report.peakPlotPng, report.conversionPlotPng]) {
      if (!png) continue;
      const id = wb.addImage({
        base64: png.replace(/^data:image\/png;base64,/, ""),
        extension: "png",
      });
      charts.addImage(id, { tl: { col: 0, row: topRow }, ext: { width: 760, height: 360 } });
      topRow += 20;
    }
  }

  return wb.xlsx.writeBuffer();
}

/** Download the run's report as `kinetics.xlsx` (cached by signature). */
export async function downloadKineticsExcel(
  report: KineticsReport,
  cacheKey: string,
  filename = "kinetics.xlsx",
): Promise<void> {
  let bytes = excelCache.get(cacheKey);
  if (!bytes) {
    bytes = await buildExcel(report);
    excelCache.set(cacheKey, bytes);
  }
  triggerDownload(
    new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    filename,
  );
}
