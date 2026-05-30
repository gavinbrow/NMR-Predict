import { describe, expect, it } from "vitest";
import { parseSpectrumText } from "../parse";

describe("parseSpectrumText", () => {
  it("parses comma-delimited two-column data", () => {
    const { spectrum, meta } = parseSpectrumText("100.5,10\n101.0,20\n102.0,5");
    expect(meta.delimiter).toBe("comma");
    expect(meta.hasHeader).toBe(false);
    expect(Array.from(spectrum.mz)).toEqual([100.5, 101.0, 102.0]);
    expect(Array.from(spectrum.intensity)).toEqual([10, 20, 5]);
  });

  it("detects and skips a header row", () => {
    const { spectrum, meta } = parseSpectrumText("m/z,intensity\n200,1\n201,2");
    expect(meta.hasHeader).toBe(true);
    expect(spectrum.mz.length).toBe(2);
    expect(spectrum.mz[0]).toBe(200);
  });

  it("sniffs tab and semicolon delimiters", () => {
    const tab = parseSpectrumText("300\t7\n301\t8");
    expect(tab.meta.delimiter).toBe("tab");
    expect(tab.spectrum.intensity[1]).toBe(8);

    const semi = parseSpectrumText("300;7\n301;8");
    expect(semi.meta.delimiter).toBe("semicolon");
    expect(semi.spectrum.mz[0]).toBe(300);
  });

  it("handles whitespace-delimited columns with extra spacing", () => {
    const { spectrum, meta } = parseSpectrumText("  400.1   12\n400.2    13 ");
    expect(meta.delimiter).toBe("space");
    expect(spectrum.mz[0]).toBeCloseTo(400.1, 5);
    expect(spectrum.intensity[1]).toBe(13);
  });

  it("supports comma decimal marks with a non-comma delimiter", () => {
    const { spectrum, meta } = parseSpectrumText("500,5\t10\n500,7\t20");
    expect(meta.delimiter).toBe("tab");
    expect(meta.decimalComma).toBe(true);
    expect(spectrum.mz[0]).toBeCloseTo(500.5, 5);
    expect(spectrum.mz[1]).toBeCloseTo(500.7, 5);
  });

  it("skips comment lines and non-numeric rows", () => {
    const { spectrum, meta } = parseSpectrumText("# exported\n100,1\nbad,row\n101,2");
    expect(meta.skippedRows).toBe(1);
    expect(spectrum.mz.length).toBe(2);
  });

  it("re-sorts descending m/z ascending", () => {
    const { spectrum, meta } = parseSpectrumText("102,3\n100,1\n101,2");
    expect(meta.resorted).toBe(true);
    expect(Array.from(spectrum.mz)).toEqual([100, 101, 102]);
    expect(Array.from(spectrum.intensity)).toEqual([1, 2, 3]);
  });

  it("throws on input with no numeric rows", () => {
    expect(() => parseSpectrumText("# only a comment")).toThrow();
  });
});
