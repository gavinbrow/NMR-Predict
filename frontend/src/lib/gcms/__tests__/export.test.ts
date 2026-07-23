import { describe, expect, it } from "vitest";
import {
  chromPeakCsv,
  chromatogramCsv,
  renderReportSvg,
  spectrumCsv,
  spectrumMsp,
  spectrumPeakCsv,
  type ReportPanelSpec,
  type ReportTheme,
} from "../export";
import type { ChromPeak, ChromTrace, MassSpectrum, RunMeta, SpecPeak } from "../types";

const THEME: ReportTheme = { fg: "#0f172a", muted: "#64748b", border: "#cbd5e1", bg: "#ffffff" };

function makeTrace(
  id: string,
  label: string,
  rt: number[],
  ints: number[],
  color = "#0ea5e9",
  visible = true,
): ChromTrace {
  return {
    id,
    runId: "run",
    kind: "TIC",
    label,
    rtMin: Float64Array.from(rt),
    intensity: Float64Array.from(ints),
    color,
    visible,
    offset: 0,
    scale: 1,
  };
}

function makeSpectrum(mz: number[], ints: number[], base?: { mz: number; intensity: number }): MassSpectrum {
  return {
    runId: "run",
    mz: Float64Array.from(mz),
    intensity: Float64Array.from(ints),
    label: "spec",
    rtLo: 7.0,
    rtHi: 7.8,
    scanCount: 1,
    basePeak: base ?? null,
  };
}

function makeSpecPeaks(rows: [number, number][]): SpecPeak[] {
  const base = rows.reduce((m, r) => Math.max(m, r[1]), 0);
  return rows.map(([mz, intensity]) => ({
    id: `p${mz}`,
    mz,
    intensity,
    relPct: base > 0 ? (intensity / base) * 100 : 0,
  }));
}

function makeMeta(over: Partial<RunMeta> = {}): RunMeta {
  return { sample: "Std", method: "M1", ...over };
}

describe("spectrumCsv", () => {
  it("emits the header, 3-dp m/z and rel% relative to the base peak", () => {
    const spec = makeSpectrum([100.0, 200.0, 300.0], [500, 1000, 250]);
    const csv = spectrumCsv(spec);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("m/z,intensity,rel%");
    // 3-dp m/z, plain intensities, rel% relative to 1000.
    expect(lines[1]).toBe("100.000,500,50");
    expect(lines[2]).toBe("200.000,1000,100");
    expect(lines[3]).toBe("300.000,250,25");
  });
});

describe("chromPeakCsv", () => {
  it("RFC-4180 quotes a name with a comma and a double quote", () => {
    const peaks: ChromPeak[] = [
      {
        id: "pk1",
        runId: "run",
        traceId: "t1",
        rtApex: 7.401,
        rtStart: 7.2,
        rtEnd: 7.6,
        scanApex: 1247,
        height: 123456,
        area: 987654,
        areaPct: 12.34,
        basePeakMz: 162.3,
        name: 'Benzene, "spectral"',
      },
    ];
    const csv = chromPeakCsv(peaks);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("rt,height,area,area%,width,basePeakMz,name");
    // The last cell is wrapped in quotes; inner quote doubled.
    const row = lines[1].split(",");
    // The 7th field is the quoted name: comma inside means CSV split lands the
    // pieces across cells — rejoin and verify round-trip of the quoted block.
    const lastCellIdx = csv.lastIndexOf('"Benzene, ""spectral""');
    expect(lastCellIdx).toBeGreaterThan(0);
    // Basic numeric formatting sanity.
    expect(row[0]).toBe("7.4010");
    expect(row[3]).toBe("12.34");
  });
});

describe("chromatogramCsv", () => {
  it("merges two traces on different RT grids into one union RT column with empty cells", () => {
    const a = makeTrace("a", "TIC", [1.0, 2.0, 3.0], [10, 20, 30]);
    const b = makeTrace("b", "BPC", [2.0, 4.0], [5, 9]);
    const csv = chromatogramCsv([a, b]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("rt,TIC,BPC");
    // Union RT grid = 1, 2, 3, 4. b has no point at 1 and 3 (empty), a has no
    // point at 4 (empty). Empty cells are EMPTY, not zeros.
    const cells = lines.slice(1).map((l) => l.split(","));
    expect(cells[0]).toEqual(["1.0000", "10", ""]);
    expect(cells[1]).toEqual(["2.0000", "20", "5"]);
    expect(cells[2]).toEqual(["3.0000", "30", ""]);
    expect(cells[3]).toEqual(["4.0000", "", "9"]);
  });
});

describe("spectrumMsp", () => {
  it("scales the base peak to 999, 5 pairs per line, Num Peaks matches, ends blank", () => {
    const peaks = makeSpecPeaks([
      [100.1, 1000],
      [200.2, 500],
      [300.3, 250],
      [400.4, 100],
      [500.5, 50],
      [600.6, 25],
      [700.7, 10],
    ]);
    const spec = makeSpectrum([100.1, 200.2, 300.3], [1000, 500, 250], { mz: 100.1, intensity: 1000 });
    const msp = spectrumMsp(spec, peaks, makeMeta(), "Std-7.4");

    const lines = msp.split("\n");
    expect(lines[0]).toBe("Name: Std-7.4");
    expect(lines[1]).toBe("Formula:");
    expect(lines[2]).toBe("MW:");
    expect(lines[3]).toBe("CAS#:");
    expect(lines[4]).toBe("Comment: Std M1 RT 7-7.8 min");
    expect(lines[5]).toBe("Num Peaks: 7");

    // Peak lines start at index 6; first line carries 5 pairs, second carries 2.
    const peakLines = lines.slice(6, 6 + Math.ceil(peaks.length / 5));
    expect(peakLines[0].split("; ")).toHaveLength(5);
    expect(peakLines[1].split("; ")).toHaveLength(2);

    // The base peak (1000) is scaled to exactly 999; 500*0.999=499.5 rounds to
    // 500 (Math.round rounds .5 up in JS), 250*0.999=249.75 → 250.
    expect(peakLines[0]).toContain("100.1 999");
    expect(peakLines[0]).toContain("200.2 500");
    expect(peakLines[0]).toContain("300.3 250");
    // The block ends with a blank line: the last peak line is followed by an
    // empty line. spectrumMsp builds `[..., "", <trailing newline>]`, so the
    // string ends with "\n\n" — the final peak line, then a blank line.
    expect(msp.endsWith("\n\n")).toBe(true);
    // The line right before the trailing blank must be a peak line, not blank.
    const mspLines = msp.split("\n");
    // lines = [...peakLines, "", ""]  (trailing \n\n produces two empty entries)
    const lastNonEmpty = [...mspLines].reverse().find((l) => l.trim() !== "");
    expect(lastNonEmpty).toBeDefined();
    expect(lastNonEmpty).toContain(";");
  });
});

describe("spectrumPeakCsv", () => {
  it("emits the header and 3-dp m/z", () => {
    const csv = spectrumPeakCsv(makeSpecPeaks([[120.5, 800]]));
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("m/z,intensity,rel%");
    expect(lines[1]).toBe("120.500,800,100");
  });
});

describe("renderReportSvg", () => {
  function panel(title: string, xLabel: string, n = 5): ReportPanelSpec {
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      xs[i] = i;
      ys[i] = Math.random() * 100;
    }
    return {
      title,
      xLabel,
      traces: [{ x: xs, y: ys, color: "#0ea5e9", width: 1.5 }],
      drawMode: "line",
      labels: [{ x: 2, y: 80, lines: ["2.000", "50%"], priority: 1 }],
    };
  }

  it("returns an <svg> with both titles, both axis labels, no var(--, no http", () => {
    const svg = renderReportSvg(panel("Chromatogram", "Retention time (min)"), panel("Mass spectrum", "m/z"), {
      width: 800,
      height: 600,
      theme: THEME,
    });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("Chromatogram");
    expect(svg).toContain("Mass spectrum");
    expect(svg).toContain("Retention time (min)");
    expect(svg).toContain(">m/z<");
    expect(svg).not.toContain("var(--");
    // No external references that would break offline use. The xmlns attribute
    // is mandatory on the root <svg> and is not an external resource, so strip
    // it before checking for stray http URLs.
    const withoutXmlns = svg.replace(/xmlns="[^"]*"/g, "");
    expect(withoutXmlns).not.toContain("http");
  });

  it("is well-formed enough that every < has a matching >", () => {
    const svg = renderReportSvg(panel("Chromatogram", "Retention time (min)"), panel("Mass spectrum", "m/z"), {
      width: 800,
      height: 600,
      theme: THEME,
    });
    let depth = 0;
    let i = 0;
    while (i < svg.length) {
      const lt = svg.indexOf("<", i);
      if (lt < 0) break;
      const gt = svg.indexOf(">", lt + 1);
      expect(gt).toBeGreaterThan(lt); // every < has a matching >
      depth += 1;
      i = gt + 1;
    }
    expect(depth).toBeGreaterThan(4);
  });
});