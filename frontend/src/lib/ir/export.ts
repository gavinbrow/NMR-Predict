// View & Export downloads (§5). The CSV is hand-rolled; the Excel workbook is a
// single data sheet (named after the y-axis) built with ExcelJS. Both consume
// the wide `SpectraTable` from shared.ts (wavenumber column + one column per
// spectrum on a common grid). Everything stays in the browser.

import ExcelJS from "exceljs";
import type { SpectraTable } from "./shared";
import type { YAxis } from "./types";

// --- download plumbing -------------------------------------------------------

export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** CSV cell: quote when needed; non-finite numbers become empty cells. */
function csvCell(value: string | number): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// --- CSV ---------------------------------------------------------------------

/** Render a `SpectraTable` to CSV text (CRLF line endings, like the MALDI export). */
export function tableToCsv(table: SpectraTable): string {
  const lines = [table.headers.map(csvCell).join(",")];
  for (const row of table.rows) lines.push(row.map(csvCell).join(","));
  return lines.join("\r\n");
}

/** Download the spectra table as `ir_spectra.csv`. */
export function downloadSpectraCsv(table: SpectraTable, filename = "ir_spectra.csv"): void {
  triggerDownload(
    new Blob([tableToCsv(table)], { type: "text/csv;charset=utf-8" }),
    filename,
  );
}

// --- Excel (cached by content) -----------------------------------------------

const excelCache = new Map<string, ArrayBuffer>();

/** FNV-1a 32-bit hash over the table (headers + every cell) for the Excel cache key. */
function tableHash(table: SpectraTable, yaxis: YAxis): string {
  let h = 0x811c9dc5;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  mix(yaxis);
  mix(table.headers.join(""));
  for (const row of table.rows) {
    for (const v of row) {
      h ^= v | 0;
      h = Math.imul(h, 0x01000193);
      // fold the fractional part so distinct floats hash distinctly
      h ^= Math.round((v - Math.trunc(v)) * 1e6) | 0;
      h = Math.imul(h, 0x01000193);
    }
  }
  return `${yaxis}:${table.headers.length}x${table.rows.length}:${(h >>> 0).toString(16)}`;
}

/** Build the .xlsx bytes for the spectra table (one sheet, named after the y-axis). */
async function buildExcel(table: SpectraTable, yaxis: YAxis): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "NMR Predict — IR Kinetics";
  wb.created = new Date();
  const sheet = wb.addWorksheet(yaxis === "Absorbance" ? "Absorbance" : "Transmittance");
  sheet.addRow(table.headers).font = { bold: true };
  for (const row of table.rows) sheet.addRow(row);
  sheet.columns.forEach((c) => (c.width = 16));
  return wb.xlsx.writeBuffer();
}

/** Download the spectra table as `ir_spectra.xlsx`, caching the bytes by content. */
export async function downloadSpectraExcel(
  table: SpectraTable,
  yaxis: YAxis,
  filename = "ir_spectra.xlsx",
): Promise<void> {
  const key = tableHash(table, yaxis);
  let bytes = excelCache.get(key);
  if (!bytes) {
    bytes = await buildExcel(table, yaxis);
    excelCache.set(key, bytes);
  }
  triggerDownload(
    new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    filename,
  );
}
