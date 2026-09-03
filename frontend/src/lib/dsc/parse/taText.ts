// TA Q-series text export parser for DSC (§2.4 of the plan).
//
// ⚠️ No Q-series DSC sample file exists — this module is built from the same
// verified container TGA's `.txt` reader uses (UTF-16LE, `Key<TAB>Value`
// header terminated by `StartOfData`, tab-separated data rows), reusing
// `decodeTaText`, `parseTaTextHeader`, `parseColumnNames` and `parseDataRow`
// from `lib/tga/parse/taText.ts` UNCHANGED. What's DSC-specific — which
// `Sig1..SigN` names to look for, and how the metadata maps — is an
// extrapolation, not a verified decode. The `Sig` set is read BY NAME, never
// by position, exactly like the TGA reader: `Time (min)`, `Temperature
// (°C)`, `Heat Flow (mW)` and often `Heat Flow (W/g)`.

import { decodeTaText, parseTaTextHeader, parseColumnNames, parseDataRow } from "@/lib/tga/parse/taText";
import { buildSegments } from "../segments";
import type { DscMetadata, ParsedDscFile, ParsedDscRun } from "../types";

/** Build the DSC metadata from the parsed `Key<TAB>Value` header map. */
export function buildTaDscMetadata(
  meta: Record<string, string | string[]>,
  fileName: string,
): DscMetadata {
  const get = (k: string): string => (typeof meta[k] === "string" ? (meta[k] as string) : "");
  const sizeStr = get("Size");
  let sampleMassMg: number | null = null;
  if (sizeStr) {
    const [numStr, unit] = sizeStr.split(/\s+/);
    const n = Number(numStr);
    if (Number.isFinite(n)) sampleMassMg = unit === "g" ? n * 1000 : n; // mg, or an unrecognised unit
  }
  const methodSteps: string[] = [];
  const org = meta.OrgMethod;
  if (Array.isArray(org)) methodSteps.push(...org);
  else if (typeof org === "string") methodSteps.push(org);
  return {
    instrument: get("Instrument") || "TA Q-series",
    operator: get("Operator"),
    sampleName: get("Sample") || fileName.replace(/\.[^.]+$/, ""),
    sampleMassMg,
    panMassMg: null,
    pan: get("FurnaceType") || get("PanType"),
    methodSteps,
    runDate: `${get("Date")} ${get("Time")}`.trim(),
    gases: "",
    cooler: "",
    cellConstant: "",
    sampleInterval: "",
    // No header flag carries this in the TA text container; default to the
    // same exo-up convention TRIOS uses.
    exoDirection: "up",
  };
}

/** Unit alias from a `SigN` column name's own text, e.g. "Heat Flow (mW)" or
 *  "Heat Flow (W/g)" — there's no separate units row in this container. */
function heatFlowUnitFromName(name: string): "mW" | "W" | "W/g" {
  const h = name.toLowerCase();
  if (h.includes("w/g") || h.includes("normal")) return "W/g";
  if (h.includes("mw")) return "mW";
  if (h.includes("w")) return "W";
  return "mW";
}

/** Parse a TA Q-series text export (UTF-16LE, tab-separated) into one DSC
 *  run. Pure over the byte buffer; never throws. */
export function parseTaText(buffer: ArrayBuffer | Uint8Array, fileName: string): ParsedDscFile {
  const warnings: string[] = [];
  const lines = decodeTaText(buffer);
  const { meta, dataStartIndex } = parseTaTextHeader(lines);
  if (dataStartIndex < 0) {
    warnings.push(`${fileName}: no StartOfData marker found.`);
    return { fileName, runs: [], warnings };
  }
  const columnNames = parseColumnNames(meta);
  if (columnNames.length === 0) {
    warnings.push(`${fileName}: could not read the column set (Nsig/SigN).`);
    return { fileName, runs: [], warnings };
  }

  const timeCol = columnNames.findIndex((n) => /time/i.test(n));
  const tempCol = columnNames.findIndex((n) => /temp/i.test(n));
  const heatFlowNormCol = columnNames.findIndex((n) => /heat flow/i.test(n) && /w\/g|normal/i.test(n));
  const heatFlowCol = columnNames.findIndex(
    (n, idx) => /heat flow/i.test(n) && idx !== heatFlowNormCol,
  );
  if (timeCol < 0 || tempCol < 0 || (heatFlowCol < 0 && heatFlowNormCol < 0)) {
    warnings.push(`${fileName}: missing a Time/Temperature/Heat Flow column.`);
    return { fileName, runs: [], warnings };
  }

  const metadata = buildTaDscMetadata(meta, fileName);
  const heatFlowUnit = heatFlowCol >= 0 ? heatFlowUnitFromName(columnNames[heatFlowCol]) : "mW";

  const timeMin: number[] = [];
  const tempC: number[] = [];
  const heatFlowMw: number[] = [];
  const heatFlowNorm: number[] = [];
  for (let i = dataStartIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    const row = parseDataRow(line);
    const t = row[timeCol];
    const T = row[tempCol];
    if (!Number.isFinite(t) || !Number.isFinite(T)) continue;
    timeMin.push(t);
    tempC.push(T);
    const norm = heatFlowNormCol >= 0 && Number.isFinite(row[heatFlowNormCol]) ? row[heatFlowNormCol] : NaN;
    if (heatFlowCol >= 0) {
      const raw = row[heatFlowCol];
      heatFlowMw.push(Number.isFinite(raw) ? (heatFlowUnit === "W" ? raw * 1000 : raw) : NaN);
      if (heatFlowNormCol >= 0) heatFlowNorm.push(norm);
    } else {
      // Only the normalized column exists — derive mW when a mass is known.
      heatFlowNorm.push(norm);
      heatFlowMw.push(
        Number.isFinite(norm) && metadata.sampleMassMg != null && metadata.sampleMassMg > 0
          ? norm * metadata.sampleMassMg
          : NaN,
      );
    }
  }
  if (timeMin.length === 0) {
    warnings.push(`${fileName}: no data rows found.`);
    return { fileName, runs: [], warnings };
  }

  const timeArr = Float64Array.from(timeMin);
  const tempArr = Float64Array.from(tempC);
  const segments = buildSegments(metadata.sampleName || fileName, tempArr, timeArr, [
    { start: 0, end: timeArr.length, label: "Run" },
  ]);
  const run: ParsedDscRun = {
    label: metadata.sampleName || fileName.replace(/\.[^.]+$/, ""),
    meta: metadata,
    segments,
    timeMin: timeArr,
    tempC: tempArr,
    heatFlowMw: Float64Array.from(heatFlowMw),
    ...(heatFlowNorm.length === timeMin.length && heatFlowNorm.length > 0
      ? { heatFlowNormFile: Float64Array.from(heatFlowNorm) }
      : {}),
  };
  return { fileName, runs: [run], warnings };
}
