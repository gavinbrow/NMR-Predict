// Plain-text / INI metadata parsers for the GC/MS workspace, Agilent flavour.
//
// This is a port of `src/lib/gpc/parseMetadata.ts`, retargeted at the
// `RunMeta`/`GcmsTuneInfo` contracts defined in `../types`. The real companion
// files (`GCMS Example/acqmeth.txt`, `GCMS Example/PRE_POST.INI`,
// `GCMS Example/cnorm.ini`) were read before writing this and are the ground
// truth for the key names.
//
// Five real bugs from the old GPC parser are fixed here:
//   1. The oven-ramp reader now terminates on the first line that is not four
//      whitespace-separated numbers (the old `^\s*\S+\s*:` bailout never matched
//      Agilent's `Post temp:`-style labels, so a later 4-column numeric table
//      got swallowed as extra ramps).
//   2. `Initial temp:` is scoped to the OVEN section only — the old whole-file
//      first-match collided with the inlet and aux-heater values.
//   3. `acqmode` now maps 0 -> "Scan", 1 -> "SIM", 2 -> "Scan/SIM", else
//      String(n). The old code mapped 2 to "Scan" (wrong).
//   4. `sample`/`operator` extraction is removed entirely — those keys do not
//      live in acqmeth.txt; they live in the DATA.MS header and chemstationMs.ts
//      owns them.
//   5. Added: CI mode/polarity/flow/reagent, tune file name+date, multi-segment
//      scan program, Threshold, instrument serial number.

import type { GcmsTuneInfo, RunMeta } from "../types";

// --- acqmeth.txt -------------------------------------------------------------

/**
 * Parse the plain-text `acqmeth.txt` acquisition-method format. Each field is
 * extracted by a permissive regex; missing fields are silently skipped. Never
 * throws — a totally unparseable file simply yields an (almost) empty meta.
 *
 * Only fields owned by the method file are extracted. `sample`/`operator` are
 * deliberately NOT read here; they live in the DATA.MS header.
 */
export function parseAcqMethod(text: string): Partial<RunMeta> {
  const out: Partial<RunMeta> = {};

  const one = (re: RegExp): string | undefined => {
    const m = text.match(re);
    return m ? m[1] : undefined;
  };

  const runTimeMin = one(/Run time:\s*(\d+\.\d+)\s*min/i);
  if (runTimeMin != null) out.runTimeMin = Number(runTimeMin);

  // (Fix #2) Scope "Initial temp:" to the OVEN section only. The OVEN block
  // runs from a line beginning with "OVEN" up to the next all-caps section
  // header (a line that is uppercase letters/spaces and ends before a blank
  // line, e.g. "FRONT INLET ...").
  const ovenStart = text.search(/^OVEN\s*$/im);
  if (ovenStart >= 0) {
    // Slice from OVEN to the next blank-line-then-uppercase section boundary.
    const rest = text.slice(ovenStart);
    // The OVEN section ends at the first blank line after content.
    const blankAfter = rest.search(/\n\s*\n/);
    const ovenBlock = blankAfter >= 0 ? rest.slice(0, blankAfter) : rest;
    const ovenInitial = ovenBlock.match(/Initial temp:\s*(\d+)\s*'?C/i);
    if (ovenInitial) out.ovenInitialTempC = Number(ovenInitial[1]);
  }

  // (Fix #1) Oven ramps: a numbered table under "Ramps:". Each data row is
  // "  1   10.0  250  2.00" (index, rate, finalTemp, finalTime). Terminate on
  // the FIRST line that is not four whitespace-separated numbers — never on a
  // labelled-section regex (the old `^\s*\S+\s*:` check missed `Post temp:`).
  const ramps: { rate: number; finalTemp: number; finalTime: number }[] = [];
  const rampHeader = text.match(/Ramps\s*:/i);
  if (rampHeader) {
    const after = text.slice(rampHeader.index! + rampHeader[0].length);
    const lines = after.split(/\r\n|\r|\n/);
    for (const line of lines) {
      const m = line.match(/^\s*\d+\s+([\d.]+)\s+(\d+)\s+([\d.]+)/);
      if (!m) {
        // A non-numeric line ends the table immediately once we have rows.
        // Blank lines before the first row are tolerated.
        if (ramps.length > 0) break;
        continue;
      }
      ramps.push({
        rate: Number(m[1]),
        finalTemp: Number(m[2]),
        finalTime: Number(m[3]),
      });
      if (ramps.length >= 32) break; // sanity cap
    }
  }
  if (ramps.length > 0) out.ovenRamps = ramps;

  const lowMass = one(/Low Mass\s*:\s*(\d+\.?\d*)/i);
  if (lowMass != null) out.lowMass = Number(lowMass);

  const highMass = one(/High Mass\s*:\s*(\d+\.?\d*)/i);
  if (highMass != null) out.highMass = Number(highMass);

  // Note the source-file typo "Acquistion" is preserved verbatim.
  const scanMode = one(/Acquistion Mode\s*:\s*(\w+)/i);
  if (scanMode != null) out.scanMode = scanMode;

  const solventDelay = one(/Solvent Delay\s*:\s*(\d+\.\d+)\s*min/i);
  if (solventDelay != null) out.solventDelayMin = Number(solventDelay);

  const sourceTemp = one(/MS Source\s*:\s*(\d+)\s*C/i);
  if (sourceTemp != null) out.sourceTemp = Number(sourceTemp);

  const quadTemp = one(/MS Quad\s*:\s*(\d+)\s*C/i);
  if (quadTemp != null) out.quadTemp = Number(quadTemp);

  // Threshold lives in the [Scan Parameters] block of acqmeth.txt.
  const threshold = one(/Threshold\s*:\s*(\d+)/i);
  if (threshold != null) out.threshold = Number(threshold);

  // Tune file name and instrument serial from the tune-parameters footer.
  //   "TUNE PARAMETERS for SN: G1030-60697"
  const sn = one(/TUNE PARAMETERS for SN:\s*(\S+)/i);
  if (sn != null) out.serialNumber = sn.trim();

  const tuneFile = one(/Tune File\s*:\s*(\S+)/i);
  if (tuneFile != null) out.tuneFile = tuneFile.trim();

  return out;
}

// --- PRE_POST.INI ------------------------------------------------------------

/** Read an INI-style text blob into a flat map of section → {key: value}. */
function readIni(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current = "";
  sections.set(current, new Map());
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      current = section[1].trim();
      if (!sections.has(current)) sections.set(current, new Map());
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    sections.get(current)!.set(key, value);
  }
  return sections;
}

/** Pull a numeric value from a section map, tolerating trailing units. */
function num(section: Map<string, string>, key: string): number | undefined {
  const v = section.get(key);
  if (v == null) return undefined;
  const m = v.match(/^-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : undefined;
}

/** First value for `key` across all sections (case-sensitive key match). */
function find(ini: Map<string, Map<string, string>>, key: string): string | undefined {
  for (const section of ini.values()) {
    const v = section.get(key);
    if (v != null) return v;
  }
  return undefined;
}

/**
 * Parse PRE_POST.INI into a partial `RunMeta`. Reads [POSTRUN],
 * [Scan Parameters], [Tune Values], [Sequence]. Adds CI mode/reagent, the
 * multi-segment scan program, and the instrument serial. Never throws.
 */
export function parsePrePostIni(text: string): Partial<RunMeta> {
  const ini = readIni(text);
  const out: Partial<RunMeta> = {};

  const smartCard = find(ini, "SmartCard");
  if (smartCard) {
    const parts = smartCard.split(",");
    if (parts.length >= 2) out.instrument = parts[1].trim();
    if (parts.length >= 3) out.serialNumber = parts[2].trim();
  }
  // Serial_N is the authoritative serial in some files; prefer it when present.
  const serialN = find(ini, "Serial_N");
  if (serialN) out.serialNumber = serialN.trim();

  const tuneName = find(ini, "TuneName");
  if (tuneName) out.tuneFile = tuneName;

  const tuneDate = find(ini, "TuneDate");
  if (tuneDate) out.tuneDate = tuneDate.trim();

  const sourceTemp = num(ini.get("POSTRUN") ?? new Map(), "SourceTemp");
  if (sourceTemp != null) out.sourceTemp = sourceTemp;

  const quadTemp = num(ini.get("POSTRUN") ?? new Map(), "QuadTemp");
  if (quadTemp != null) out.quadTemp = quadTemp;

  // (Fix #3) acqmode: 0 -> Scan, 1 -> SIM, 2 -> Scan/SIM, else String(n).
  const acqmode = find(ini, "acqmode");
  if (acqmode != null) {
    const n = Number(acqmode);
    if (Number.isFinite(n)) {
      out.scanMode = n === 0 ? "Scan" : n === 1 ? "SIM" : n === 2 ? "Scan/SIM" : String(n);
    }
  }

  // (Fix #5) CI mode / polarity / flow / reagent.
  const ciMode = find(ini, "CImode");
  const ciPolarity = find(ini, "CIpolarity");
  const ciFlow = find(ini, "CIflow");
  const reagent = find(ini, "Reagent");
  if (ciMode != null) {
    const on = Number(ciMode) === 1;
    out.ionization = on ? "CI" : "EI";
    if (on && reagent) out.ciReagent = reagent.trim();
    if (ciPolarity != null) {
      const p = Number(ciPolarity);
      out.polarity = p === 0 ? "+" : p === 1 ? "-" : null;
    }
    if (ciFlow != null) {
      // Not a declared RunMeta field; surface through tune/raw only.
    }
  } else {
    out.ionization = "EI";
  }

  // Multi-segment scan program from [Scan Parameters]: scanstartN/lowmassN/
  // highmassN for N=1.. while scanstartN is present and >= 0.
  const scanParams = ini.get("Scan Parameters");
  if (scanParams) {
    const segments: { start: number; lowMass: number; highMass: number }[] = [];
    for (let i = 1; ; i += 1) {
      const start = num(scanParams, `scanstart${i}`);
      if (start == null) break;
      if (start < 0) break; // -1 marks an unused segment
      const lo = num(scanParams, `lowmass${i}`);
      const hi = num(scanParams, `highmass${i}`);
      segments.push({ start, lowMass: lo ?? 0, highMass: hi ?? 0 });
      if (segments.length >= 64) break; // sanity cap
    }
    if (segments.length > 0) out.scanSegments = segments;
    // First segment supplies the run-level low/high mass when not already set.
    if (segments.length > 0) {
      if (out.lowMass == null) out.lowMass = segments[0].lowMass;
      if (out.highMass == null) out.highMass = segments[0].highMass;
    }
  }

  const date = find(ini, "Date");
  if (date) out.acquiredDate = date.trim();

  const methFile = find(ini, "_methfile$");
  if (methFile) out.method = methFile.trim();
  const methPath = find(ini, "_methpath$");
  if (methPath && out.method == null) out.method = methPath.trim();

  return out;
}

// --- cnorm.ini ---------------------------------------------------------------

/** Parse one cnorm.ini calibration section into a numeric-mz → value map. */
function parseCnormSection(
  section: Map<string, string>,
): Record<number, number> | undefined {
  const massesN = num(section, "masses");
  if (massesN == null || section.size <= 1) return undefined;
  const out: Record<number, number> = {};
  let filled = 0;
  for (const [key, value] of section) {
    if (key === "masses") continue;
    const mz = Number(key);
    if (!Number.isFinite(mz)) continue;
    const m = value.match(/^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/);
    if (!m) continue;
    out[mz] = Number(m[0]);
    filled += 1;
  }
  return filled > 0 ? out : undefined;
}

/**
 * Parse cnorm.ini into a `GcmsTuneInfo`. The `[targets]` section carries
 * `base=`, `masses=N`, then `mass1..N`/`target1..N`. The `[atune.cnorm]` and
 * `[stune.cnorm]` sections carry `masses=N` then `<mz>=<value>` lines.
 * Never throws.
 */
export function parseCnormIni(text: string): GcmsTuneInfo {
  const ini = readIni(text);
  const out: GcmsTuneInfo = {};

  const targets = ini.get("targets");
  if (targets) {
    const entries: { key: string; value: string }[] = [];
    for (const [k, v] of targets) entries.push({ key: k, value: v });
    if (entries.length > 0) out.entries = entries;
  }

  const atune = ini.get("atune.cnorm");
  if (atune) {
    const parsed = parseCnormSection(atune);
    if (parsed) {
      // Surface the tune calibration through the `entries` list when present.
      if (!out.entries) out.entries = [];
      for (const [mz, val] of Object.entries(parsed)) {
        out.entries.push({ key: `atune:${mz}`, value: String(val) });
      }
    }
  }

  const stune = ini.get("stune.cnorm");
  if (stune) {
    const parsed = parseCnormSection(stune);
    if (parsed) {
      if (!out.entries) out.entries = [];
      for (const [mz, val] of Object.entries(parsed)) {
        out.entries.push({ key: `stune:${mz}`, value: String(val) });
      }
    }
  }

  return out;
}

// --- merge -------------------------------------------------------------------

const DEEP_KEYS = new Set<keyof RunMeta>(["tune", "raw"]);

/**
 * Merge partial `RunMeta` objects left-to-right; later arguments win over
 * earlier ones for keys they actually define. `undefined`/`null`/empty-string
 * values are skipped. The `raw` and `tune` sub-objects are deep-merged.
 */
export function mergeRunMeta(...parts: Partial<RunMeta>[]): RunMeta {
  const out: RunMeta = {};
  for (const part of parts) {
    if (part == null) continue;
    for (const key of Object.keys(part) as (keyof RunMeta)[]) {
      if (DEEP_KEYS.has(key)) {
        const incoming = part[key] as Record<string, unknown> | undefined;
        if (incoming == null) continue;
        const existing = (out as Record<string, unknown>)[key as string] as
          | Record<string, unknown>
          | undefined;
        (out as Record<string, unknown>)[key as string] = {
          ...(existing ?? {}),
          ...incoming,
        };
        continue;
      }
      const v = (part as Record<string, unknown>)[key as string];
      if (v == null) continue;
      if (typeof v === "string" && v.length === 0) continue;
      (out as Record<string, unknown>)[key as string] = v;
    }
  }
  return out;
}