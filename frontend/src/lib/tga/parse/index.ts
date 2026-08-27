// TGA file-format dispatcher. Sniffs the format from the file's first bytes
// (and extension as a fallback) and routes to the right parser. The browser
// entry (`parseTgaFiles`) reads each `File`'s bytes and dispatches; the parsers
// themselves are pure over a byte buffer / cell grid and live in their own
// modules so they are unit-testable without the DOM.

import type { SheetGrid } from "@/lib/tensile/parse";
import type { ColumnMap, ParsedTgaFile, SniffResult } from "../types";
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

/** The first bytes of an OLE2/BIFF8 compound file (`D0 CF 11 E0`). */
const OLE2_SIG = [0xd0, 0xcf, 0x11, 0xe0];
/** The first bytes of a ZIP-based `.xlsx` (`PK\x03\x04`). */
const ZIP_SIG = [0x50, 0x4b, 0x03, 0x04];
/** The UTF-16LE BOM (`FF FE`). */
const UTF16LE_BOM = [0xff, 0xfe];
/** The PNG signature (`89 50 4E 47`). */
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47];

function bytesEqual(bytes: Uint8Array, offset: number, sig: number[]): boolean {
  if (offset + sig.length > bytes.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

/** Look for a substring in the first `n` bytes of a UTF-16LE buffer. */
function utf16Includes(bytes: Uint8Array, needle: string, scanBytes: number): boolean {
  // Decode the first `scanBytes` as UTF-16LE (each char = 2 bytes) and search.
  const limit = Math.min(bytes.length, scanBytes);
  // Round down to an even number of bytes.
  const even = limit - (limit % 2);
  const text = new TextDecoder("utf-16le").decode(bytes.subarray(0, even));
  return text.includes(needle);
}

/** Sniff a TGA file's format from its name and first bytes. Returns
 *  `"skip"` for files we deliberately ignore (`.pdf`), `null` for unrecognised
 *  files (surface as a warning), and a {@link TgaFormat} for everything else. */
export function sniffFormat(name: string, headBytes: Uint8Array): SniffResult {
  const lower = name.toLowerCase();
  // PDF: silently skip — not a TGA format, no warning.
  if (lower.endsWith(".pdf")) return "skip";
  // TA binary: extension like .001, .002, … — check BEFORE the UTF-16LE BOM,
  // because the binary file begins with the same UTF-16 header text as the TA
  // text export (FF FE + "CLOSED"/"Version"), so the BOM check below would
  // otherwise mis-route it to taText.
  if (/\.\d{3}$/.test(lower)) return "taBinary";
  // OLE2 (BIFF8 .xls) or ZIP (.xlsx): SheetJS territory.
  if (bytesEqual(headBytes, 0, OLE2_SIG) || bytesEqual(headBytes, 0, ZIP_SIG)) {
    // TRIOS exports carry a `Details` sheet or a Time/Temperature/Weight header
    // trio; without reading the sheets we can't be sure, so default to triosXls
    // and let it fall through to genericTable when no `Details` sheet is found.
    // (The sniff only needs to route to a SheetJS reader; the parser decides.)
    if (lower.endsWith(".xls") || lower.endsWith(".xlsx")) return "triosXls";
    return "genericTable";
  }
  // UTF-16LE BOM + TA header keywords → taText.
  if (bytesEqual(headBytes, 0, UTF16LE_BOM)) {
    if (utf16Includes(headBytes, "CLOSED", 1024) || utf16Includes(headBytes, "Version", 1024)) {
      return "taText";
    }
    // UTF-16LE but not a TA text export — could be a TRIOS .tri (whose header is
    // UTF-16-ish in places). Defer to the .tri check below if the extension matches.
    if (lower.endsWith(".tri")) return "triosTri";
    return "taText"; // best guess
  }
  // TRIOS .tri: the header is mostly ASCII with `instrumenttype` near the start,
  // but it's not UTF-16; check for the ASCII key, or fall back to extension.
  if (lower.endsWith(".tri")) {
    // Scan the first 512 bytes for the ASCII "instrumenttype" key.
    const limit = Math.min(headBytes.length, 512);
    const ascii = new TextDecoder("latin1").decode(headBytes.subarray(0, limit));
    if (ascii.includes("instrumenttype")) return "triosTri";
    return "triosTri"; // extension wins
  }
  // Generic text: .csv / .tsv / .txt
  if (lower.endsWith(".csv") || lower.endsWith(".tsv") || lower.endsWith(".txt")) {
    return "genericTable";
  }
  return null;
}

/** A generic table whose columns could not be auto-detected. The host opens
 *  the ColumnMapDialog on these, then re-parses with the map the user built
 *  (see {@link parseMappedGrid}) — no second read of the file needed. */
export interface PendingColumnMap {
  fileName: string;
  /** The cell grid, so the dialog can preview it and the caller can re-parse
   *  without touching the original File again. */
  grid: SheetGrid;
  /** The best guess the auto-detector could make (may be null). */
  suggestion: ColumnMap | null;
}

/** The outcome of a drop: everything that parsed, everything deliberately
 *  skipped, the files still waiting on a column mapping, and the warnings. */
export interface ParseTgaFilesResult {
  parsed: ParsedTgaFile[];
  skipped: string[];
  needsMapping: PendingColumnMap[];
  warnings: string[];
}

/** Re-parse a pending generic table once the user has confirmed its columns. */
export function parseMappedGrid(pending: PendingColumnMap, map: ColumnMap): ParsedTgaFile {
  return parseGenericGrid(pending.grid, pending.fileName, map);
}

/** Parse a list of dropped files. Reads each file's bytes, sniffs, and
 *  dispatches to the right parser. Never throws — every failure becomes a
 *  warning. Generic tables whose columns can't be auto-detected come back in
 *  `needsMapping` rather than as a warning, so the host can open the mapping
 *  dialog instead of the user having to guess what went wrong. The optional
 *  `columnMaps` supplies a per-file-name {@link ColumnMap} up front (the host
 *  remembers one per header layout), which skips the dialog entirely. */
export async function parseTgaFiles(
  files: File[],
  columnMaps?: Record<string, ColumnMap>,
): Promise<ParseTgaFilesResult> {
  const parsed: ParsedTgaFile[] = [];
  const skipped: string[] = [];
  const needsMapping: PendingColumnMap[] = [];
  const warnings: string[] = [];

  /** Shared tail for both generic paths: resolve a column map (supplied,
   *  auto-detected, or deferred to the dialog) and parse the grid with it. */
  const handleGeneric = (grid: SheetGrid | null, fileName: string): ParsedTgaFile | null => {
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
    const fmt = sniffFormat(file.name, bytes);
    if (fmt === "skip") {
      skipped.push(file.name);
      continue;
    }
    if (fmt === null) {
      warnings.push(`${file.name}: unrecognised format.`);
      continue;
    }
    try {
      let result: ParsedTgaFile | null;
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
          // A spreadsheet with no `Details` sheet and no side-by-side sample
          // blocks isn't a TRIOS export at all — retry it as a generic table
          // (which may in turn defer to the column-mapping dialog).
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
          const isText =
            lower.endsWith(".csv") || lower.endsWith(".tsv") || lower.endsWith(".txt");
          const grid = isText
            ? parseCsvText(new TextDecoder().decode(bytes), file.name)
            : firstSheetGrid(buf, file.name);
          result = handleGeneric(grid, file.name);
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
