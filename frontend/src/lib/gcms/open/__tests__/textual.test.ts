import { describe, expect, it } from "vitest";
import { parseCsvChromatogram, parseJcamp, sniffTextual } from "../textual";

describe("sniffTextual", () => {
  it("detects jcamp by ## headers", () => {
    expect(sniffTextual("##TITLE=foo\n##DATA TYPE=INFRARED SPECTRUM\n")).toBe("jcamp");
  });
  it("detects csv by delimited numeric content", () => {
    expect(sniffTextual("rt,intensity\n1.0,5\n2.0,6\n")).toBe("csv");
    expect(sniffTextual("1.0\t5\n2.0\t6\n")).toBe("csv");
  });
  it("returns null for unrecognized text", () => {
    expect(sniffTextual("hello world\n")).toBe(null);
  });
});

describe("parseCsvChromatogram", () => {
  it("parses a 2-column CSV as a chromatogram-only run", () => {
    const text = "rt,intensity\n1.0,5\n2.0,6\n3.0,7\n";
    const run = parseCsvChromatogram(text, { name: "ch.csv" });
    expect(run.format).toBe("csv");
    expect(run.detector).toBe("fid");
    expect(run.scanCount).toBe(0);
    expect(Array.from(run.rtMin)).toEqual([1.0, 2.0, 3.0]);
    expect(Array.from(run.tic)).toEqual([5, 6, 7]);
    expect(run.mz.length).toBe(0);
    expect(run.scanOffset.length).toBe(1);
  });

  it("parses a tab-delimited 2-column chromatogram", () => {
    const text = "1.0\t5\n2.0\t6\n";
    const run = parseCsvChromatogram(text);
    expect(run.detector).toBe("fid");
    expect(Array.from(run.rtMin)).toEqual([1.0, 2.0]);
    expect(Array.from(run.tic)).toEqual([5, 6]);
  });

  it("parses a matrix CSV (row=scan, col0=RT, header=m/z values) into scans", () => {
    // header: RT, 100, 200, 300  (m/z columns)
    // rows:   1.0, 10, 0,  5
    //         2.0, 20, 8,  0
    const text = "RT,100,200,300\n1.0,10,0,5\n2.0,20,8,0\n";
    const run = parseCsvChromatogram(text, { name: "m.csv" });
    expect(run.detector).toBe("ms");
    expect(run.scanCount).toBe(2);
    // m/z header sorted ascending: 100,200,300
    // scan 0 intensities at those m/z: 10,0,5
    expect(Array.from(run.mz.subarray(run.scanOffset[0], run.scanOffset[1]))).toEqual([100, 200, 300]);
    expect(Array.from(run.intensity.subarray(run.scanOffset[0], run.scanOffset[1]))).toEqual([10, 0, 5]);
    // scan 1
    expect(Array.from(run.mz.subarray(run.scanOffset[1], run.scanOffset[2]))).toEqual([100, 200, 300]);
    expect(Array.from(run.intensity.subarray(run.scanOffset[1], run.scanOffset[2]))).toEqual([20, 8, 0]);
    expect(run.rtMin[0]).toBe(1.0);
    expect(run.rtMin[1]).toBe(2.0);
  });

  it("returns an empty run on empty input", () => {
    const run = parseCsvChromatogram("");
    expect(run.scanCount).toBe(0);
    expect(run.warnings.length).toBeGreaterThan(0);
  });
});

describe("parseJcamp", () => {
  it("parses an XYDATA chromatogram as a fid run", () => {
    // A minimal JCAMP-DX with XYDATA (X+Y pairs) for a chromatogram.
    const text = [
      "##TITLE=test chrom",
      "##JCAMP-DX=5.01",
      "##DATA TYPE=GC/FID",
      "##XUNITS=MINUTES",
      "##YUNITS=COUNTS",
      "##FIRSTX=1",
      "##LASTX=3",
      "##DELTAX=1",
      "##NPOINTS=3",
      "##XYDATA=(X++Y)",
      "1 5",
      "2 6",
      "3 7",
      "##END=",
    ].join("\n");
    const run = parseJcamp(text, { name: "c.jcamp" });
    expect(run.format).toBe("jcamp");
    expect(run.detector).toBe("fid");
    expect(run.rtMin.length).toBe(3);
    expect(run.tic.length).toBe(3);
  });

  it("parses a MASS SPECTRUM jcamp as an ms run", () => {
    const text = [
      "##TITLE=ms",
      "##JCAMP-DX=5.01",
      "##DATA TYPE=MASS SPECTRUM",
      "##XUNITS=M/Z",
      "##YUNITS=RELATIVE ABUNDANCE",
      "##FIRSTX=100",
      "##LASTX=300",
      "##NPOINTS=3",
      "##XYDATA=(XY..XY)",
      "100 5",
      "200 10",
      "300 2",
      "##END=",
    ].join("\n");
    const run = parseJcamp(text, { name: "ms.jcamp" });
    expect(run.format).toBe("jcamp");
    expect(run.detector).toBe("ms");
    expect(run.scanCount).toBeGreaterThanOrEqual(1);
    expect(run.mz.length).toBe(3);
    expect(Array.from(run.mz)).toEqual([100, 200, 300]);
  });
});