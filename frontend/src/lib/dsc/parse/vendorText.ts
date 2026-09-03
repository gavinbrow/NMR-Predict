// Mettler / Netzsch / PerkinElmer text-export sniffer + normalizer (§2.5 of
// the plan).
//
// ⚠️ NO SAMPLE FILES EXIST for any of these three vendors. Every signature
// and column layout below is built from published format descriptions, not
// from a decoded real file — unlike `triosTri.ts`/`triosXls.ts`, nothing here
// is "verified". Treat this module as a best-effort bridge into the generic
// table parser, and cover it only with hand-written fixture strings.
//
// Each vendor's raw text is normalized into a `SheetGrid` + a pre-filled
// `DscColumnMap`, then handed to `parseGenericGrid` (§2.3) — this module does
// NOT duplicate the generic extraction/unit-conversion logic. A decimal comma
// ("0,068") is normalized to a point BEFORE the grid is built, but only on
// rows whose every token is comma-decimal-shaped, so a text header row is
// never mistaken for data.
//
// Every successful import (Netzsch/Mettler/PerkinElmer alike) pushes exactly
// one warning asking the user to verify the values against their instrument
// software, since none of this has been checked against a real export.

import type { Row, SheetGrid } from "@/lib/tensile/parse";
import { parseGenericGrid } from "./genericTable";
import type { DscColumnMap, ParsedDscFile } from "../types";

export type VendorTextKind = "netzsch" | "mettler" | "perkinElmer";

/** Netzsch Proteus ASCII: `#SAMPLE`, `#INSTRUMENT` and `#TYPE OF CRUCIBLE`
 *  comment lines. PerkinElmer Pyris: a preamble naming "Pyris" or
 *  "PerkinElmer". Mettler STARe: a numeric table headed
 *  `Index  t  Ts  Tr  Value`. Order matters only in that Netzsch/PerkinElmer
 *  are checked first — a Mettler table header is unlikely to collide with
 *  either. Returns null when nothing matches. */
export function sniffVendorText(text: string): VendorTextKind | null {
  if (/#\s*SAMPLE\b/i.test(text) && /#\s*INSTRUMENT\b/i.test(text) && /#\s*TYPE OF CRUCIBLE\b/i.test(text)) {
    return "netzsch";
  }
  if (/\bpyris\b/i.test(text) || /\bperkinelmer\b/i.test(text)) {
    return "perkinElmer";
  }
  if (hasMettlerTableHeader(text)) return "mettler";
  return null;
}

function isMettlerHeader(tokens: string[]): boolean {
  if (tokens.length < 5) return false;
  const lower = tokens.map((t) => t.toLowerCase());
  return lower[0] === "index" && lower.includes("t") && lower.includes("ts") && lower.includes("tr") && lower.includes("value");
}

function hasMettlerTableHeader(text: string): boolean {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const d of ["\t", ";", ","] as const) {
      if (isMettlerHeader(trimmed.split(d).map((p) => p.trim()).filter(Boolean))) return true;
    }
  }
  return false;
}

/**
 * Normalize a decimal comma to a point ("0,068" → "0.068"), but ONLY on a
 * line where every non-blank `delimiter`-separated token is comma-decimal
 * shaped (`/^-?\d+,\d+$/`) — a header/text row (which mixes in non-numeric
 * tokens) is left untouched. No-op when `delimiter` is itself the comma
 * (it can't simultaneously be the field separator and the decimal mark).
 */
export function normalizeDecimalComma(text: string, delimiter: "," | ";" | "\t"): string {
  if (delimiter === ",") return text;
  const lines = text.split("\n");
  return lines
    .map((line) => {
      const tokens = line.split(delimiter);
      const nonBlank = tokens.map((t) => t.trim()).filter((t) => t !== "");
      if (nonBlank.length === 0) return line;
      if (!nonBlank.every((t) => /^-?\d+,\d+$/.test(t))) return line;
      return tokens.map((t) => t.replace(",", ".")).join(delimiter);
    })
    .join("\n");
}

function vendorWarning(fileName: string, vendor: string): string {
  return `${fileName}: read as a ${vendor} text export — verify the values against your instrument software.`;
}

/** Netzsch Proteus ASCII: strip the leading `#`s, find the `##Name/Unit;…`
 *  column-header line, and treat everything after it as data (skipping any
 *  further `#`-prefixed comment lines). */
export function parseNetzschText(text: string, fileName: string): ParsedDscFile {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let headerLineIdx = -1;
  let delimiter: "," | ";" | "\t" = ";";
  let headerTokens: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trimStart().startsWith("##")) continue;
    const stripped = line.replace(/^\s*#+/, "").trim();
    for (const d of [";", ",", "\t"] as const) {
      const parts = stripped.split(d).map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 3) {
        headerLineIdx = i;
        delimiter = d;
        headerTokens = parts;
        break;
      }
    }
    if (headerLineIdx >= 0) break;
  }
  if (headerLineIdx < 0) {
    return { fileName, runs: [], warnings: [`${fileName}: couldn't find the Netzsch "##Name/Unit" column header line.`] };
  }
  const names = headerTokens.map((t) => t.split("/")[0].trim().toLowerCase());
  const units = headerTokens.map((t) => {
    const idx = t.indexOf("/");
    return idx >= 0 ? t.slice(idx + 1).trim().toLowerCase() : "";
  });
  const timeCol = names.findIndex((n) => n.includes("time"));
  const tempCol = names.findIndex((n) => n.includes("temp"));
  const heatFlowCol = names.findIndex((n) => n.includes("dsc") || n.includes("heat"));
  if (timeCol < 0 || tempCol < 0 || heatFlowCol < 0) {
    return {
      fileName,
      runs: [],
      warnings: [`${fileName}: couldn't find Time/Temp./DSC columns in the Netzsch header.`],
    };
  }
  const bodyLines = lines
    .slice(headerLineIdx + 1)
    .filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));
  const normalizedBody = normalizeDecimalComma(bodyLines.join("\n"), delimiter);
  const dataRows: Row[] = normalizedBody
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.split(delimiter).map((c) => c.trim()));
  const grid: SheetGrid = { name: fileName, rows: [headerTokens, ...dataRows] };

  const hfUnitText = units[heatFlowCol] ?? "";
  const heatFlowUnit: DscColumnMap["heatFlowUnit"] =
    hfUnitText.includes("mw/mg") || hfUnitText.includes("w/g")
      ? "mW/mg"
      : hfUnitText.includes("mw")
        ? "mW"
        : "W";
  const timeUnitText = units[timeCol] ?? "";
  const timeUnit: DscColumnMap["timeUnit"] = timeUnitText.includes("s") && !timeUnitText.includes("min") ? "s" : "min";
  const tempUnit: DscColumnMap["tempUnit"] = (units[tempCol] ?? "").includes("k") ? "K" : "C";

  const map: DscColumnMap = {
    time: timeCol,
    timeUnit,
    temperature: tempCol,
    heatFlow: heatFlowCol,
    heatFlowUnit,
    tempUnit,
    exoDirection: "up",
    headerRow: 0,
    firstDataRow: 1,
  };
  const result = parseGenericGrid(grid, fileName, map);
  if (result.runs.length === 0) return result;
  return { ...result, warnings: [...result.warnings, vendorWarning(fileName, "Netzsch Proteus")] };
}

/** Mettler STARe ASCII: a `Key: value` metadata block (ignored — no fields
 *  from it are needed for the arrays), then a numeric table headed
 *  `Index  t  Ts  Tr  Value` (tab, `;`, or `,` separated). `Ts` (sample
 *  temperature) and `Value` (heat flow, assumed mW) are read; `Tr` (reference
 *  temperature) is out of scope, same as TGA/DSC's other unused signals. */
export function parseMettlerText(text: string, fileName: string): ParsedDscFile {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let headerLineIdx = -1;
  let delimiter: "," | ";" | "\t" = "\t";
  let headerTokens: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    for (const d of ["\t", ";", ","] as const) {
      const parts = trimmed.split(d).map((p) => p.trim()).filter(Boolean);
      if (isMettlerHeader(parts)) {
        headerLineIdx = i;
        delimiter = d;
        headerTokens = parts;
        break;
      }
    }
    if (headerLineIdx >= 0) break;
  }
  if (headerLineIdx < 0) {
    return {
      fileName,
      runs: [],
      warnings: [`${fileName}: couldn't find the Mettler "Index t Ts Tr Value" header row.`],
    };
  }
  const lower = headerTokens.map((t) => t.toLowerCase());
  const timeCol = lower.indexOf("t");
  const tempCol = lower.indexOf("ts");
  const heatFlowCol = lower.indexOf("value");

  const bodyLines = lines.slice(headerLineIdx + 1).filter((l) => l.trim() !== "");
  const normalizedBody = normalizeDecimalComma(bodyLines.join("\n"), delimiter);
  const dataRows: Row[] = normalizedBody
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.split(delimiter).map((c) => c.trim()));
  const grid: SheetGrid = { name: fileName, rows: [headerTokens, ...dataRows] };

  const map: DscColumnMap = {
    time: timeCol,
    timeUnit: "min",
    temperature: tempCol,
    heatFlow: heatFlowCol,
    heatFlowUnit: "mW",
    tempUnit: "C",
    exoDirection: "up",
    headerRow: 0,
    firstDataRow: 1,
  };
  const result = parseGenericGrid(grid, fileName, map);
  if (result.runs.length === 0) return result;
  return { ...result, warnings: [...result.warnings, vendorWarning(fileName, "Mettler STARe")] };
}

/** PerkinElmer Pyris ASCII: a text preamble naming "Pyris"/"PerkinElmer",
 *  then a delimited table with `Time`, `Temperature` and a heat-flow column.
 *  ⚠️ "Heat Flow Endo Up" is PerkinElmer's convention of a POSITIVE signal
 *  reading as an ENDOTHERM — the opposite of TRIOS's exo-up default — so
 *  that header sets `meta.exoDirection = "down"` (§3.2 flips the display
 *  sign from there; this module does not flip the stored values itself). */
export function parsePerkinElmerText(text: string, fileName: string): ParsedDscFile {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let headerLineIdx = -1;
  let delimiter: "," | ";" | "\t" = ",";
  let headerTokens: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    for (const d of [",", ";", "\t"] as const) {
      const parts = trimmed.split(d).map((p) => p.trim()).filter(Boolean);
      const lower = parts.map((p) => p.toLowerCase());
      if (
        lower.some((p) => p.includes("time")) &&
        lower.some((p) => p.includes("temp")) &&
        lower.some((p) => p.includes("heat flow"))
      ) {
        headerLineIdx = i;
        delimiter = d;
        headerTokens = parts;
        break;
      }
    }
    if (headerLineIdx >= 0) break;
  }
  if (headerLineIdx < 0) {
    return {
      fileName,
      runs: [],
      warnings: [`${fileName}: couldn't find the Pyris Time/Temperature/Heat Flow header row.`],
    };
  }
  const lower = headerTokens.map((t) => t.toLowerCase());
  const timeCol = lower.findIndex((t) => t.includes("time"));
  const tempCol = lower.findIndex((t) => t.includes("temp"));
  const heatFlowCol = lower.findIndex((t) => t.includes("heat flow"));
  const endoUp = lower[heatFlowCol]?.includes("endo up") ?? false;

  const bodyLines = lines.slice(headerLineIdx + 1).filter((l) => l.trim() !== "");
  const normalizedBody = normalizeDecimalComma(bodyLines.join("\n"), delimiter);
  const dataRows: Row[] = normalizedBody
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.split(delimiter).map((c) => c.trim()));
  const grid: SheetGrid = { name: fileName, rows: [headerTokens, ...dataRows] };

  const map: DscColumnMap = {
    time: timeCol,
    timeUnit: "min",
    temperature: tempCol,
    heatFlow: heatFlowCol,
    heatFlowUnit: "mW",
    tempUnit: "C",
    exoDirection: endoUp ? "down" : "up",
    headerRow: 0,
    firstDataRow: 1,
  };
  const result = parseGenericGrid(grid, fileName, map);
  if (result.runs.length === 0) return result;
  return { ...result, warnings: [...result.warnings, vendorWarning(fileName, "PerkinElmer Pyris")] };
}

/** Sniff + parse in one call. Returns null when the text doesn't match any
 *  of the three vendor signatures — the caller falls back to
 *  `genericTable.ts`. */
export function parseVendorText(text: string, fileName: string): ParsedDscFile | null {
  const kind = sniffVendorText(text);
  if (kind === "netzsch") return parseNetzschText(text, fileName);
  if (kind === "mettler") return parseMettlerText(text, fileName);
  if (kind === "perkinElmer") return parsePerkinElmerText(text, fileName);
  return null;
}
