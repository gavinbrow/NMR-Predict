// DSC file-format dispatcher (§2.6 of the plan). Sniffs the format from the
// file's name and bytes and routes to the right parser; never throws — every
// failure becomes a warning. Mirrors `lib/tga/parse/index.ts`'s shape and
// order exactly, with one addition: the OLE2/ZIP branch actually opens the
// workbook to decide `triosXls` vs `genericTable` (TGA instead always guesses
// `triosXls` and falls back after the fact — DSC's plan calls for checking up
// front, since a "Details" sheet or a Time/Temperature/Heat Flow header trio
// settles it cheaply).
//
// `.dscproj` is expected to be split off by the caller BEFORE these files
// reach `parseDscFiles`, the same way `Tga.tsx`'s `useTgaImport` does for
// `.tgaproj` — that's a WP2/store concern, not a parsing one.

import * as XLSX from "xlsx";
import { type SheetGrid, workbookToSheets } from "@/lib/tensile/parse";
import type { DscColumnMap, ParsedDscFile } from "../types";
import { parseTaText } from "./taText";
import { parseTaBinary } from "./taBinary";
import { parseTriosTri } from "./triosTri";
import { parseTriosXls } from "./triosXls";
import {
  autoDetectColumnMap,
  firstSheetGrid,
  parseCsvText,
  parseGenericGrid,
} from "./genericTable";
import { parseVendorText } from "./vendorText";

/** The set of native DSC formats the dispatcher recognises. */
export type DscFormat = "taText" | "taBinary" | "triosTri" | "triosXls" | "genericTable";

/** Outcome of `sniffDscFormat`: a known format, `"skip"` (silently ignore,
 *  e.g. PDF), or `null` (unrecognised — surface as a warning). */
export type DscSniffResult = DscFormat | "skip" | null;

const OLE2_SIG = [0xd0, 0xcf, 0x11, 0xe0];
const ZIP_SIG = [0x50, 0x4b, 0x03, 0x04];
const UTF16LE_BOM = [0xff, 0xfe];

function bytesEqual(bytes: Uint8Array, offset: number, sig: number[]): boolean {
  if (offset + sig.length > bytes.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

/** Look for a substring in the first `scanBytes` bytes of a UTF-16LE buffer. */
function utf16Includes(bytes: Uint8Array, needle: string, scanBytes: number): boolean {
  const limit = Math.min(bytes.length, scanBytes);
  const even = limit - (limit % 2);
  const text = new TextDecoder("utf-16le").decode(bytes.subarray(0, even));
  return text.includes(needle);
}

/** True when a sheet's first few rows carry a Time + Temperature + Heat Flow
 *  header trio (any DSC export's minimum column set), used to recognise a
 *  TRIOS-shaped workbook that isn't named `.xls`/`.xlsx` or lacks a `Details`
 *  sheet. */
function sheetHasDscHeaderTrio(sheet: SheetGrid): boolean {
  for (const row of sheet.rows.slice(0, 5)) {
    const lower = row.map((c) => (c == null ? "" : String(c).trim().toLowerCase()));
    const hasTime = lower.some((h) => h === "time");
    const hasTemp = lower.some((h) => h.includes("temp"));
    const hasHeatFlow = lower.some((h) => h.includes("heat flow"));
    if (hasTime && hasTemp && hasHeatFlow) return true;
  }
  return false;
}

/** Sniff a DSC file's format from its name and bytes (§2.6's order —
 *  load-bearing, do not reorder). */
export function sniffDscFormat(name: string, bytes: Uint8Array): DscSniffResult {
  const lower = name.toLowerCase();
  // 1. PDF: silently skip.
  if (lower.endsWith(".pdf")) return "skip";
  // 2. TA binary: .001/.002/… — before the UTF-16LE BOM test, since the
  //    binary starts with the same UTF-16 header text as the TA text export.
  if (/\.\d{3}$/.test(lower)) return "taBinary";
  // 3. OLE2 (.xls) or ZIP (.xlsx): open the workbook and decide by content.
  if (bytesEqual(bytes, 0, OLE2_SIG) || bytesEqual(bytes, 0, ZIP_SIG)) {
    if (lower.endsWith(".xls") || lower.endsWith(".xlsx")) {
      try {
        const wb = XLSX.read(bytes, { type: "array" });
        const sheets = workbookToSheets(wb);
        const hasDetails = sheets.some((s) => s.name.trim().toLowerCase() === "details");
        const hasTrio = sheets.some((s) => sheetHasDscHeaderTrio(s));
        return hasDetails || hasTrio ? "triosXls" : "genericTable";
      } catch {
        return "genericTable";
      }
    }
    return "genericTable";
  }
  // 4. UTF-16LE BOM + TA header keywords → taText.
  if (bytesEqual(bytes, 0, UTF16LE_BOM)) {
    if (utf16Includes(bytes, "CLOSED", 1024) || utf16Includes(bytes, "Version", 1024)) {
      return "taText";
    }
    if (lower.endsWith(".tri")) return "triosTri";
    return "taText"; // best guess
  }
  // 5. UTF-8 "instrumenttype" near the start, or a .tri extension → triosTri.
  {
    const limit = Math.min(bytes.length, 512);
    const ascii = new TextDecoder("latin1").decode(bytes.subarray(0, limit));
    if (ascii.includes("instrumenttype") || lower.endsWith(".tri")) return "triosTri";
  }
  // 6. Generic text: vendor sniffing happens once the text is decoded
  //    (`parseDscFiles`); the sniffer only needs to route here.
  if (lower.endsWith(".csv") || lower.endsWith(".tsv") || lower.endsWith(".txt")) {
    return "genericTable";
  }
  return null;
}

/** A generic table whose columns could not be auto-detected. The host opens
 *  the ColumnMapDialog on these, then re-parses via {@link parseMappedGrid}. */
export interface PendingDscColumnMap {
  fileName: string;
  grid: SheetGrid;
  suggestion: DscColumnMap | null;
}

/** Outcome of a drop: everything that parsed, everything deliberately
 *  skipped, files still waiting on a column mapping, and every warning. */
export interface ParseDscFilesResult {
  parsed: ParsedDscFile[];
  skipped: string[];
  needsMapping: PendingDscColumnMap[];
  warnings: string[];
}

/** Re-parse a pending generic table once the user has confirmed its columns. */
export function parseMappedGrid(pending: PendingDscColumnMap, map: DscColumnMap): ParsedDscFile {
  return parseGenericGrid(pending.grid, pending.fileName, map);
}

/** Parse a list of dropped files. Reads each file's bytes, sniffs, and
 *  dispatches to the right parser. Never throws — every failure becomes a
 *  warning. Generic tables whose columns can't be auto-detected come back in
 *  `needsMapping`. The optional `columnMaps` supplies a per-file-name
 *  {@link DscColumnMap} up front (the host remembers one per header layout),
 *  which skips the dialog entirely. */
export async function parseDscFiles(
  files: File[],
  columnMaps?: Record<string, DscColumnMap>,
): Promise<ParseDscFilesResult> {
  const parsed: ParsedDscFile[] = [];
  const skipped: string[] = [];
  const needsMapping: PendingDscColumnMap[] = [];
  const warnings: string[] = [];

  const handleGeneric = (grid: SheetGrid | null, fileName: string): ParsedDscFile | null => {
    if (!grid) {
      warnings.push(`${fileName}: no readable table found.`);
      return null;
    }
    const supplied = columnMaps?.[fileName];
    const map = supplied ?? autoDetectColumnMap(grid);
    if (!map) {
      needsMapping.push({ fileName, grid, suggestion: null });
      return null;
    }
    return parseGenericGrid(grid, fileName, map);
  };

  for (const file of files) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const fmt = sniffDscFormat(file.name, bytes);
    if (fmt === "skip") {
      skipped.push(file.name);
      continue;
    }
    if (fmt === null) {
      warnings.push(`${file.name}: unrecognised format.`);
      continue;
    }
    try {
      let result: ParsedDscFile | null;
      switch (fmt) {
        case "taText":
          result = parseTaText(buf, file.name);
          break;
        case "taBinary":
          result = parseTaBinary(buf, file.name);
          break;
        case "triosTri":
          result = parseTriosTri(buf, file.name);
          break;
        case "triosXls": {
          // A spreadsheet with no usable segment sheets isn't a TRIOS export
          // after all — retry as a generic table (may defer to the dialog).
          const trios = parseTriosXls(buf, file.name);
          if (trios.runs.length === 0 && trios.warnings.length > 0) {
            result = handleGeneric(firstSheetGrid(buf, file.name), file.name);
          } else {
            result = trios;
          }
          break;
        }
        case "genericTable": {
          const lower = file.name.toLowerCase();
          const isText = lower.endsWith(".csv") || lower.endsWith(".tsv") || lower.endsWith(".txt");
          if (isText) {
            const text = new TextDecoder().decode(bytes);
            const vendor = parseVendorText(text, file.name);
            result = vendor ?? handleGeneric(parseCsvText(text, file.name), file.name);
          } else {
            result = handleGeneric(firstSheetGrid(buf, file.name), file.name);
          }
          break;
        }
        default:
          warnings.push(`${file.name}: unsupported format.`);
          continue;
      }
      if (!result) continue;
      parsed.push(result);
      warnings.push(...result.warnings);
    } catch (e) {
      warnings.push(`${file.name}: failed to parse — ${e instanceof Error ? e.message : String(e)}.`);
    }
  }
  return { parsed, skipped, needsMapping, warnings };
}
