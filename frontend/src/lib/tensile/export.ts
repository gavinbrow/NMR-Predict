// Phase 9 exports — a full Excel workbook and a PDF report, plus per-table CSV
// downloads, all built in the browser from the store-derived data. ExcelJS and
// jsPDF are already app dependencies; recharts figures are rasterized to PNG by
// `chart-image.ts` and passed in here (jsPDF embeds them; ExcelJS adds them as
// images on a Charts sheet, since ExcelJS has no native chart API).

import ExcelJS from "exceljs";
import { jsPDF } from "jspdf";
import { MACHINE_MAP, PROPERTY_META } from "./compute";
import { formatValue } from "./format";
import type {
  AnalysisParams,
  LoadedFile,
  MaterialView,
  PropertyKey,
  Specimen,
} from "./types";

/** Everything the exporters need, gathered from the store by the caller. */
export interface ExportInput {
  files: LoadedFile[];
  specimens: Specimen[];
  materials: MaterialView[];
  params: AnalysisParams;
}

/** A rasterized compare figure for the PDF/Excel report. */
export interface ExportFigure {
  title: string;
  /** PNG data URL, or "" when the figure couldn't be captured. */
  png: string;
}

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

/** Excel number format string for a property's decimal places ("0", "0.00", …). */
function numFmt(decimals: number): string {
  return decimals <= 0 ? "0" : `0.${"0".repeat(decimals)}`;
}

/** The machine columns to include (only those present on at least one specimen). */
function machineColumns(specimens: Specimen[]): typeof MACHINE_MAP {
  return MACHINE_MAP.filter((m) =>
    specimens.some((s) => s.machine && Number.isFinite(s.machine[m.machine])),
  );
}

/** specimen id → its material name (— when unassigned). */
function materialNameMap(materials: MaterialView[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const mv of materials) for (const id of mv.specimenIds) map.set(id, mv.name);
  return map;
}

/** A short methods paragraph, mirroring the Python `Summary` text. */
export function methodsParagraph(params: AnalysisParams, nSpecimens: number): string {
  const { eLo, eHi, offsetPct } = params;
  return (
    `${nSpecimens} specimens analysed. Strain in %, stress in MPa. ` +
    `Young's modulus: regression/chord over the ${eLo}–${eHi}% strain window (ISO 527-1). ` +
    `Yield strength: first stress maximum (ASTM D638); the ${offsetPct}% offset yield is ` +
    `reported separately for reference. Toughness: area under the stress–strain curve up to ` +
    `break. Pooled statistics use the sample standard deviation (ddof = 1); excluded ` +
    `specimens are omitted. Values that could not be determined are reported as N/A.`
  );
}

// --- CSV ---------------------------------------------------------------------

function csvCell(value: string | number): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Per-run CSV: one row per specimen, a column per property (+ instrument cols). */
export function specimensCsv(input: ExportInput): string {
  const matName = materialNameMap(input.materials);
  const machine = machineColumns(input.specimens);
  const headers = [
    "Specimen",
    "Material",
    "File",
    "Excluded",
    ...PROPERTY_META.map((m) => `${m.label} (${m.unit})`),
    "Modulus method",
    ...machine.map((m) => `${m.machine} (instrument)`),
  ];
  const lines = [headers.map(csvCell).join(",")];
  for (const s of input.specimens) {
    const row: (string | number)[] = [
      s.label,
      matName.get(s.id) ?? "—",
      s.fileName,
      s.excluded ? "yes" : "no",
      ...PROPERTY_META.map((m) => s.props[m.key] as number),
      s.props.E_method,
      ...machine.map((m) => (s.machine?.[m.machine] ?? NaN)),
    ];
    lines.push(row.map(csvCell).join(","));
  }
  return lines.join("\r\n");
}

/** Cross-material comparison CSV: rows = property, columns = each material's mean ± SD. */
export function summaryCsv(input: ExportInput): string {
  const headers = ["Property", ...input.materials.flatMap((m) => [`${m.name} mean`, `${m.name} SD`])];
  const lines = [headers.map(csvCell).join(",")];
  for (const meta of PROPERTY_META) {
    const row: (string | number)[] = [`${meta.label} (${meta.unit})`];
    for (const mv of input.materials) {
      const st = mv.stats[meta.key];
      row.push(st ? st.mean : NaN, st ? st.sd : NaN);
    }
    lines.push(row.map(csvCell).join(","));
  }
  return lines.join("\r\n");
}

export function downloadSpecimensCsv(input: ExportInput, filename = "tensile_specimens.csv"): void {
  triggerDownload(new Blob([specimensCsv(input)], { type: "text/csv;charset=utf-8" }), filename);
}

export function downloadSummaryCsv(input: ExportInput, filename = "tensile_summary.csv"): void {
  triggerDownload(new Blob([summaryCsv(input)], { type: "text/csv;charset=utf-8" }), filename);
}

// --- Excel -------------------------------------------------------------------

async function buildExcel(input: ExportInput, figures: ExportFigure[]): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NMR Predict — Tensile";
  wb.created = new Date();

  const matName = materialNameMap(input.materials);
  const machine = machineColumns(input.specimens);

  // --- Sheet 1: Properties (per run) ---------------------------------------
  const perRun = wb.addWorksheet("Properties (per run)");
  const headers = [
    "Specimen",
    "Material",
    "File",
    "Excluded",
    ...PROPERTY_META.map((m) => `${m.label} (${m.unit})`),
    "Modulus method",
    ...machine.map((m) => `${m.machine} (instrument)`),
  ];
  perRun.addRow(headers).font = { bold: true };
  for (const s of input.specimens) {
    const row = perRun.addRow([
      s.label,
      matName.get(s.id) ?? "—",
      s.fileName,
      s.excluded ? "yes" : "no",
      ...PROPERTY_META.map((m) => {
        const v = s.props[m.key] as number;
        return Number.isFinite(v) ? v : "N/A";
      }),
      s.props.E_method,
      ...machine.map((m) => {
        const v = s.machine?.[m.machine];
        return Number.isFinite(v) ? (v as number) : "N/A";
      }),
    ]);
    // Number formats per property (columns start at 5).
    PROPERTY_META.forEach((m, i) => {
      row.getCell(5 + i).numFmt = numFmt(m.decimals);
    });
  }
  perRun.columns.forEach((c, i) => (c.width = i < 3 ? 22 : 16));

  // --- Sheet 2: Summary (per material, all stats) --------------------------
  const summary = wb.addWorksheet("Summary");
  summary.getCell("A1").value = "Tensile Properties — Summary";
  summary.getCell("A1").font = { bold: true, size: 14 };
  summary.getCell("A2").value = methodsParagraph(input.params, input.specimens.length);
  summary.getCell("A2").alignment = { wrapText: true };
  summary.mergeCells("A2:H2");
  summary.getRow(2).height = 56;

  let r = 4;
  for (const mv of input.materials) {
    summary.getCell(r, 1).value = `${mv.name}  (n = ${mv.includedSpecimens.length}/${mv.specimens.length})`;
    summary.getCell(r, 1).font = { bold: true };
    r += 1;
    const head = summary.getRow(r);
    head.values = ["Property", "Mean", "SD", "CV (%)", "n", "Min", "Max"];
    head.font = { bold: true };
    r += 1;
    for (const meta of PROPERTY_META) {
      const st = mv.stats[meta.key];
      const row = summary.getRow(r);
      row.values = st
        ? [
            `${meta.label} (${meta.unit})`,
            Number.isFinite(st.mean) ? st.mean : "N/A",
            Number.isFinite(st.sd) ? st.sd : "N/A",
            Number.isFinite(st.cv) ? st.cv : "N/A",
            st.n,
            Number.isFinite(st.min) ? st.min : "N/A",
            Number.isFinite(st.max) ? st.max : "N/A",
          ]
        : [`${meta.label} (${meta.unit})`, "N/A", "N/A", "N/A", 0, "N/A", "N/A"];
      for (const c of [2, 3, 6, 7]) row.getCell(c).numFmt = numFmt(meta.decimals);
      row.getCell(4).numFmt = "0.0";
      r += 1;
    }
    r += 1;
  }
  summary.getColumn(1).width = 30;
  for (let c = 2; c <= 7; c += 1) summary.getColumn(c).width = 14;

  // --- Sheet 3: Comparison (cross-material matrix) -------------------------
  if (input.materials.length > 0) {
    const cmp = wb.addWorksheet("Comparison");
    const cmpHead = ["Property", ...input.materials.flatMap((m) => [`${m.name} mean`, `${m.name} SD`])];
    cmp.addRow(cmpHead).font = { bold: true };
    PROPERTY_META.forEach((meta) => {
      const cells: (string | number)[] = [`${meta.label} (${meta.unit})`];
      for (const mv of input.materials) {
        const st = mv.stats[meta.key];
        cells.push(
          st && Number.isFinite(st.mean) ? st.mean : "N/A",
          st && Number.isFinite(st.sd) ? st.sd : "N/A",
        );
      }
      const row = cmp.addRow(cells);
      for (let c = 2; c <= cmpHead.length; c += 1) row.getCell(c).numFmt = numFmt(meta.decimals);
    });
    cmp.getColumn(1).width = 30;
    for (let c = 2; c <= cmpHead.length; c += 1) cmp.getColumn(c).width = 14;
  }

  // --- Sheet 4: Charts (embedded images) -----------------------------------
  const withPng = figures.filter((f) => f.png);
  if (withPng.length > 0) {
    const charts = wb.addWorksheet("Charts");
    let topRow = 0;
    for (const fig of withPng) {
      charts.getCell(topRow + 1, 1).value = fig.title;
      charts.getCell(topRow + 1, 1).font = { bold: true };
      const id = wb.addImage({
        base64: fig.png.replace(/^data:image\/png;base64,/, ""),
        extension: "png",
      });
      charts.addImage(id, { tl: { col: 0, row: topRow + 1 }, ext: { width: 640, height: 320 } });
      topRow += 19;
    }
  }

  return wb.xlsx.writeBuffer();
}

export async function downloadExcel(
  input: ExportInput,
  figures: ExportFigure[] = [],
  filename = "tensile_report.xlsx",
): Promise<void> {
  const bytes = await buildExcel(input, figures);
  triggerDownload(
    new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    filename,
  );
}

// --- PDF ---------------------------------------------------------------------

function buildPdf(input: ExportInput, figures: ExportFigure[]): Blob {
  const doc = new jsPDF({ unit: "pt", format: "letter", orientation: "portrait" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 48;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  const ensure = (need: number) => {
    if (y + need > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
  };

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("Tensile Analysis Report", margin, y);
  y += 22;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(new Date().toLocaleString(), margin, y);
  y += 16;
  const sources = input.files.map((f) => f.fileName).join(", ") || "—";
  for (const line of doc.splitTextToSize(`Source files: ${sources}`, contentWidth)) {
    doc.text(line, margin, y);
    y += 12;
  }
  doc.setTextColor(0);
  y += 6;

  // Methods.
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Methods", margin, y);
  y += 14;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  for (const line of doc.splitTextToSize(methodsParagraph(input.params, input.specimens.length), contentWidth)) {
    ensure(12);
    doc.text(line, margin, y);
    y += 12;
  }
  y += 10;

  // Per-material summary tables (focused on the headline properties).
  const headlineKeys: PropertyKey[] = [
    "E_MPa",
    "uts_MPa",
    "strain_at_uts",
    "yield_off_MPa",
    "elong_break",
    "toughness",
  ];
  for (const mv of input.materials) {
    ensure(20 + (headlineKeys.length + 1) * 13);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(
      `${mv.name}  (n = ${mv.includedSpecimens.length}/${mv.specimens.length})`,
      margin,
      y,
    );
    y += 14;
    doc.setFontSize(9);
    doc.text("Property", margin, y);
    doc.text("Mean ± SD", margin + 230, y);
    doc.text("CV %", margin + 360, y);
    doc.text("n", margin + 430, y);
    y += 11;
    doc.setFont("courier", "normal");
    for (const key of headlineKeys) {
      const st = mv.stats[key];
      const meta = PROPERTY_META.find((m) => m.key === key);
      doc.text(`${meta?.label} (${meta?.unit})`, margin, y);
      if (st && Number.isFinite(st.mean)) {
        doc.text(`${formatValue(key, st.mean)} ± ${formatValue(key, st.sd)}`, margin + 230, y);
        doc.text(Number.isFinite(st.cv) ? st.cv.toFixed(1) : "—", margin + 360, y);
        doc.text(String(st.n), margin + 430, y);
      } else {
        doc.text("N/A", margin + 230, y);
      }
      y += 12;
    }
    doc.setFont("helvetica", "normal");
    y += 10;
  }

  // Figures (one per row).
  const figs = figures.filter((f) => f.png);
  if (figs.length > 0) {
    doc.addPage();
    y = margin;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text("Comparison figures", margin, y);
    y += 20;
    const imgWidth = contentWidth;
    const imgHeight = imgWidth * 0.5;
    for (const fig of figs) {
      ensure(imgHeight + 24);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.text(fig.title, margin, y);
      y += 12;
      doc.addImage(fig.png, "PNG", margin, y, imgWidth, imgHeight);
      y += imgHeight + 16;
    }
  }

  return doc.output("blob");
}

export function downloadPdf(
  input: ExportInput,
  figures: ExportFigure[] = [],
  filename = "tensile_report.pdf",
): void {
  triggerDownload(buildPdf(input, figures), filename);
}
