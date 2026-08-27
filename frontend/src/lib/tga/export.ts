// Export & project I/O for the TGA workspace (WP8).
//
// Everything stays client-side: CSV and JSON are built in memory and offered as
// downloads; the Excel workbook is written with ExcelJS and then post-processed
// to carry two NATIVE, editable scatter charts (weight % and DTG against
// temperature) via the shared `injectCharts` helper; the PDF report is jsPDF,
// mirroring `lib/maldi/export.ts`'s `exportReportPdf`.
//
// The project file (`.tgaproj`) round-trips the runs, the analysis params, the
// materials and the figure options, so a saved workspace reproduces the exact
// view on another machine. Float64Arrays become plain number[] for JSON and are
// reconstructed on import — the same conversion MALDI's project format uses.

import ExcelJS from "exceljs";
import { jsPDF } from "jspdf";
import { injectCharts, type ChartSpec } from "@/lib/maldi/excelChartInject";
import { triggerDownload } from "@/lib/ir/export";
import { downsample } from "@/lib/gcms/view";
import type { FigureOptions } from "@/lib/ir/figure";
import {
  buildSummaryRows,
  tgaMetrics,
  type TgaMetric,
  type TgaSummaryRow,
} from "./compare";
import type { TgaRunAnalyzed } from "./store";
import type { AnalysisParams, TgaMaterial, TgaRun, TgaState } from "./types";

// --- small shared plumbing ---------------------------------------------------

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function safeName(name: string): string {
  return (name || "tga").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "tga";
}

function csvCell(value: string | number | undefined | null): string {
  if (value == null) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows → CSV text. CRLF line endings, so Excel on Windows opens it cleanly. */
export function toCsv(rows: (string | number | undefined | null)[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

function downloadText(text: string, filename: string, mime = "text/plain"): void {
  triggerDownload(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}

/** A finite number rounded for output, or "" so a CSV/sheet shows a blank
 *  rather than "NaN". */
function cell(v: number | null | undefined, decimals: number): number | "" {
  if (v == null || !Number.isFinite(v)) return "";
  return Number(v.toFixed(decimals));
}

// --- CSV ---------------------------------------------------------------------

/**
 * Every visible run's processed curve, laid out as side-by-side five-column
 * blocks (Time / Temperature / Weight / Weight % / Deriv. weight) with the run
 * name above each — deliberately the same shape as the TRIOS Excel export the
 * user already reads, so the columns land where they expect. Blocks of
 * different lengths are padded with blanks.
 */
export function buildCurvesCsvRows(runs: TgaRunAnalyzed[]): (string | number | "")[][] {
  const cols = 5;
  const titles: (string | number | "")[] = [];
  const headers: (string | number | "")[] = [];
  const units: (string | number | "")[] = [];
  for (const run of runs) {
    titles.push(run.label, "", "", "", "");
    headers.push("Time", "Temperature", "Weight", "Weight", "Deriv. Weight");
    units.push("min", "°C", "mg", "%", "%/°C");
  }
  const maxLen = runs.reduce((m, r) => Math.max(m, r.tempC.length), 0);
  const rows: (string | number | "")[][] = [titles, headers, units];
  for (let i = 0; i < maxLen; i += 1) {
    const row: (string | number | "")[] = [];
    for (const run of runs) {
      const a = run.analysis;
      if (i >= run.tempC.length) {
        row.push(...Array<"">(cols).fill(""));
        continue;
      }
      row.push(
        cell(run.timeMin[i], 5),
        cell(run.tempC[i], 4),
        cell(run.weightMg[i], 6),
        cell(a.weightPct[i], 5),
        cell(a.dtg[i], 6),
      );
    }
    rows.push(row);
  }
  return rows;
}

/** Download the processed curves of the given runs as one CSV. */
export function downloadCurvesCsv(runs: TgaRunAnalyzed[], baseName = "tga"): void {
  downloadText(
    toCsv(buildCurvesCsvRows(runs)),
    `${safeName(baseName)}-curves-${timestampSlug()}.csv`,
    "text/csv",
  );
}

/** Summary table rows (one per run) as CSV rows, metric columns included. */
export function buildSummaryCsvRows(
  rows: TgaSummaryRow[],
  metrics: TgaMetric[],
): (string | number | "")[][] {
  const header: (string | number | "")[] = [
    "Run",
    "Material",
    "File",
    ...metrics.map((m) => `${m.label} (${m.unit})`),
    "Steps",
  ];
  const body = rows.map((r) => [
    r.label,
    r.materialName,
    r.fileName,
    ...metrics.map((m) => cell(r.values[m.key], m.decimals)),
    r.stepCount,
  ]);
  return [header, ...body];
}

/** Download the cross-run summary as CSV. */
export function downloadSummaryCsv(
  rows: TgaSummaryRow[],
  metrics: TgaMetric[],
  baseName = "tga",
): void {
  downloadText(
    toCsv(buildSummaryCsvRows(rows, metrics)),
    `${safeName(baseName)}-summary-${timestampSlug()}.csv`,
    "text/csv",
  );
}

/** Every run's detected steps as CSV rows. */
export function buildStepsCsvRows(runs: TgaRunAnalyzed[]): (string | number | "")[][] {
  const header: (string | number | "")[] = [
    "Run",
    "Step",
    "Onset (°C)",
    "Tmax (°C)",
    "Endset (°C)",
    "Window lo (°C)",
    "Window hi (°C)",
    "Loss (%)",
    "Loss (mg)",
  ];
  const body: (string | number | "")[][] = [];
  for (const run of runs) {
    for (const s of run.analysis.steps) {
      body.push([
        run.label,
        s.index + 1,
        cell(s.tOnset, 2),
        cell(s.tMax, 2),
        cell(s.tEndset, 2),
        cell(s.tRange[0], 2),
        cell(s.tRange[1], 2),
        cell(s.lossPct, 3),
        cell(s.lossMg, 5),
      ]);
    }
  }
  return [header, ...body];
}

// --- Excel -------------------------------------------------------------------

/**
 * Excel's own ceiling on points in one chart data series. Runs at or under it
 * are charted at FULL resolution straight off their data sheet — no second,
 * thinned copy of the curve anywhere in the workbook. Only a run longer than
 * this gets a decimated copy (in spare columns on its own sheet) for the chart
 * to read, because Excel would otherwise silently drop the overflow.
 */
const EXCEL_MAX_CHART_POINTS = 32000;

export interface TgaExcelInput {
  runs: TgaRunAnalyzed[];
  materials: TgaMaterial[];
  params: AnalysisParams;
  /** Optional PNG data URL of the publication figure, embedded on its own sheet. */
  figurePng?: string | null;
  baseName?: string;
}

/**
 * Write the workbook: a Summary sheet, a Steps sheet, one full-resolution data
 * sheet per run, and a `Charts` sheet carrying two native editable scatter
 * charts — weight % vs temperature and DTG vs temperature.
 *
 * The charts read each run's data sheet DIRECTLY, so every recorded point is on
 * the curve and the workbook holds exactly one copy of the data. (An earlier
 * revision wrote a separate decimated `Chart data` sheet; that thinned the
 * exported curves to ~900 points each, which is the one thing an export must
 * not do.) A run longer than Excel's 32 000-point series limit is the sole
 * exception — see {@link EXCEL_MAX_CHART_POINTS}.
 *
 * Two separate charts rather than one secondary-axis chart: an OOXML combo
 * chart is a great deal more XML for a picture that is harder to read than the
 * pair.
 *
 * Returns the finished .xlsx bytes; {@link exportTgaExcel} wraps this with the
 * download. Split so the package can be asserted on in a test without a DOM.
 */
export async function buildTgaExcelBuffer(input: TgaExcelInput): Promise<Uint8Array> {
  const { runs, materials, params, figurePng } = input;
  const metrics = tgaMetrics(params.tdThresholds);
  const summaryRows = buildSummaryRows(runs, materials, metrics);

  const wb = new ExcelJS.Workbook();
  wb.creator = "NMR Predict — TGA";
  wb.created = new Date();

  // --- Summary ---
  const summary = wb.addWorksheet("Summary");
  summary.addRow(["TGA summary"]).font = { bold: true };
  summary.addRow([]);
  summary.addRow(["Normalization", params.normMode]);
  if (params.normMode === "atTemperature") {
    summary.addRow(["Re-zero temperature (°C)", params.rezeroTempC ?? ""]);
  }
  summary.addRow(["DTG window (points)", params.dtgWindow]);
  summary.addRow(["DTG unit", params.dtgUnit]);
  summary.addRow(["Td thresholds (%)", params.tdThresholds.join(", ")]);
  summary.addRow(["Min step loss (%)", params.stepMinLossPct]);
  summary.addRow(["Residue temperature (°C)", params.residueTempC ?? "final point"]);
  summary.addRow([]);
  const sumHeader = summary.addRow(buildSummaryCsvRows(summaryRows, metrics)[0]);
  sumHeader.font = { bold: true };
  for (const row of buildSummaryCsvRows(summaryRows, metrics).slice(1)) summary.addRow(row);
  summary.getColumn(1).width = 32;
  summary.getColumn(2).width = 26;
  summary.getColumn(3).width = 26;

  // --- Steps ---
  const stepRows = buildStepsCsvRows(runs);
  const steps = wb.addWorksheet("Steps");
  steps.addRow(stepRows[0]).font = { bold: true };
  for (const r of stepRows.slice(1)) steps.addRow(r);
  steps.getColumn(1).width = 28;

  // --- One data sheet per run (full resolution), and the ranges the charts
  //     will read straight off it ---
  const usedSheetNames = new Set(["Summary", "Steps", "Charts", "Figure"]);
  /** Where one run's chart series live: which sheet, and the A1 ranges. */
  interface ChartBlock {
    run: TgaRunAnalyzed;
    sheet: string;
    xRange: string;
    wRange: string;
    dRange: string;
  }
  const blocks: ChartBlock[] = [];
  let tMin = Infinity;
  let tMax = -Infinity;
  let wMin = Infinity;
  let wMax = -Infinity;
  let dMin = Infinity;
  let dMax = -Infinity;

  for (const run of runs) {
    // Excel sheet names: 31 chars max, no []:*?/\ and no duplicates.
    let name = run.label.replace(/[[\]:*?/\\]/g, "-").slice(0, 28) || "Run";
    let suffix = 2;
    while (usedSheetNames.has(name)) {
      name = `${name.slice(0, 26)}-${suffix}`;
      suffix += 1;
    }
    usedSheetNames.add(name);
    const ws = wb.addWorksheet(name);
    const a = run.analysis;
    const n = run.tempC.length;
    const oversized = n > EXCEL_MAX_CHART_POINTS;
    const header = [
      "Time (min)",
      "Temperature (°C)",
      "Weight (mg)",
      "Weight (%)",
      `Deriv. weight (${params.dtgUnit})`,
    ];
    // Only an oversized run pays for a second, thinned copy of its curve.
    const thinned = oversized
      ? (() => {
          const w = downsample({ x: run.tempC, y: a.weightPct }, EXCEL_MAX_CHART_POINTS);
          const d = downsample({ x: run.tempC, y: a.dtg }, EXCEL_MAX_CHART_POINTS);
          const m = Math.min(w.x.length, d.x.length);
          return { x: w.x, wt: w.y, dtg: d.y, n: m };
        })()
      : null;
    if (thinned) {
      header.push(
        "",
        "Chart: Temperature (°C)",
        "Chart: Weight (%)",
        `Chart: Deriv. weight (${params.dtgUnit})`,
      );
    }
    ws.addRow(header).font = { bold: true };
    for (let i = 0; i < n; i += 1) {
      const row: (string | number | "")[] = [
        cell(run.timeMin[i], 5),
        cell(run.tempC[i], 4),
        cell(run.weightMg[i], 6),
        cell(a.weightPct[i], 5),
        cell(a.dtg[i], 6),
      ];
      if (thinned) {
        row.push(
          "",
          i < thinned.n ? cell(thinned.x[i], 4) : "",
          i < thinned.n ? cell(thinned.wt[i], 5) : "",
          i < thinned.n ? cell(thinned.dtg[i], 6) : "",
        );
      }
      ws.addRow(row);
    }
    for (let c = 1; c <= (thinned ? 9 : 5); c += 1) ws.getColumn(c).width = 16;

    // Data starts on sheet row 2 (row 1 is the header).
    const count = thinned ? thinned.n : n;
    if (count > 1) {
      const first = 2;
      const last = first + count - 1;
      // Full resolution: B / D / E. Thinned: G / H / I.
      const [xc, wc, dc] = thinned ? ["G", "H", "I"] : ["B", "D", "E"];
      blocks.push({
        run,
        sheet: name,
        xRange: `${xc}${first}:${xc}${last}`,
        wRange: `${wc}${first}:${wc}${last}`,
        dRange: `${dc}${first}:${dc}${last}`,
      });
    }
    for (let i = 0; i < n; i += 1) {
      const t = run.tempC[i];
      if (Number.isFinite(t)) {
        tMin = Math.min(tMin, t);
        tMax = Math.max(tMax, t);
      }
      const w = a.weightPct[i];
      if (Number.isFinite(w)) {
        wMin = Math.min(wMin, w);
        wMax = Math.max(wMax, w);
      }
      const d = a.dtg[i];
      if (Number.isFinite(d)) {
        dMin = Math.min(dMin, d);
        dMax = Math.max(dMax, d);
      }
    }
  }

  // --- The two native charts, on their own sheet ---
  const chartSpecs: ChartSpec[] = [];
  if (blocks.length > 0) {
    const chartSheetName = "Charts";
    const chartSheet = wb.addWorksheet(chartSheetName);
    chartSheet.addRow(["TGA charts"]).font = { bold: true };
    chartSheet.addRow([
      "Each series reads its run's own sheet at full resolution — edit the chart, not the data.",
    ]);
    const round = (v: number, up: boolean) =>
      Number.isFinite(v) ? Number((up ? Math.ceil(v) : Math.floor(v)).toFixed(4)) : 0;
    // Weight % vs temperature — solid lines, no markers, no trendline, one
    // series per run in that run's own colour, with a legend to name them.
    chartSpecs.push({
      sheetName: chartSheetName,
      seriesName: "TGA",
      xRange: "",
      yRange: "",
      series: blocks.map((b) => ({
        name: b.run.label,
        sheet: b.sheet,
        xRange: b.xRange,
        yRange: b.wRange,
        color: b.run.color,
      })),
      xMin: round(tMin, false),
      xMax: round(tMax, true),
      yMin: Math.min(0, round(wMin, false)),
      yMax: round(Math.max(wMax, 100), true),
      xTitle: "Temperature (°C)",
      yTitle: "Weight (%)",
      xNumFmt: "0",
      yNumFmt: "0",
      style: { line: "solid", markers: false, trendline: false, legend: true },
      anchorCol: 1,
      anchorRow: 3,
    });
    // DTG vs temperature, directly below the first chart (charts are 16 rows tall).
    chartSpecs.push({
      sheetName: chartSheetName,
      seriesName: "DTG",
      xRange: "",
      yRange: "",
      series: blocks.map((b) => ({
        name: `${b.run.label} DTG`,
        sheet: b.sheet,
        xRange: b.xRange,
        yRange: b.dRange,
        color: b.run.color,
      })),
      xMin: round(tMin, false),
      xMax: round(tMax, true),
      // DTG is small (~0.1 %/°C), so an integer-rounded axis would collapse to
      // 0–1 and flatten the curve; keep the real range with a little headroom.
      yMin: Number.isFinite(dMin) ? Number((dMin - Math.abs(dMin) * 0.1).toFixed(4)) : 0,
      yMax: Number.isFinite(dMax) ? Number((dMax + Math.abs(dMax) * 0.1).toFixed(4)) : 1,
      xTitle: "Temperature (°C)",
      yTitle: `Deriv. weight (${params.dtgUnit})`,
      xNumFmt: "0",
      yNumFmt: "0.000",
      style: { line: "solid", markers: false, trendline: false, legend: true },
      anchorCol: 1,
      anchorRow: 21,
    });
  }

  // --- Figure image ---
  if (figurePng) {
    const figSheet = wb.addWorksheet("Figure");
    const imageId = wb.addImage({
      base64: figurePng.replace(/^data:image\/png;base64,/, ""),
      extension: "png",
    });
    figSheet.addImage(imageId, { tl: { col: 0, row: 0 }, ext: { width: 900, height: 675 } });
  }

  const raw = new Uint8Array(await wb.xlsx.writeBuffer());
  // Always run the injector: it also repairs the drawing ExcelJS writes for an
  // embedded image, which Excel otherwise reports as a repaired record.
  return injectCharts(raw, chartSpecs);
}

/** Build the workbook and hand it to the browser as a download. */
export async function exportTgaExcel(input: TgaExcelInput): Promise<void> {
  const buffer = await buildTgaExcelBuffer(input);
  triggerDownload(
    new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    `${safeName(input.baseName ?? "tga")}-report-${timestampSlug()}.xlsx`,
  );
}

// --- PDF ---------------------------------------------------------------------

export interface TgaPdfInput {
  runs: TgaRunAnalyzed[];
  materials: TgaMaterial[];
  params: AnalysisParams;
  /** PNG data URL of the publication figure, drawn under the header. */
  figurePng?: string | null;
  projectName?: string;
}

/** A simple bordered table writer: returns the y the caller should continue at. */
function pdfTable(
  doc: jsPDF,
  startY: number,
  margin: number,
  colWidths: number[],
  header: string[],
  body: (string | number)[][],
  pageHeight: number,
): number {
  const rowH = 13;
  let y = startY;
  const drawHeader = () => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    let x = margin;
    for (let i = 0; i < header.length; i += 1) {
      doc.text(String(header[i]), x, y);
      x += colWidths[i];
    }
    y += 4;
    doc.setDrawColor(200);
    doc.line(margin, y, margin + colWidths.reduce((a, b) => a + b, 0), y);
    y += rowH - 4;
    doc.setFont("helvetica", "normal");
  };
  drawHeader();
  for (const row of body) {
    if (y > pageHeight - 50) {
      doc.addPage();
      y = 50;
      drawHeader();
    }
    let x = margin;
    for (let i = 0; i < row.length; i += 1) {
      doc.text(String(row[i] ?? ""), x, y);
      x += colWidths[i];
    }
    y += rowH;
  }
  return y;
}

/** Generate a PDF report: parameters, the figure, the summary table, and every
 *  run's detected steps. */
export function exportTgaReportPdf(input: TgaPdfInput): void {
  const { runs, materials, params, figurePng, projectName = "TGA analysis" } = input;
  const metrics = tgaMetrics(params.tdThresholds);
  const summaryRows = buildSummaryRows(runs, materials, metrics);

  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 40;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("TGA Report", margin, y);
  y += 20;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(110);
  doc.text(
    `${projectName}   •   ${runs.length} run${runs.length === 1 ? "" : "s"}   •   ${new Date().toLocaleString()}`,
    margin,
    y,
  );
  y += 13;
  doc.text(
    `Normalization: ${params.normMode}   •   DTG window: ${params.dtgWindow} pts   •   Td: ${params.tdThresholds.map((t) => `${t}%`).join(", ")}   •   Min step loss: ${params.stepMinLossPct}%`,
    margin,
    y,
  );
  doc.setTextColor(0);
  y += 18;

  if (figurePng) {
    const imgWidth = contentWidth;
    const imgHeight = imgWidth * 0.72;
    if (y + imgHeight > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
    // `compression` matters here: without it jsPDF embeds the raster verbatim
    // and a 1600x1200 figure turns a two-page report into a ~7 MB file.
    doc.addImage(figurePng, "PNG", margin, y, imgWidth, imgHeight, undefined, "FAST");
    y += imgHeight + 18;
  }

  // Summary table.
  if (y > pageHeight - 120) {
    doc.addPage();
    y = margin;
  }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("Summary", margin, y);
  y += 16;
  const summaryHeader = ["Run", ...metrics.map((m) => `${m.label} (${m.unit})`)];
  const summaryWidths = [
    Math.max(90, contentWidth - (contentWidth - 90) * 0 - 52 * metrics.length),
    ...metrics.map(() => 52),
  ];
  y = pdfTable(
    doc,
    y,
    margin,
    summaryWidths,
    summaryHeader,
    summaryRows.map((r) => [
      r.label.length > 22 ? `${r.label.slice(0, 21)}…` : r.label,
      ...metrics.map((m) => {
        const v = r.values[m.key];
        return Number.isFinite(v) ? v.toFixed(m.decimals) : "—";
      }),
    ]),
    pageHeight,
  );
  y += 14;

  // Steps table.
  const stepRows = buildStepsCsvRows(runs);
  if (stepRows.length > 1) {
    if (y > pageHeight - 120) {
      doc.addPage();
      y = margin;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("Degradation steps", margin, y);
    y += 16;
    const widths = [130, 34, 62, 62, 62, 62, 62];
    pdfTable(
      doc,
      y,
      margin,
      widths,
      ["Run", "#", "Onset °C", "Tmax °C", "Endset °C", "Loss %", "Loss mg"],
      stepRows.slice(1).map((r) => [
        String(r[0]).length > 22 ? `${String(r[0]).slice(0, 21)}…` : String(r[0]),
        String(r[1]),
        String(r[2] === "" ? "—" : r[2]),
        String(r[3] === "" ? "—" : r[3]),
        String(r[4] === "" ? "—" : r[4]),
        String(r[7] === "" ? "—" : r[7]),
        String(r[8] === "" ? "—" : r[8]),
      ]),
      pageHeight,
    );
  }

  doc.save(`${safeName(projectName)}-report-${timestampSlug()}.pdf`);
}

// --- Project JSON (.tgaproj) --------------------------------------------------

/** A run with its typed arrays flattened to plain number[] for JSON. */
interface SerializableRun extends Omit<
  TgaRun,
  "timeMin" | "tempC" | "weightMg" | "weightPctFile" | "dtgFile"
> {
  timeMin: number[];
  tempC: number[];
  weightMg: number[];
  weightPctFile?: number[];
  dtgFile?: number[];
}

/** The on-disk shape of a `.tgaproj` file. */
export interface TgaProjectRecord {
  version: 1;
  savedAt: string;
  state: Omit<TgaState, "runs"> & { runs: SerializableRun[] };
  /** The publication figure's styling, so a reopened project looks identical. */
  figureOptions?: FigureOptions | null;
}

/** Pick exactly the persisted fields. Deliberately NOT a spread of `run`: the
 *  store hands out `TgaRunAnalyzed`, and spreading would drag the derived
 *  analysis (two more full-length arrays per run) into the project file. */
function serializeRun(run: TgaRun): SerializableRun {
  return {
    id: run.id,
    fileId: run.fileId,
    fileName: run.fileName,
    label: run.label,
    color: run.color,
    meta: run.meta,
    segments: run.segments,
    scale: run.scale,
    offset: run.offset,
    visible: run.visible,
    materialId: run.materialId,
    timeMin: Array.from(run.timeMin),
    tempC: Array.from(run.tempC),
    weightMg: Array.from(run.weightMg),
    ...(run.weightPctFile ? { weightPctFile: Array.from(run.weightPctFile) } : {}),
    ...(run.dtgFile ? { dtgFile: Array.from(run.dtgFile) } : {}),
  };
}

function deserializeRun(run: SerializableRun): TgaRun {
  return {
    id: run.id,
    fileId: run.fileId,
    fileName: run.fileName,
    label: run.label,
    color: run.color,
    meta: run.meta,
    segments: run.segments,
    scale: run.scale,
    offset: run.offset,
    visible: run.visible,
    materialId: run.materialId,
    timeMin: Float64Array.from(run.timeMin ?? []),
    tempC: Float64Array.from(run.tempC ?? []),
    weightMg: Float64Array.from(run.weightMg ?? []),
    ...(run.weightPctFile ? { weightPctFile: Float64Array.from(run.weightPctFile) } : {}),
    ...(run.dtgFile ? { dtgFile: Float64Array.from(run.dtgFile) } : {}),
  };
}

/** Serialize the workspace to `.tgaproj` JSON text. */
export function serializeTgaProject(
  state: TgaState,
  figureOptions?: FigureOptions | null,
): string {
  const record: TgaProjectRecord = {
    version: 1,
    savedAt: new Date().toISOString(),
    state: { ...state, runs: state.runs.map(serializeRun) },
    figureOptions: figureOptions ?? null,
  };
  return JSON.stringify(record);
}

/** Parse a `.tgaproj` file. Throws with a readable message on anything that
 *  isn't a TGA project, so the caller can surface it as a toast. */
export function deserializeTgaProject(text: string): {
  state: TgaState;
  figureOptions: FigureOptions | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Not a valid .tgaproj file (unreadable JSON).");
  }
  const record = parsed as Partial<TgaProjectRecord>;
  if (!record || typeof record !== "object" || !record.state || !Array.isArray(record.state.runs)) {
    throw new Error("Not a TGA project file.");
  }
  const s = record.state;
  return {
    state: {
      files: s.files ?? [],
      runs: s.runs.map(deserializeRun),
      materials: s.materials ?? [],
      params: s.params,
      blankRunId: s.blankRunId ?? null,
    },
    figureOptions: record.figureOptions ?? null,
  };
}

/** Download the workspace as a `.tgaproj` file. */
export function downloadTgaProject(
  state: TgaState,
  figureOptions: FigureOptions | null,
  baseName = "tga",
): void {
  downloadText(
    serializeTgaProject(state, figureOptions),
    `${safeName(baseName)}-${timestampSlug()}.tgaproj`,
    "application/json",
  );
}
