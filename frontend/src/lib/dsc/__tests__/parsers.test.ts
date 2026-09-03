// Pure unit tests for the DSC parsers with small inline fixtures (no real
// files — those live in `parse.realfile.test.ts`). Each parser is pure over a
// byte buffer / cell grid, so these build the input in-test. Mirrors
// `lib/tga/__tests__/parsers.test.ts`'s style.

import { describe, expect, it } from "vitest";
import type { SheetGrid } from "@/lib/tensile/parse";
import {
  buildTriosDscMetadata,
  deriveTriSegmentLabels,
  isFlagArray,
  parseTriosTri,
  trimTrailingZeroRun,
  walkBlockSignals,
} from "../parse/triosTri";
import {
  buildTriosXlsDscMetadata,
  detectBlocks,
  extractBlock,
  parseTriosSheets,
  readDscDetails,
} from "../parse/triosXls";
import {
  autoDetectColumnMap,
  extractGenericGrid,
  parseCsvText,
  parseGenericGrid,
  sniffDelimiter,
} from "../parse/genericTable";
import { parseTaText } from "../parse/taText";
import { findDataStart, parseTaBinary } from "../parse/taBinary";
import {
  normalizeDecimalComma,
  parseMettlerText,
  parseNetzschText,
  parsePerkinElmerText,
  sniffVendorText,
} from "../parse/vendorText";

// --- byte-buffer builders shared by the triosTri/taBinary sections --------

function u32le(n: number): number[] {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return Array.from(b);
}
function f32le(n: number): number[] {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, n, true);
  return Array.from(b);
}
function asciiBytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}
/** One `[lenByte, ...keyBytes, lenByte, ...valueBytes]` header entry, in the
 *  length-prefixed convention `parseTriosHeader` scans for. */
function headerEntry(key: string, value: string): number[] {
  const k = asciiBytes(key);
  const v = asciiBytes(value);
  return [k.length, ...k, v.length, ...v];
}
function floatBuffer(values: number[]): { bytes: Uint8Array; dv: DataView } {
  const bytes = Uint8Array.from(values.flatMap((v) => f32le(v)));
  return { bytes, dv: new DataView(bytes.buffer) };
}

// =====================================================================
// triosTri
// =====================================================================

describe("triosTri isFlagArray", () => {
  it("flags an array of zeros with at least one denormal-magnitude value", () => {
    const { dv } = floatBuffer([0, 1e-30, 0, 0, 3e-28]);
    expect(isFlagArray(dv, 0, 5)).toBe(true);
  });

  it("does NOT flag an all-zero array — no denormals means a genuine zero signal", () => {
    const { dv } = floatBuffer([0, 0, 0, 0]);
    expect(isFlagArray(dv, 0, 4)).toBe(false);
  });

  it("does NOT flag a real signal array containing an ordinary non-zero value", () => {
    const { dv } = floatBuffer([0, 1, 2, 3]);
    expect(isFlagArray(dv, 0, 4)).toBe(false);
  });
});

describe("triosTri walkBlockSignals", () => {
  // N = 30 (not a smaller round number) is deliberate: real arrays are tens
  // of thousands of samples, so the `CLUSTER_COLLAPSE_WINDOW` (64 bytes) used
  // to collapse a signal's duplicated marker (see `findNextMarker`'s doc
  // comment) never reaches into the NEXT array's own marker. A too-small N
  // here would make this fixture accidentally collapse past a real signal.
  it("skips an interleaved flag array and keeps the ordinal mapping onto the 3 kept arrays", () => {
    const N = 30;
    const bytes: number[] = [];
    // Time array (no leading marker needed — its start/length is already
    // known from `findNextBlock`, exactly as `parseTriosTri` calls this).
    for (let k = 0; k < N; k++) bytes.push(...f32le(k));
    // 10-byte gap, then the flag array's universal marker + data.
    bytes.push(...new Array(10).fill(0));
    bytes.push(0x01, 0x00, ...u32le(N));
    bytes.push(...f32le(1e-30));
    for (let k = 1; k < N; k++) bytes.push(...f32le(0));
    // gap + Temperature marker + data
    bytes.push(...new Array(10).fill(0));
    bytes.push(0x01, 0x00, ...u32le(N));
    for (let k = 0; k < N; k++) bytes.push(...f32le(20 + k * 2));
    // gap + Heat Flow marker + data
    bytes.push(...new Array(10).fill(0));
    bytes.push(0x01, 0x00, ...u32le(N));
    for (let k = 0; k < N; k++) bytes.push(...f32le(0.0005 + k * 0.00002));

    const buf = Uint8Array.from(bytes);
    const dv = new DataView(buf.buffer);
    const { arrays, endOffset } = walkBlockSignals(dv, buf, 0, N, 3);

    // 3 kept arrays, in ordinal order — the flag array does not appear and
    // does not shift Temperature/Heat Flow's position.
    expect(arrays).toHaveLength(3);
    expect(Array.from(arrays[0])).toEqual(Array.from({ length: N }, (_, k) => k));
    expect(arrays[1][0]).toBeCloseTo(20, 4);
    expect(arrays[1][N - 1]).toBeCloseTo(20 + (N - 1) * 2, 4);
    expect(arrays[2][0]).toBeCloseTo(0.0005, 6);
    expect(arrays[2][N - 1]).toBeCloseTo(0.0005 + (N - 1) * 0.00002, 6);
    expect(endOffset).toBe(buf.length);
  });

  it("collapses a duplicated same-length marker down to the one immediately followed by real data", () => {
    // Mirrors the real `DAC1.tri` pattern (see `findNextMarker`'s doc
    // comment): a second identical `01 00 <N>` marker sits a few bytes after
    // the first, with a small non-float descriptor sandwiched between them.
    // Only the array read from the SECOND marker's position is coherent.
    const N = 30;
    const bytes: number[] = [];
    for (let k = 0; k < N; k++) bytes.push(...f32le(k)); // Time
    bytes.push(...new Array(10).fill(0));
    bytes.push(0x01, 0x00, ...u32le(N)); // 1st (duplicate) marker
    bytes.push(1, 0x10, 0x21, 0x01, 0x04, 0, 0, 0, 0, 0, 0, 0); // non-float descriptor filler
    bytes.push(0x01, 0x00, ...u32le(N)); // 2nd (real) marker
    for (let k = 0; k < N; k++) bytes.push(...f32le(20 + k * 2)); // Temperature

    const buf = Uint8Array.from(bytes);
    const dv = new DataView(buf.buffer);
    const { arrays } = walkBlockSignals(dv, buf, 0, N, 2);
    expect(arrays).toHaveLength(2);
    expect(arrays[1][0]).toBeCloseTo(20, 4);
    expect(arrays[1][N - 1]).toBeCloseTo(20 + (N - 1) * 2, 4);
  });
});

describe("triosTri trimTrailingZeroRun", () => {
  it("drops the trailing run of exact zeros", () => {
    expect(trimTrailingZeroRun(Float64Array.from([1, 2, 3, 0, 0, 0]))).toBe(3);
  });
  it("keeps everything when there's no trailing zero run", () => {
    expect(trimTrailingZeroRun(Float64Array.from([1, 2, 3]))).toBe(3);
  });
  it("returns 0 for an all-zero array", () => {
    expect(trimTrailingZeroRun(Float64Array.from([0, 0, 0]))).toBe(0);
  });
});

describe("triosTri deriveTriSegmentLabels", () => {
  it("keeps only Ramp/Isothermal entries between a Data On and the next Data Off", () => {
    const steps = [
      "Data Off",
      "Equilibrate 0.00 °C",
      "Isothermal 5.0 min",
      "Data On",
      "Ramp 10.00 °C/min to 280.00 °C",
      "Data Off",
      "Equilibrate 280.00 °C",
      "Isothermal 5.0 min",
      "Data On",
      "Ramp 10.00 °C/min to 0.00 °C",
      "Data Off",
    ];
    expect(deriveTriSegmentLabels(steps)).toEqual([
      "Ramp 10.00 °C/min to 280.00 °C",
      "Ramp 10.00 °C/min to 0.00 °C",
    ]);
  });

  it("returns an empty list when nothing falls inside a Data On/Off window", () => {
    expect(deriveTriSegmentLabels(["Ramp 10.00 °C/min to 280.00 °C"])).toEqual([]);
  });
});

describe("triosTri buildTriosDscMetadata", () => {
  it("reads samplesize as milligrams directly — NOT ×1e6 (that's TGA's kilogram convention)", () => {
    const meta = buildTriosDscMetadata(
      { samplesize: "4.4", instrumenttype: "DSC25", samplename: "DAC1" },
      "DAC1.tri",
    );
    expect(meta.sampleMassMg).toBe(4.4);
    expect(meta.instrument).toBe("DSC25");
    expect(meta.exoDirection).toBe("up");
  });
});

describe("triosTri parseTriosTri (synthetic buffer)", () => {
  /** Build a minimal but complete `.tri` buffer: header, a fake PNG span, and
   *  one procedure-segment block (Time + an interleaved flag array +
   *  Temperature + Heat Flow), all via the real length-prefixed header
   *  convention and the real `01 00 <N>` array marker. */
  function buildFakeTriBuffer(): Uint8Array {
    const bytes: number[] = [];
    bytes.push(...headerEntry("instrumenttype", "DSC25"));
    bytes.push(...headerEntry("samplename", "TestSample"));
    bytes.push(...headerEntry("samplesize", "4.4"));
    bytes.push(...headerEntry("proceduresegments", "Data On;Ramp 10.00 C/min to 100.00 C;Data Off"));
    bytes.push(...headerEntry("proceduresignals", "Time;Temperature;Heat Flow"));

    // Fake PNG span: signature, a little filler, then IEND + CRC.
    bytes.push(0x89, 0x50, 0x4e, 0x47);
    bytes.push(0, 0, 0, 0);
    bytes.push(0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0);

    // Block: Time's dual-count descriptor (findNextBlock's marker) — N=30,
    // the minimum `findNextBlock` accepts.
    const N = 30;
    bytes.push(...u32le(N)); // count at p
    bytes.push(...new Array(14).fill(0));
    bytes.push(...u32le(N)); // count at start-4
    for (let k = 0; k < N; k++) bytes.push(...f32le(k)); // Time 0..29 (seconds)

    // gap + flag array (interleaved) — must be skipped
    bytes.push(...new Array(10).fill(0));
    bytes.push(0x01, 0x00, ...u32le(N));
    bytes.push(...f32le(1e-30));
    for (let k = 1; k < N; k++) bytes.push(...f32le(0));

    // gap + Temperature
    bytes.push(...new Array(10).fill(0));
    bytes.push(0x01, 0x00, ...u32le(N));
    for (let k = 0; k < N; k++) bytes.push(...f32le(20 + k * 2)); // 20..78 °C

    // gap + Heat Flow (watts, no zeros so the trailing-zero trim is a no-op)
    bytes.push(...new Array(10).fill(0));
    bytes.push(0x01, 0x00, ...u32le(N));
    for (let k = 0; k < N; k++) bytes.push(...f32le(0.0005 + k * 0.00002));

    return Uint8Array.from(bytes);
  }

  it("wires the header + PNG span + marker walk + flag skip into one run", () => {
    const buf = buildFakeTriBuffer();
    const result = parseTriosTri(buf.buffer, "fake.tri");
    expect(result.runs).toHaveLength(1);
    const run = result.runs[0];

    // mg, not kg — a ×1e6 bug would show 4 400 000.
    expect(run.meta.sampleMassMg).toBe(4.4);
    expect(run.meta.sampleName).toBe("TestSample");

    // Exactly 1 segment, its label paired 1:1 from proceduresegments, not a
    // positional fallback.
    expect(run.segments).toHaveLength(1);
    expect(run.segments[0].label).toBe("Ramp 10.00 C/min to 100.00 C");
    expect(run.segments[0].kind).toBe("heat");
    expect(result.warnings.some((w) => w.includes("positional"))).toBe(false);

    // The flag array did not leak into the kept arrays or shift the mapping:
    // Temperature and Heat Flow both read correctly.
    expect(run.timeMin.length).toBe(30);
    expect(run.timeMin[0]).toBeCloseTo(0, 6);
    expect(run.timeMin[29]).toBeCloseTo(29 / 60, 6); // seconds → minutes
    expect(run.tempC[0]).toBeCloseTo(20, 3);
    expect(run.tempC[29]).toBeCloseTo(78, 3);
    // watts → milliwatts (×1000)
    expect(run.heatFlowMw[0]).toBeCloseTo(0.5, 2);
    expect(run.heatFlowMw[29]).toBeCloseTo(0.5 + 29 * 0.02, 2);
  });

  it("falls back to positional segment labels when the label count doesn't match the block count", () => {
    // Same buffer, but with a proceduresegments string that yields 0 labels
    // (no Data On/Off window) for the file's 1 real block.
    const bytes: number[] = [];
    bytes.push(...headerEntry("instrumenttype", "DSC25"));
    bytes.push(...headerEntry("samplename", "Mismatch"));
    bytes.push(...headerEntry("samplesize", "1.0"));
    bytes.push(...headerEntry("proceduresegments", "Ramp 10.00 C/min to 100.00 C")); // no Data On/Off at all
    bytes.push(...headerEntry("proceduresignals", "Time;Temperature;Heat Flow"));
    bytes.push(0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0);
    const N = 30;
    bytes.push(...u32le(N));
    bytes.push(...new Array(14).fill(0));
    bytes.push(...u32le(N));
    for (let k = 0; k < N; k++) bytes.push(...f32le(k));
    bytes.push(...new Array(10).fill(0));
    bytes.push(0x01, 0x00, ...u32le(N));
    for (let k = 0; k < N; k++) bytes.push(...f32le(20 + k * 2));
    bytes.push(...new Array(10).fill(0));
    bytes.push(0x01, 0x00, ...u32le(N));
    for (let k = 0; k < N; k++) bytes.push(...f32le(0.0005 + k * 0.00002));
    const buf = Uint8Array.from(bytes);

    const result = parseTriosTri(buf.buffer, "mismatch.tri");
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].segments[0].label).toBe("Segment 1");
    expect(result.warnings.some((w) => w.includes("positional labels"))).toBe(true);
  });

  it("never throws on a garbage buffer — returns a warning and no runs", () => {
    const garbage = new Uint8Array(64).fill(0xab);
    const result = parseTriosTri(garbage.buffer, "garbage.tri");
    expect(result.runs).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// =====================================================================
// triosXls
// =====================================================================

describe("triosXls readDscDetails", () => {
  function detailsSheet(): SheetGrid {
    return {
      name: "Details",
      rows: [
        ["Filename", "1-2 S1.tri"],
        ["Instrument name", "DSC25 Discovery"],
        ["Operator", "Josh K"],
        ["rundate", "9/2/2026"],
        ["Sample name", "1-2 S1"],
        ["proceduresegments", "Data On;Ramp 10.00 C/min to 280.00 C;Data Off"],
        ["[Procedure]"],
        ["Procedure Name", "Custom"],
        ["Sample Name", "1-2 S1"],
        ["Sample Mass", "11.69 mg"],
        ["Pan Mass", "0 mg"],
        ["Pan Type", "Tzero Aluminum Hermetic"],
        ["[Configuration]"],
        ["Instrument Type", "DSC25"],
        ["Sample Interval ", "0.1 s/pt"], // note the trailing space in the raw key
        ["Exotherm Direction", "Up"],
        ["Cooler", "RCS 90"],
        ["Flow Rate", "50 mL/min"],
        ["[T1 Calibration]"],
        ["Gas Type", "Nitrogen"],
        ["[Cell Constant Calibration]"],
        ["Onset Slope", "-23.63117 mW/°C"],
      ],
    };
  }

  it("splits top-level keys from section-keyed ones", () => {
    const details = readDscDetails([detailsSheet()]);
    expect(details.top["Sample name"]).toBe("1-2 S1");
    expect(details.top["proceduresegments"]).toBe("Data On;Ramp 10.00 C/min to 280.00 C;Data Off");
    expect(details.sections["Procedure"]["Sample Mass"]).toBe("11.69 mg");
    expect(details.sections["Configuration"]["Exotherm Direction"]).toBe("Up");
    expect(details.sections["Cell Constant Calibration"]["Onset Slope"]).toBe("-23.63117 mW/°C");
  });

  it("normalises the raw file's trailing-space key so lookups don't need it", () => {
    const details = readDscDetails([detailsSheet()]);
    expect(details.sections["Configuration"]["Sample Interval"]).toBe("0.1 s/pt");
    expect(details.sections["Configuration"]["Sample Interval "]).toBeUndefined();
  });

  it("returns empty maps when there's no Details sheet", () => {
    const details = readDscDetails([{ name: "Other", rows: [["a", "b"]] }]);
    expect(details.top).toEqual({});
    expect(details.sections).toEqual({});
  });
});

describe("triosXls buildTriosXlsDscMetadata", () => {
  it("parses sample mass/pan mass with units and reads the exotherm direction", () => {
    const details = readDscDetails([
      {
        name: "Details",
        rows: [
          ["Sample name", "1-2 S1"],
          ["Operator", "Josh K"],
          ["proceduresegments", "Data On;Ramp 10.00 C/min to 280.00 C;Data Off"],
          ["[Procedure]"],
          ["Sample Mass", "11.69 mg"],
          ["Pan Mass", "0 mg"],
          ["Pan Type", "Tzero Aluminum Hermetic"],
          ["[Configuration]"],
          ["Instrument Type", "DSC25"],
          ["Exotherm Direction", "Up"],
          ["Cooler", "RCS 90"],
          ["Flow Rate", "50 mL/min"],
          ["[T1 Calibration]"],
          ["Gas Type", "Nitrogen"],
        ],
      },
    ]);
    const meta = buildTriosXlsDscMetadata(details, "1-2 S1.xls");
    expect(meta.sampleMassMg).toBeCloseTo(11.69, 5);
    expect(meta.panMassMg).toBe(0);
    expect(meta.pan).toBe("Tzero Aluminum Hermetic");
    expect(meta.exoDirection).toBe("up");
    expect(meta.gases).toBe("Nitrogen, 50 mL/min");
    expect(meta.instrument).toBe("DSC25");
  });
});

describe("triosXls detectBlocks + extractBlock", () => {
  function segmentSheet(): SheetGrid {
    return {
      name: "Ramp 10.00 Cmin to 280.00 C",
      rows: [
        ["Ramp 10.00 °C/min to 280.00 °C", "", "", ""],
        ["", "Time", "Temperature", "Heat Flow (Normalized)"],
        ["", "min", "°C", "W/g"],
        ["", 0, 20, 0.05],
        ["", 0, 20, 0.05], // duplicated header rows, as TRIOS exports
        ["", 0, 20, 0.05],
        ["", 1, 30, 0.06],
        ["", 2, 40, 0.07],
      ],
    };
  }

  it("finds the segment's title one column left of Time, and the Heat Flow (Normalized) column", () => {
    const blocks = detectBlocks(segmentSheet());
    expect(blocks).toHaveLength(1);
    expect(blocks[0].label).toBe("Ramp 10.00 °C/min to 280.00 °C");
    expect(blocks[0].timeCol).toBe(1);
    expect(blocks[0].tempCol).toBe(2);
    expect(blocks[0].heatFlowCol).toBe(-1); // no raw column in this export
    expect(blocks[0].heatFlowNormCol).toBe(3);
  });

  it("dedupes the repeated header rows and derives mW from Normalized × sample mass", () => {
    const grid = segmentSheet();
    const block = detectBlocks(grid)[0];
    const data = extractBlock(grid, block, 3, 11.69);
    expect(data.timeMin.length).toBe(3); // the three duplicated t=0 rows collapse to one
    expect(Array.from(data.timeMin)).toEqual([0, 1, 2]);
    expect(data.heatFlowNormFile![0]).toBeCloseTo(0.05, 5);
    // W/g × mg = mW.
    expect(data.heatFlowMw[0]).toBeCloseTo(0.05 * 11.69, 5);
    expect(data.heatFlowMw[2]).toBeCloseTo(0.07 * 11.69, 5);
  });

  it("leaves heatFlowMw NaN when no sample mass is known", () => {
    const grid = segmentSheet();
    const block = detectBlocks(grid)[0];
    const data = extractBlock(grid, block, 3, null);
    expect(Number.isNaN(data.heatFlowMw[0])).toBe(true);
    expect(data.heatFlowNormFile![0]).toBeCloseTo(0.05, 5);
  });

  // Regression for a real-file bug: TRIOS exports Time rounded to 2 dp
  // (minutes). At a 0.1 s/pt interval several consecutive REAL samples
  // print the same rounded Time before it ticks over — verified on
  // `1-2 S1.xls`'s first ramp sheet, where a naive "reject any
  // non-increasing Time" dedupe discarded ~5 of every 6 genuine rows
  // (16801 raw rows, only 2801 survived). Only an EXACT repeat of the
  // previous row (every column identical) is a duplicate; distinct
  // payloads sharing a displayed Time must both be kept.
  it("keeps distinct rows that merely round to the same displayed Time", () => {
    const grid: SheetGrid = {
      name: "Ramp",
      rows: [
        ["Ramp 10.00 °C/min to 280.00 °C", "", "", ""],
        ["", "Time", "Temperature", "Heat Flow (Normalized)"],
        ["", "min", "°C", "W/g"],
        ["", 4.66, 44.98, -0.254],
        ["", 4.66, 45.0, -0.254], // same displayed Time, a real distinct sample
        ["", 4.66, 45.01, -0.254],
        ["", 4.67, 45.03, -0.254],
      ],
    };
    const block = detectBlocks(grid)[0];
    const data = extractBlock(grid, block, 3, 11.69);
    expect(data.timeMin.length).toBe(4); // nothing dropped — none of these rows repeat exactly
    expect(Array.from(data.tempC)).toEqual([44.98, 45.0, 45.01, 45.03]);
  });

  // Regression: the tail of a TRIOS Excel block leaves Temperature (and
  // Heat Flow) blank rather than zero-filled — unlike the `.tri`
  // container's trailing zero pad (§2.1) — while Time keeps incrementing.
  // Left unhandled, that blank becomes a NaN sample at the segment's very
  // last index, which broke `classifySegment` (it reads `tempC[end - 1]`)
  // and made every segment in the run misclassify as "cool" with a NaN
  // rate.
  it("trims a trailing row whose Temperature is blank", () => {
    const grid: SheetGrid = {
      name: "Ramp",
      rows: [
        ["Ramp 10.00 °C/min to 280.00 °C", "", "", ""],
        ["", "Time", "Temperature", "Heat Flow (Normalized)"],
        ["", "min", "°C", "W/g"],
        ["", 0, 20, 0.05],
        ["", 1, 30, 0.06],
        ["", 2, 40, 0.07],
        ["", 2.1, null, null], // trailing blank pad
        ["", 2.2, null, null],
      ],
    };
    const block = detectBlocks(grid)[0];
    const data = extractBlock(grid, block, 3, 11.69);
    expect(data.timeMin.length).toBe(3);
    expect(Array.from(data.tempC)).toEqual([20, 30, 40]);
    expect(Array.from(data.tempC).every((t) => Number.isFinite(t))).toBe(true);
  });
});

describe("triosXls parseTriosSheets", () => {
  it("merges every segment sheet into one run and warns once about the 3 dp rounding", () => {
    const details: SheetGrid = {
      name: "Details",
      rows: [
        ["Sample name", "1-2 S1"],
        ["proceduresegments", "Data On;Ramp;Data Off"],
        ["[Procedure]"],
        ["Sample Mass", "11.69 mg"],
        ["[Configuration]"],
        ["Exotherm Direction", "Up"],
      ],
    };
    const seg1: SheetGrid = {
      name: "Ramp 10.00 Cmin to 280.00 C",
      rows: [
        ["Ramp 10.00 °C/min to 280.00 °C"],
        ["", "Time", "Temperature", "Heat Flow (Normalized)"],
        ["", "min", "°C", "W/g"],
        ["", 0, 20, 0.05],
        ["", 1, 30, 0.06],
      ],
    };
    const seg2: SheetGrid = {
      name: "Ramp 10.00 Cmin to 0.00 C",
      rows: [
        ["Ramp 10.00 °C/min to 0.00 °C"],
        ["", "Time", "Temperature", "Heat Flow (Normalized)"],
        ["", "min", "°C", "W/g"],
        ["", 2, 29, 0.02],
        ["", 3, 20, 0.01],
      ],
    };
    const result = parseTriosSheets([details, seg1, seg2], "1-2 S1.xls");
    expect(result.runs).toHaveLength(1);
    const run = result.runs[0];
    expect(run.segments).toHaveLength(2);
    expect(run.segments[0].label).toBe("Ramp 10.00 °C/min to 280.00 °C");
    expect(run.segments[1].label).toBe("Ramp 10.00 °C/min to 0.00 °C");
    expect(run.timeMin.length).toBe(4);
    expect(run.meta.sampleMassMg).toBeCloseTo(11.69, 5);
    expect(run.meta.exoDirection).toBe("up");
    expect(result.warnings.some((w) => w.includes("3 decimal"))).toBe(true);
  });

  it("never throws when there are no usable segment sheets", () => {
    const result = parseTriosSheets([{ name: "Details", rows: [["a", "b"]] }], "empty.xls");
    expect(result.runs).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// =====================================================================
// genericTable
// =====================================================================

describe("genericTable autoDetectColumnMap", () => {
  it("auto-detects Time/Temperature/HeatFlow from header text", () => {
    const grid: SheetGrid = {
      name: "data.csv",
      rows: [
        ["Time (min)", "Temperature (°C)", "Heat Flow (mW)"],
        [0, 25, 0.5],
        [1, 35, 0.6],
      ],
    };
    const map = autoDetectColumnMap(grid);
    expect(map).not.toBeNull();
    expect(map).toMatchObject({
      time: 0,
      timeUnit: "min",
      temperature: 1,
      tempUnit: "C",
      heatFlow: 2,
      heatFlowUnit: "mW",
      headerRow: 0,
      firstDataRow: 1,
    });
  });

  it("falls back to a normalized W/g column and skips a µV column as unsupported", () => {
    const grid: SheetGrid = {
      name: "x",
      rows: [
        ["Time (min)", "Temperature (K)", "Value (µV)", "DSC (W/g)"],
        [0, 298.15, 12, 0.05],
      ],
    };
    const map = autoDetectColumnMap(grid);
    expect(map).not.toBeNull();
    expect(map!.tempUnit).toBe("K");
    expect(map!.heatFlow).toBe(3); // the W/g column, not the µV one
    expect(map!.heatFlowUnit).toBe("W/g");
  });

  it("returns null when the only heat-flow-like column is µV", () => {
    const grid: SheetGrid = {
      name: "x",
      rows: [
        ["Time (min)", "Temperature (°C)", "Value (µV)"],
        [0, 25, 12],
        [1, 35, 14],
      ],
    };
    expect(autoDetectColumnMap(grid)).toBeNull();
  });

  it("detects a seconds time column and a Watts heat-flow column", () => {
    const grid: SheetGrid = {
      name: "x",
      rows: [
        ["Time (s)", "Temp (K)", "Heat Flow (W)"],
        [60, 298.15, 0.0005],
      ],
    };
    const map = autoDetectColumnMap(grid)!;
    expect(map.timeUnit).toBe("s");
    expect(map.heatFlowUnit).toBe("W");
  });
});

describe("genericTable extractGenericGrid", () => {
  it("converts K→°C, s→min and W→mW", () => {
    const grid: SheetGrid = {
      name: "x",
      rows: [
        ["Time (s)", "Temp (K)", "Heat Flow (W)"],
        [60, 298.15, 0.0005],
        [120, 308.15, 0.0006],
      ],
    };
    const map = autoDetectColumnMap(grid)!;
    const data = extractGenericGrid(grid, map, null);
    expect(data.timeMin[0]).toBeCloseTo(1, 5); // 60 s → 1 min
    expect(data.tempC[0]).toBeCloseTo(25, 2); // 298.15 K → 25 °C
    expect(data.heatFlowMw[0]).toBeCloseTo(0.5, 5); // 0.0005 W → 0.5 mW
  });

  it("derives mW from a normalized column when a sample mass is supplied", () => {
    const grid: SheetGrid = {
      name: "x",
      rows: [
        ["Time (min)", "Temperature (°C)", "DSC (W/g)"],
        [0, 20, 0.05],
      ],
    };
    const map = autoDetectColumnMap(grid)!;
    const data = extractGenericGrid(grid, map, 10);
    expect(data.heatFlowNormFile![0]).toBeCloseTo(0.05, 5);
    expect(data.heatFlowMw[0]).toBeCloseTo(0.5, 5); // 0.05 W/g × 10 mg
  });
});

describe("genericTable parseGenericGrid", () => {
  it("produces one run with a single synthesized, classified segment", () => {
    const grid: SheetGrid = {
      name: "x",
      rows: [
        ["Time (min)", "Temperature (°C)", "Heat Flow (mW)"],
        [0, 20, 0.1],
        [1, 30, 0.2],
        [2, 40, 0.3],
      ],
    };
    const map = autoDetectColumnMap(grid)!;
    const result = parseGenericGrid(grid, "my sample.csv", map, null);
    expect(result.warnings).toEqual([]);
    expect(result.runs).toHaveLength(1);
    const run = result.runs[0];
    expect(run.segments).toHaveLength(1);
    expect(run.segments[0].kind).toBe("heat");
    expect(run.label).toBe("my sample");
  });
});

describe("genericTable delimiter + CSV helpers", () => {
  it("sniffs the delimiter of a CSV/semicolon/TSV line", () => {
    expect(sniffDelimiter("a,b,c\n1,2,3")).toBe(",");
    expect(sniffDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(sniffDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
  });

  it("parseCsvText splits on the sniffed delimiter", () => {
    const grid = parseCsvText("Time,Temp,Heat Flow\n0,20,0.1\n1,30,0.2\n", "x.csv");
    expect(grid.rows[0]).toEqual(["Time", "Temp", "Heat Flow"]);
    expect(grid.rows[1]).toEqual(["0", "20", "0.1"]);
  });
});

// =====================================================================
// taText (DSC)
// =====================================================================

function utf16leBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    bytes[2 + i * 2] = text.charCodeAt(i) & 0xff;
    bytes[2 + i * 2 + 1] = (text.charCodeAt(i) >> 8) & 0xff;
  }
  return bytes;
}

describe("taText parseTaText (DSC)", () => {
  it("maps Sig1..SigN by name into Time/Temperature/Heat Flow", () => {
    const header = [
      "Version\t2.0",
      "Sample\tTest DSC sample",
      "Instrument\tQ2000",
      "Nsig\t3",
      "Sig1\tTime (min)",
      "Sig2\tTemperature (°C)",
      "Sig3\tHeat Flow (mW)",
      "StartOfData",
    ];
    const data = ["0.5\t20.0\t0.10", "1.0\t30.0\t0.20", "1.5\t40.0\t0.30"];
    const text = [...header, ...data].join("\r\n") + "\r\n";
    const result = parseTaText(utf16leBytes(text), "test.txt");
    expect(result.warnings).toEqual([]);
    expect(result.runs).toHaveLength(1);
    const run = result.runs[0];
    expect(run.timeMin.length).toBe(3);
    expect(run.heatFlowMw[0]).toBeCloseTo(0.1, 5);
    expect(run.meta.sampleName).toBe("Test DSC sample");
    expect(run.segments).toHaveLength(1);
  });

  it("derives mW from a normalized-only Heat Flow (W/g) column when a mass is known", () => {
    const header = [
      "Sample\tX",
      "Size\t10.0\tmg",
      "Nsig\t3",
      "Sig1\tTime (min)",
      "Sig2\tTemperature (°C)",
      "Sig3\tHeat Flow (W/g)",
      "StartOfData",
    ];
    const data = ["0.5\t20.0\t0.05", "1.0\t30.0\t0.06"];
    const text = [...header, ...data].join("\r\n") + "\r\n";
    const result = parseTaText(utf16leBytes(text), "test2.txt");
    expect(result.runs).toHaveLength(1);
    const run = result.runs[0];
    expect(run.heatFlowNormFile).toBeDefined();
    expect(run.heatFlowNormFile![0]).toBeCloseTo(0.05, 5);
    expect(run.heatFlowMw[0]).toBeCloseTo(0.5, 5); // 0.05 W/g × 10 mg
  });

  it("never throws when there's no StartOfData marker", () => {
    const result = parseTaText(utf16leBytes("Version\t2.0\r\n"), "bad.txt");
    expect(result.runs).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// =====================================================================
// taBinary (DSC) — no real sample file; hand-built fixtures only
// =====================================================================

describe("taBinary findDataStart (width-aware)", () => {
  function buildTuples(width: number, tuples: number[][]): Uint8Array {
    const bytes = new Uint8Array(tuples.length * width * 4);
    const dv = new DataView(bytes.buffer);
    tuples.forEach((tuple, i) => tuple.forEach((v, k) => dv.setFloat32((i * width + k) * 4, v, true)));
    return bytes;
  }

  it("finds the start of 4 plausible ascending tuples at a non-triplet width", () => {
    const bytes = buildTuples(3, [
      [0, 20, 0.1],
      [1, 30, 0.2],
      [2, 40, 0.3],
      [3, 50, 0.4],
    ]);
    const dv = new DataView(bytes.buffer);
    expect(findDataStart(dv, bytes, 3, 0, 1, 2)).toBe(0);
  });

  it("skips leading garbage to find the run", () => {
    const garbage = new Uint8Array(20).fill(0xff);
    const good = buildTuples(3, [
      [0, 20, 0.1],
      [1, 30, 0.2],
      [2, 40, 0.3],
      [3, 50, 0.4],
    ]);
    const bytes = new Uint8Array(garbage.length + good.length);
    bytes.set(garbage, 0);
    bytes.set(good, garbage.length);
    const dv = new DataView(bytes.buffer);
    expect(findDataStart(dv, bytes, 3, 0, 1, 2)).toBe(garbage.length);
  });

  it("returns -1 when time never strictly ascends (no real data block)", () => {
    const bytes = new Uint8Array(3 * 4 * 4); // all zero
    const dv = new DataView(bytes.buffer);
    expect(findDataStart(dv, bytes, 3, 0, 1, 2)).toBe(-1);
  });
});

describe("taBinary parseTaBinary (DSC)", () => {
  it("reads the UTF-16LE header, then the binary tuples, stopping at -100", () => {
    const header = [
      "Sample\tBin sample",
      "Nsig\t3",
      "Sig1\tTime (min)",
      "Sig2\tTemperature (°C)",
      "Sig3\tHeat Flow (mW)",
      "StartOfData",
    ];
    const headerBytes = utf16leBytes(header.join("\r\n") + "\r\n");

    const tuples = [
      [0, 20, 0.1],
      [1, 30, 0.2],
      [2, 40, 0.3],
      [3, 50, 0.4],
      [-100, 0, 0], // terminator
      [5, 60, 0.5], // trailing garbage — ignored
    ];
    const dataBytes = new Uint8Array(tuples.length * 3 * 4);
    const dv = new DataView(dataBytes.buffer);
    tuples.forEach((tuple, i) => tuple.forEach((v, k) => dv.setFloat32((i * 3 + k) * 4, v, true)));

    const bytes = new Uint8Array(headerBytes.length + dataBytes.length);
    bytes.set(headerBytes, 0);
    bytes.set(dataBytes, headerBytes.length);

    const result = parseTaBinary(bytes.buffer, "test.001");
    expect(result.warnings).toEqual([]);
    expect(result.runs).toHaveLength(1);
    const run = result.runs[0];
    expect(run.timeMin.length).toBe(4); // stopped at the -100 terminator
    expect(run.heatFlowMw[0]).toBeCloseTo(0.1, 4);
    expect(run.meta.sampleName).toBe("Bin sample");
  });

  it("never throws on a garbage buffer", () => {
    const result = parseTaBinary(new Uint8Array(32).fill(0xcd).buffer, "garbage.001");
    expect(result.runs).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// =====================================================================
// vendorText — no real sample files for any of these three vendors
// =====================================================================

describe("vendorText sniffVendorText", () => {
  it("recognises a Netzsch Proteus ASCII export", () => {
    const text = [
      "#SAMPLE: Test",
      "#INSTRUMENT: DSC 214",
      "#TYPE OF CRUCIBLE: Al",
      "##Temp./°C;Time/min;DSC/(mW/mg)",
      "20,0;0,0;0,050",
    ].join("\n");
    expect(sniffVendorText(text)).toBe("netzsch");
  });

  it("recognises a PerkinElmer Pyris export", () => {
    expect(sniffVendorText("Pyris 1 DSC\nTime,Temperature,Heat Flow Endo Up\n")).toBe("perkinElmer");
  });

  it("recognises a Mettler STARe Index/t/Ts/Tr/Value table", () => {
    const text = "Sample: X\nIndex\tt\tTs\tTr\tValue\n1\t0.5\t20.0\t20.1\t0.10\n";
    expect(sniffVendorText(text)).toBe("mettler");
  });

  it("returns null for an unrecognised text file", () => {
    expect(sniffVendorText("just,some,csv\n1,2,3\n")).toBeNull();
  });
});

describe("vendorText normalizeDecimalComma", () => {
  it("converts comma decimals to points, but only on fully-numeric rows", () => {
    const text = "Temp;Time;DSC\n20,0;0,0;0,050\n21,5;0,1;0,060\n";
    const out = normalizeDecimalComma(text, ";");
    expect(out).toContain("20.0;0.0;0.050");
    expect(out).toContain("21.5;0.1;0.060");
    expect(out).toContain("Temp;Time;DSC"); // header row untouched
  });

  it("is a no-op when the delimiter is itself the comma", () => {
    const text = "a,b\n1,2\n";
    expect(normalizeDecimalComma(text, ",")).toBe(text);
  });
});

describe("vendorText parseNetzschText", () => {
  it("parses a Netzsch export and normalizes decimal commas", () => {
    const text = [
      "#SAMPLE: PE-01",
      "#INSTRUMENT: DSC 214 Polyma",
      "#TYPE OF CRUCIBLE: Al, pierced lid",
      "##Temp./°C;Time/min;DSC/(mW/mg)",
      "20,0;0,0;0,050",
      "25,0;0,5;0,060",
      "30,0;1,0;0,070",
    ].join("\n");
    const result = parseNetzschText(text, "sample.csv");
    expect(result.runs).toHaveLength(1);
    const run = result.runs[0];
    expect(run.timeMin.length).toBe(3);
    expect(run.tempC[0]).toBeCloseTo(20.0, 5);
    expect(run.heatFlowNormFile).toBeDefined();
    expect(run.heatFlowNormFile![0]).toBeCloseTo(0.05, 5);
    expect(result.warnings.some((w) => w.includes("Netzsch"))).toBe(true);
  });
});

describe("vendorText parseMettlerText", () => {
  it("maps Ts to temperature and Value to heat flow (mW)", () => {
    const text = [
      "Sample: Test",
      "Index\tt\tTs\tTr\tValue",
      "1\t0.5\t20.0\t20.1\t0.10",
      "2\t1.0\t30.0\t30.2\t0.20",
    ].join("\n");
    const result = parseMettlerText(text, "star.txt");
    expect(result.runs).toHaveLength(1);
    const run = result.runs[0];
    expect(run.tempC[0]).toBeCloseTo(20.0, 5);
    expect(run.heatFlowMw[0]).toBeCloseTo(0.1, 5);
    expect(result.warnings.some((w) => w.includes("Mettler"))).toBe(true);
  });
});

describe("vendorText parsePerkinElmerText", () => {
  it("sets exoDirection to down for an 'Endo Up' heat-flow column", () => {
    const text = [
      "Pyris 1 DSC",
      "Time,Temperature,Heat Flow Endo Up",
      "0.5,20.0,0.10",
      "1.0,30.0,0.20",
    ].join("\n");
    const result = parsePerkinElmerText(text, "pe.csv");
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].meta.exoDirection).toBe("down");
    expect(result.warnings.some((w) => w.includes("PerkinElmer"))).toBe(true);
  });

  it("defaults to exoDirection up when the header doesn't say Endo Up", () => {
    const text = ["PerkinElmer instrument export", "Time,Temperature,Heat Flow", "0.5,20.0,0.10"].join("\n");
    const result = parsePerkinElmerText(text, "pe2.csv");
    expect(result.runs[0].meta.exoDirection).toBe("up");
  });
});
