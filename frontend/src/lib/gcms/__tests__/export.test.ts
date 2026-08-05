import { describe, expect, it, vi } from "vitest";
import {
  chromPeakCsv,
  chromatogramCsv,
  renderReportPng,
  renderReportSvg,
  spectrumCsv,
  spectrumMsp,
  spectrumPeakCsv,
  type ReportPanelSpec,
  type ReportTheme,
} from "../export";
import type {
  ChromPeak,
  ChromTrace,
  MassSpectrum,
  RunMeta,
  SpecPeak,
  SpectrumPeakRow,
} from "../types";

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
    expect(lines[0]).toBe("rt,rtStart,rtEnd,height,area,area%,width,basePeakMz,name");
    // The last cell is wrapped in quotes; inner quote doubled.
    const row = lines[1].split(",");
    // The final field is the quoted name: comma inside means CSV split lands the
    // pieces across cells — rejoin and verify round-trip of the quoted block.
    const lastCellIdx = csv.lastIndexOf('"Benzene, ""spectral""');
    expect(lastCellIdx).toBeGreaterThan(0);
    // Basic numeric formatting sanity.
    expect(row[0]).toBe("7.4010");
    expect(row[1]).toBe("7.2000");
    expect(row[2]).toBe("7.6000");
    expect(row[5]).toBe("12.34");
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

  it("keeps separated spectrum-ion XICs as independently labelled columns", () => {
    const mz100 = makeTrace("xic-100", "XIC 100.00 ± 0.30", [1, 2], [90, 5]);
    const mz200 = makeTrace("xic-200", "XIC 200.00 ± 0.30", [1, 2], [2, 80]);

    const lines = chromatogramCsv([mz100, mz200]).split("\r\n");
    expect(lines[0]).toBe("rt,XIC 100.00 ± 0.30,XIC 200.00 ± 0.30");
    expect(lines[1]).toBe("1.0000,90,2");
    expect(lines[2]).toBe("2.0000,5,80");
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

  it("labels every MS peak with its chromatographic source and RT range", () => {
    const peaks: SpectrumPeakRow[] = [
      {
        id: "chrom-1:p120",
        mz: 120.5,
        intensity: 800,
        relPct: 100,
        sourcePeakId: "chrom-1",
        sourceLabel: "Solvent, peak · RT 1.250 (1.100–1.400)",
        sourceRtStart: 1.1,
        sourceRtEnd: 1.4,
      },
    ];

    const lines = spectrumPeakCsv(peaks).split("\r\n");
    expect(lines[0]).toBe("chromatogramPeak,rtStart,rtEnd,m/z,intensity,rel%");
    expect(lines[1]).toBe(
      '"Solvent, peak · RT 1.250 (1.100–1.400)",1.1000,1.4000,120.500,800,100',
    );
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

  it("includes trace labels so separated XIC colours remain identifiable", () => {
    const top = panel("Chromatogram", "Retention time (min)");
    top.traces = [
      { ...top.traces[0], color: "#ef4444", label: "XIC 100.00 ± 0.30" },
      { ...top.traces[0], color: "#3b82f6", label: "XIC 200.00 ± 0.30" },
    ];

    const svg = renderReportSvg(top, panel("Mass spectrum", "m/z"), {
      width: 800,
      height: 600,
      theme: THEME,
    });

    expect(svg).toContain("XIC 100.00 ± 0.30");
    expect(svg).toContain("XIC 200.00 ± 0.30");
  });

  it("bounds a large XIC legend and clearly summarizes omitted trace origins", () => {
    const top = panel("Chromatogram", "Retention time (min)");
    top.traces = Array.from({ length: 200 }, (_, index) => ({
      ...top.traces[0],
      color: `hsl(${index} 70% 45%)`,
      label: `XIC ${100 + index}.000 ± 0.300`,
    }));

    const svg = renderReportSvg(top, panel("Mass spectrum", "m/z"), {
      width: 800,
      height: 600,
      theme: THEME,
    });

    expect(svg).toContain("XIC 100.000 ± 0.300");
    expect(svg).toMatch(/\+\d+ more traces/);
    expect(svg).not.toContain("XIC 299.000 ± 0.300");

    // At most three 13px legend rows are reserved, leaving a useful top plot
    // rather than the previous 1px collapse for a large separated-XIC batch.
    const topFrame = svg.match(
      /<rect x="56" y="([^"]+)" width="730" height="([^"]+)" fill="none"/,
    );
    expect(topFrame).not.toBeNull();
    expect(Number(topFrame![1])).toBeLessThanOrEqual(63);
    expect(Number(topFrame![2])).toBeGreaterThan(150);
  });

  it("resets PNG axis strokes after drawing coloured legend swatches", () => {
    const top = panel("Chromatogram", "Retention time (min)");
    top.traces = [
      { ...top.traces[0], color: "#ef4444", label: "XIC 100.00 ± 0.30" },
      { ...top.traces[0], color: "#3b82f6", label: "XIC 200.00 ± 0.30" },
    ];

    type StrokeCall = { style: string | CanvasGradient | CanvasPattern; width: number; path: number[][] };
    const strokes: StrokeCall[] = [];
    let path: number[][] = [];
    const context = {
      strokeStyle: "#000000" as string | CanvasGradient | CanvasPattern,
      fillStyle: "#000000" as string | CanvasGradient | CanvasPattern,
      lineWidth: 1,
      lineJoin: "miter" as CanvasLineJoin,
      lineCap: "butt" as CanvasLineCap,
      font: "",
      textAlign: "start" as CanvasTextAlign,
      textBaseline: "alphabetic" as CanvasTextBaseline,
      scale: vi.fn(),
      fillRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      strokeRect: vi.fn(),
      fillText: vi.fn(),
      beginPath() {
        path = [];
      },
      moveTo(x: number, y: number) {
        path.push([x, y]);
      },
      lineTo(x: number, y: number) {
        path.push([x, y]);
      },
      stroke() {
        strokes.push({ style: this.strokeStyle, width: this.lineWidth, path: [...path] });
      },
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toDataURL: () => "data:image/png;base64,test",
    };
    const createElement = vi
      .spyOn(document, "createElement")
      .mockReturnValue(canvas as unknown as HTMLCanvasElement);
    try {
      expect(
        renderReportPng(top, panel("Mass spectrum", "m/z"), {
          width: 800,
          height: 600,
          scale: 1,
          theme: THEME,
        }),
      ).toBe("data:image/png;base64,test");
    } finally {
      createElement.mockRestore();
    }

    // Top-panel Y ticks run from x=56 to x=52. Without the reset they inherit
    // the final blue swatch and its 2px width.
    const topYTicks = strokes.filter(
      (call) =>
        call.path.length === 2 &&
        call.path[0][0] === 56 &&
        call.path[1][0] === 52 &&
        call.path[0][1] < 294,
    );
    expect(topYTicks.length).toBeGreaterThan(0);
    expect(topYTicks.every((call) => call.style === THEME.border && call.width === 1)).toBe(true);
  });
});
