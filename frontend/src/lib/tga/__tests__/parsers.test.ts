// Pure unit tests for the TGA parsers with small inline fixtures (no real
// files). Each parser is pure over a byte buffer / cell grid, so these build
// the input in-test.

import { describe, expect, it } from "vitest";
import {
  parseTaTextHeader,
  parseColumnNames,
  parseDataRow,
  decodeTaText,
  parseTaText,
} from "../parse/taText";
import { findDataStart, parseTaBinary } from "../parse/taBinary";
import { detectBlocks, extractBlock, isAmbientHold, parseTriosSheets } from "../parse/triosXls";
import {
  autoDetectColumnMap,
  extractGenericGrid,
  parseCsvText,
  parseGenericGrid,
  sniffDelimiter,
} from "../parse/genericTable";
import type { SheetGrid } from "@/lib/tensile/parse";
import type { ColumnMap } from "../types";

// --- taText ----------------------------------------------------------------

describe("taText header parsing", () => {
  it("collects repeated keys into arrays", () => {
    const lines = [
      "Version\t2.0",
      "Sample\tMy sample",
      "Xcomment\tfirst",
      "Xcomment\tsecond",
      "Xcomment\tthird",
      "Nsig\t4",
      "Sig1\tTime (min)",
      "Sig2\tTemperature (°C)",
      "Sig3\tWeight (mg)",
      "Sig4\tDeriv. Weight Change (%/°C)",
      "StartOfData",
      "0.5\t20.0\t2.15\t0.001",
    ];
    const { meta, dataStartIndex } = parseTaTextHeader(lines);
    expect(meta.Version).toBe("2.0");
    expect(meta.Sample).toBe("My sample");
    expect(meta.Xcomment).toEqual(["first", "second", "third"]);
    expect(dataStartIndex).toBe(11);
  });

  it("reads the column set from Nsig/SigN", () => {
    expect(parseColumnNames({ Nsig: "4", Sig1: "Time", Sig2: "Temp", Sig3: "Weight", Sig4: "Deriv" })).toEqual([
      "Time",
      "Temp",
      "Weight",
      "Deriv",
    ]);
    expect(parseColumnNames({ Nsig: "2" })).toEqual([]);
  });

  it("parses a data row with no-leading-zero and empty→NaN", () => {
    expect(parseDataRow(".00749511\t20.0\t2.15")).toEqual([0.00749511, 20, 2.15]);
    expect(parseDataRow("0.5\t\t2.15")).toEqual([0.5, NaN, 2.15]);
    expect(parseDataRow("1.0\tabc\t2.15")).toEqual([1, NaN, 2.15]);
  });
});

describe("taText decode + parse", () => {
  it("strips the UTF-16LE BOM and splits CRLF lines", () => {
    // "Version\t2.0\r\nSample\tX\r\n" in UTF-16LE with BOM.
    const text = "Version\t2.0\r\nSample\tX\r\n";
    const utf16 = new TextEncoder().encode(text); // UTF-8 placeholder
    // Build a real UTF-16LE buffer.
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      bytes[2 + i * 2] = text.charCodeAt(i) & 0xff;
      bytes[2 + i * 2 + 1] = (text.charCodeAt(i) >> 8) & 0xff;
    }
    const lines = decodeTaText(bytes);
    expect(lines[0]).toBe("Version\t2.0");
    expect(lines[1]).toBe("Sample\tX");
  });

  it("parses a full small export into one run", () => {
    const header = [
      "Version\t2.0",
      "Sample\tTest sample",
      "Size\t2.500\tmg",
      "Nsig\t3",
      "Sig1\tTime (min)",
      "Sig2\tTemperature (°C)",
      "Sig3\tWeight (mg)",
      "StartOfData",
    ];
    const data = [
      "0.5\t20.0\t2.50",
      "1.0\t30.0\t2.45",
      "1.5\t40.0\t2.40",
      ".00749511\t50.0\t2.35",
    ];
    const text = [...header, ...data].join("\r\n") + "\r\n";
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      bytes[2 + i * 2] = text.charCodeAt(i) & 0xff;
      bytes[2 + i * 2 + 1] = (text.charCodeAt(i) >> 8) & 0xff;
    }
    const result = parseTaText(bytes, "test.txt");
    expect(result.warnings).toEqual([]);
    expect(result.runs).toHaveLength(1);
    const run = result.runs[0];
    expect(run.timeMin.length).toBe(4);
    expect(run.timeMin[3]).toBeCloseTo(0.00749511, 8);
    expect(run.meta.sampleSizeMg).toBeCloseTo(2.5, 3);
    expect(run.meta.sampleName).toBe("Test sample");
  });
});

// --- taBinary --------------------------------------------------------------

describe("taBinary findDataStart", () => {
  function buildBuffer(triplets: [number, number, number][]): Uint8Array {
    const bytes = new Uint8Array(triplets.length * 12);
    const dv = new DataView(bytes.buffer);
    for (let i = 0; i < triplets.length; i++) {
      dv.setFloat32(i * 12, triplets[i][0], true);
      dv.setFloat32(i * 12 + 4, triplets[i][1], true);
      dv.setFloat32(i * 12 + 8, triplets[i][2], true);
    }
    return bytes;
  }

  it("finds the start of a plausible ascending-triplet run", () => {
    // 5 plausible ascending triplets.
    const bytes = buildBuffer([
      [0, 20, 2.5],
      [1, 30, 2.45],
      [2, 40, 2.4],
      [3, 50, 2.35],
      [4, 60, 2.3],
    ]);
    const dv = new DataView(bytes.buffer);
    expect(findDataStart(dv, bytes)).toBe(0);
  });

  it("skips leading garbage to find the run", () => {
    const garbage = new Uint8Array(20).fill(0xff);
    const good = buildBuffer([
      [0, 20, 2.5],
      [1, 30, 2.45],
      [2, 40, 2.4],
      [3, 50, 2.35],
      [4, 60, 2.3],
    ]);
    const bytes = new Uint8Array(garbage.length + good.length);
    bytes.set(garbage, 0);
    bytes.set(good, garbage.length);
    const dv = new DataView(bytes.buffer);
    expect(findDataStart(dv, bytes)).toBe(garbage.length);
  });

  it("stops at the -100 terminator", () => {
    const bytes = buildBuffer([
      [0, 20, 2.5],
      [1, 30, 2.45],
      [2, 40, 2.4],
      [3, 50, 2.35],
      [-100, 20, 0], // terminator
      [5, 70, 2.25], // trailing garbage
    ]);
    const ab = bytes.buffer;
    const result = parseTaBinary(ab, "test.001");
    expect(result.warnings).toEqual([]);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].timeMin.length).toBe(4); // stopped at -100
  });
});

// --- triosXls --------------------------------------------------------------

describe("triosXls block detection", () => {
  function sheet(): SheetGrid {
    // Row 0: sample titles — the name sits one column LEFT of the block's Time col.
    // Row 1: column headers (Time | Temperature | Weight | Weight | Deriv. Weight).
    // Row 2: units (min | °C | mg | % | % / °C).
    // Rows 3+: data (with duplicated first three rows, as TRIOS exports).
    // Block A: Time at col 1, sample name "Sample A" at col 0.
    // Block B: Time at col 9, sample name "Sample B" at col 8.
    return {
      name: "Ramp 10 °Cmin to 600 °C",
      rows: [
        ["Sample A", "", "", "", "", "", "", "", "Sample B", "", "", "", ""],
        ["", "Time", "Temperature", "Weight", "Weight", "Deriv. Weight", "", "", "", "Time", "Temperature", "Weight", "Weight", "Deriv. Weight"],
        ["", "min", "°C", "mg", "%", "% / °C", "", "", "", "min", "°C", "mg", "%", "% / °C"],
        ["", 0, 20, 10, 100, -0.1, "", "", "", 0, 22, 5, 100, -0.05],
        ["", 0, 20, 10, 100, -0.1, "", "", "", 0, 22, 5, 100, -0.05],
        ["", 0, 20, 10, 100, -0.1, "", "", "", 0, 22, 5, 100, -0.05],
        ["", 1, 30, 9.9, 99, -0.5, "", "", "", 1, 32, 4.95, 99, -0.3],
        ["", 2, 40, 9.5, 95, -1.0, "", "", "", 2, 42, 4.75, 95, -0.6],
        ["", "", "", "", "", "", "", "", "", "", "", "", "", ""], // trailing null row
      ],
    };
  }

  it("detects blocks by scanning row 1 for 'Time'", () => {
    const blocks = detectBlocks(sheet());
    expect(blocks).toHaveLength(2);
    expect(blocks[0].sampleName).toBe("Sample A");
    expect(blocks[0].timeCol).toBe(1);
    expect(blocks[0].tempCol).toBe(2);
    expect(blocks[0].weightCol).toBe(3);
    expect(blocks[0].weightPctCol).toBe(4);
    expect(blocks[0].dtgCol).toBe(5);
    expect(blocks[1].sampleName).toBe("Sample B");
    expect(blocks[1].timeCol).toBe(9);
  });

  it("extracts a block, trimming trailing nulls and deduping ascending time", () => {
    const grid = sheet();
    const block = detectBlocks(grid)[0];
    const data = extractBlock(grid, block, 3);
    expect(data.timeMin.length).toBe(3); // 0,1,2 (the three duplicated 0s collapse to one)
    expect(data.timeMin[0]).toBe(0);
    expect(data.timeMin[1]).toBe(1);
    expect(data.timeMin[2]).toBe(2);
    expect(data.weightPct).toBeDefined();
    expect(data.dtg).toBeDefined();
    expect(data.weightPct![0]).toBe(100);
  });

  it("parseTriosSheets yields one run per block", () => {
    const result = parseTriosSheets([sheet()], "test.xls");
    expect(result.warnings).toEqual([]);
    expect(result.runs).toHaveLength(2);
    expect(result.runs[0].label).toBe("Sample A");
    expect(result.runs[1].label).toBe("Sample B");
  });
});

// --- genericTable ----------------------------------------------------------

describe("triosXls isAmbientHold", () => {
  const flat = (temp: number, w: number, n = 50) => ({
    tempC: Float64Array.from({ length: n }, () => temp),
    weightMg: Float64Array.from({ length: n }, () => w),
  });

  it("recognises the balance equilibration hold at ambient", () => {
    const { tempC, weightMg } = flat(23.7, 17.6);
    expect(isAmbientHold(tempC, weightMg)).toBe(true);
  });

  it("keeps a genuine isothermal experiment above ambient", () => {
    const { tempC, weightMg } = flat(200, 17.6);
    expect(isAmbientHold(tempC, weightMg)).toBe(false);
  });

  it("keeps an ambient hold that actually loses mass", () => {
    const n = 50;
    const tempC = Float64Array.from({ length: n }, () => 23.7);
    // 5 % loss — a drying step is a result, not furniture.
    const weightMg = Float64Array.from({ length: n }, (_, i) => 20 - i * (1 / n));
    expect(isAmbientHold(tempC, weightMg)).toBe(false);
  });

  it("keeps a block that ramps, however slightly", () => {
    const n = 50;
    const tempC = Float64Array.from({ length: n }, (_, i) => 23.7 + i * 0.5);
    const weightMg = Float64Array.from({ length: n }, () => 17.6);
    expect(isAmbientHold(tempC, weightMg)).toBe(false);
  });

  it("is false for an empty block rather than throwing", () => {
    expect(isAmbientHold(new Float64Array(0), new Float64Array(0))).toBe(false);
  });
});

describe("genericTable column auto-detect + extraction", () => {
  function sheet(): SheetGrid {
    return {
      name: "data.csv",
      rows: [
        ["Time (min)", "Temperature (°C)", "Weight (mg)", "Deriv. Weight (%/°C)"],
        [0, 25, 10.0, 0],
        [1, 35, 9.9, -0.1],
        [2, 45, 9.8, -0.1],
      ],
    };
  }

  it("auto-detects the column map from header names", () => {
    const map = autoDetectColumnMap(sheet());
    expect(map).not.toBeNull();
    expect(map!.time).toBe(0);
    expect(map!.temperature).toBe(1);
    expect(map!.weight).toBe(2);
    expect(map!.dtg).toBe(3);
    expect(map!.weightUnit).toBe("mg");
    expect(map!.tempUnit).toBe("C");
    expect(map!.headerRow).toBe(0);
    expect(map!.firstDataRow).toBe(1);
  });

  it("extracts the grid with unit conversion", () => {
    const map: ColumnMap = {
      time: 0,
      temperature: 1,
      weight: 2,
      weightUnit: "mg",
      tempUnit: "C",
      headerRow: 0,
      firstDataRow: 1,
    };
    const data = extractGenericGrid(sheet(), map);
    expect(data.timeMin.length).toBe(3);
    expect(data.weightMg[0]).toBeCloseTo(10, 5);
  });

  it("converts K → °C and g → mg", () => {
    const grid: SheetGrid = {
      name: "x",
      rows: [
        ["Time (min)", "Temp (K)", "Mass (g)"],
        [0, 298.15, 0.01],
        [1, 308.15, 0.0099],
      ],
    };
    const map = autoDetectColumnMap(grid);
    expect(map!.tempUnit).toBe("K");
    expect(map!.weightUnit).toBe("g");
    const data = extractGenericGrid(grid, map!);
    expect(data.tempC[0]).toBeCloseTo(25, 1); // 298.15 K - 273.15 = 25 °C
    expect(data.weightMg[0]).toBeCloseTo(10, 5); // 0.01 g = 10 mg
  });

  it("does NOT dedupe (generic keeps all rows)", () => {
    const grid: SheetGrid = {
      name: "x",
      rows: [
        ["Time", "Temp", "Weight"],
        [0, 20, 10],
        [0, 20, 10], // duplicate time — kept (only TRIOS dedupes)
        [1, 30, 9.9],
      ],
    };
    const map = autoDetectColumnMap(grid);
    const data = extractGenericGrid(grid, map!);
    expect(data.timeMin.length).toBe(3); // not deduped
  });

  it("sniffs the delimiter of a CSV", () => {
    expect(sniffDelimiter("a,b,c\n1,2,3")).toBe(",");
    expect(sniffDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(sniffDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
  });

  it("parseCsvText splits on the sniffed delimiter", () => {
    const grid = parseCsvText("Time,Temp,Weight\n0,20,10\n1,30,9.9\n", "x.csv");
    expect(grid.rows).toHaveLength(3);
    expect(grid.rows[0]).toEqual(["Time", "Temp", "Weight"]);
    expect(grid.rows[1]).toEqual(["0", "20", "10"]);
  });

  it("parseGenericGrid produces a run with the file stem as the label", () => {
    const map: ColumnMap = {
      time: 0,
      temperature: 1,
      weight: 2,
      weightUnit: "mg",
      tempUnit: "C",
      headerRow: 0,
      firstDataRow: 1,
    };
    const result = parseGenericGrid(sheet(), "my sample.csv", map);
    expect(result.warnings).toEqual([]);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].label).toBe("my sample");
    expect(result.runs[0].timeMin.length).toBe(3);
  });
});