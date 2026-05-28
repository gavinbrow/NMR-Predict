// Export the kinetics workspace to a PDF report or an Excel workbook, each with
// the charts rasterized from the on-screen Recharts SVG and embedded as images.

import ExcelJS from "exceljs";
import { jsPDF } from "jspdf";
import {
  MODEL_LABELS,
  ORDER_TEST_ORDERS,
  ORDER_Y_LABELS,
  formatHalfLife,
  formatRate,
  fromSeconds,
  linearizeSeries,
  type FitResult,
  type KineticModelKind,
  type SeriesPoint,
  type TimeUnit,
  type TrackedPeak,
} from "./kinetics";

export interface KineticsExportPayload {
  displayUnit: TimeUnit;
  model: KineticModelKind;
  peaks: TrackedPeak[];
  seriesByPeak: Record<string, SeriesPoint[]>;
  fitByPeak: Record<string, FitResult | null>;
  /** DOM nodes wrapping each chart's <svg>, captured at export time. */
  kineticsChartEl: HTMLElement | null;
  orderChartEl: HTMLElement | null;
}

const ROLE = (peak: TrackedPeak) => peak.role ?? "reactant";

function plottedPeaks(peaks: TrackedPeak[]): TrackedPeak[] {
  return peaks.filter((peak) => ROLE(peak) !== "standard");
}

// --- SVG → PNG ---------------------------------------------------------------

/**
 * Rasterize the first <svg> inside `container` to a PNG data URL on a white
 * background. The chart SVG is self-contained (inline attributes), so the canvas
 * is not tainted and `toDataURL` works.
 */
async function captureChartPng(container: HTMLElement | null, scale = 2): Promise<string | null> {
  if (!container) return null;
  const svg = container.querySelector("svg");
  if (!svg) return null;

  const rect = svg.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));

  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");

  const svgString = new XMLSerializer().serializeToString(clone);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`;

  const image = await new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
  if (!image) return null;

  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  return canvas.toDataURL("image/png");
}

// --- Tabular data ------------------------------------------------------------

interface SeriesTable {
  unitLabel: string;
  header: string[];
  rows: (number | "")[][];
}

/** Wide table: one row per timepoint, one value column per plotted peak. */
function buildSeriesTable(payload: KineticsExportPayload): SeriesTable {
  const peaks = plottedPeaks(payload.peaks);
  const unit = payload.displayUnit;

  const timeSet = new Set<number>();
  for (const peak of peaks) {
    for (const point of payload.seriesByPeak[peak.id] ?? []) timeSet.add(point.timeSeconds);
  }
  const times = [...timeSet].sort((a, b) => a - b);

  const valueAt = (peakId: string, t: number): number | "" => {
    const point = (payload.seriesByPeak[peakId] ?? []).find((p) => p.timeSeconds === t);
    return point ? point.value : "";
  };

  return {
    unitLabel: `Time (${unit})`,
    header: [`Time (${unit})`, ...peaks.map((peak) => peak.label)],
    rows: times.map((t) => [
      Number(fromSeconds(t, unit).toPrecision(6)),
      ...peaks.map((peak) => {
        const v = valueAt(peak.id, t);
        return v === "" ? "" : Number(v.toPrecision(6));
      }),
    ]),
  };
}

interface FitRow {
  label: string;
  role: string;
  model: string;
  k: string;
  halfLife: string;
  rSquared: string;
  points: string;
  /** R² for each linearized order, for order determination. */
  orderR2: Record<string, string>;
}

function buildFitRows(payload: KineticsExportPayload): FitRow[] {
  return plottedPeaks(payload.peaks).map((peak) => {
    const fit = payload.fitByPeak[peak.id];
    const series = payload.seriesByPeak[peak.id] ?? [];
    const orderR2: Record<string, string> = {};
    for (const order of ORDER_TEST_ORDERS) {
      const line = linearizeSeries(series, order).line;
      orderR2[order] = line ? line.rSquared.toFixed(4) : "—";
    }
    return {
      label: peak.label,
      role: ROLE(peak),
      model: MODEL_LABELS[payload.model],
      k: fit && Number.isFinite(fit.k) ? formatRate(fit.k, fit.model, payload.displayUnit) : "—",
      halfLife:
        fit && fit.model === "first" ? formatHalfLife(fit.halfLife, payload.displayUnit) : "—",
      rSquared: fit && Number.isFinite(fit.rSquared) ? fit.rSquared.toFixed(4) : "—",
      points: fit ? String(fit.pointCount) : "0",
      orderR2,
    };
  });
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
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

// --- PDF ---------------------------------------------------------------------

export async function exportKineticsPdf(payload: KineticsExportPayload): Promise<void> {
  const [kineticsPng, orderPng] = await Promise.all([
    captureChartPng(payload.kineticsChartEl),
    captureChartPng(payload.orderChartEl),
  ]);

  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 40;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("NMR Kinetics Report", margin, y);
  y += 20;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(110);
  doc.text(
    `Model: ${MODEL_LABELS[payload.model]}   •   Time unit: ${payload.displayUnit}   •   Generated ${new Date().toLocaleString()}`,
    margin,
    y,
  );
  doc.setTextColor(0);
  y += 22;

  // Fit results
  const fitRows = buildFitRows(payload);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("Fit results", margin, y);
  y += 16;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  for (const row of fitRows) {
    doc.setFont("helvetica", "bold");
    doc.text(`${row.label} (${row.role})`, margin, y);
    doc.setFont("helvetica", "normal");
    y += 13;
    const lines = [
      `k = ${row.k}    t½ = ${row.halfLife}    R² = ${row.rSquared}    points = ${row.points}`,
      `Linearized R²:  [A] vs t = ${row.orderR2.zero}    ln[A] vs t = ${row.orderR2.first}    1/[A] vs t = ${row.orderR2.second}`,
    ];
    for (const line of lines) {
      doc.text(line, margin + 12, y);
      y += 13;
    }
    y += 4;
  }
  y += 8;

  const addChart = (png: string | null, title: string) => {
    if (!png) return;
    const imgWidth = contentWidth;
    const imgHeight = imgWidth * 0.5;
    if (y + imgHeight + 24 > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text(title, margin, y);
    y += 12;
    doc.addImage(png, "PNG", margin, y, imgWidth, imgHeight);
    y += imgHeight + 20;
  };

  addChart(kineticsPng, "Kinetics curve");
  addChart(orderPng, "Order-determination plot");

  doc.save(`nmr-kinetics-${timestampSlug()}.pdf`);
}

// --- Excel -------------------------------------------------------------------

export async function exportKineticsExcel(payload: KineticsExportPayload): Promise<void> {
  const [kineticsPng, orderPng] = await Promise.all([
    captureChartPng(payload.kineticsChartEl),
    captureChartPng(payload.orderChartEl),
  ]);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "NMR Predict — Kinetics";
  workbook.created = new Date();

  // Sheet 1: data series.
  const dataSheet = workbook.addWorksheet("Data");
  const table = buildSeriesTable(payload);
  const headerRow = dataSheet.addRow(table.header);
  headerRow.font = { bold: true };
  for (const row of table.rows) dataSheet.addRow(row);
  dataSheet.columns.forEach((column) => {
    column.width = 16;
  });

  // Sheet 2: fit results + order test.
  const fitSheet = workbook.addWorksheet("Fit results");
  fitSheet.addRow([`Model: ${MODEL_LABELS[payload.model]}`]);
  fitSheet.addRow([`Time unit: ${payload.displayUnit}`]);
  fitSheet.addRow([]);
  const fitHeader = fitSheet.addRow([
    "Peak",
    "Role",
    "k",
    "t½",
    "R²",
    "Points",
    "R² [A] vs t",
    "R² ln[A] vs t",
    "R² 1/[A] vs t",
  ]);
  fitHeader.font = { bold: true };
  for (const row of buildFitRows(payload)) {
    fitSheet.addRow([
      row.label,
      row.role,
      row.k,
      row.halfLife,
      row.rSquared,
      row.points,
      row.orderR2.zero,
      row.orderR2.first,
      row.orderR2.second,
    ]);
  }
  fitSheet.columns.forEach((column) => {
    column.width = 16;
  });

  // Sheet 3: charts.
  const chartSheet = workbook.addWorksheet("Charts");
  let anchorRow = 1;
  const embed = (png: string | null, title: string) => {
    if (!png) return;
    chartSheet.getCell(`A${anchorRow}`).value = title;
    chartSheet.getCell(`A${anchorRow}`).font = { bold: true };
    const imageId = workbook.addImage({
      base64: png.replace(/^data:image\/png;base64,/, ""),
      extension: "png",
    });
    chartSheet.addImage(imageId, {
      tl: { col: 0, row: anchorRow },
      ext: { width: 720, height: 360 },
    });
    anchorRow += 22;
  };
  embed(kineticsPng, "Kinetics curve");
  embed(orderPng, "Order-determination plot");

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  triggerDownload(blob, `nmr-kinetics-${timestampSlug()}.xlsx`);
}
