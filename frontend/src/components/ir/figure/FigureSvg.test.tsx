import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { defaultFigureOptions, type FigureData } from "@/lib/ir/figure";
import { FigureSvg } from "./FigureSvg";

/** A tiny mass-spectrum-style figure: a profile line plus sticks + m/z labels. */
function msData(): FigureData {
  return {
    x: [100, 200, 300, 400],
    series: [
      {
        id: "profile",
        label: "profile",
        x: [100, 200, 300, 400],
        y: [1, 9, 3, 6],
        styleHints: { kind: "line" },
      },
      {
        id: "sticks",
        label: "peaks",
        x: [200, 400],
        y: [9, 6],
        styleHints: { kind: "sticks", color: "#0ea5e9" },
      },
    ],
    xLabel: "m/z",
    yLabel: "Intensity",
    peakLabels: [
      { id: "p1", x: 200, y: 9, text: "200.00" },
      { id: "p2", x: 400, y: 6, text: "400.00" },
    ],
  };
}

describe("FigureSvg — mass-spectrum features", () => {
  it("renders peak m/z labels (reformatted to the chosen decimals)", () => {
    const data = msData();
    const options = defaultFigureOptions(data); // peakLabels.show defaults on, decimals 2
    const { container } = render(<FigureSvg data={data} options={options} decimate={false} />);
    const texts = Array.from(container.querySelectorAll("text")).map((t) => t.textContent);
    expect(texts).toContain("200.00");
    expect(texts).toContain("400.00");
  });

  it("respects the peak-label decimals override live", () => {
    const data = msData();
    const base = defaultFigureOptions(data);
    const options = { ...base, peakLabels: { ...base.peakLabels, decimals: 0 } };
    const { container } = render(<FigureSvg data={data} options={options} decimate={false} />);
    const texts = Array.from(container.querySelectorAll("text")).map((t) => t.textContent);
    expect(texts).toContain("200");
    expect(texts).toContain("400");
    expect(texts).not.toContain("200.00");
  });

  it("hides peak labels when the option is off", () => {
    const data = msData();
    const base = defaultFigureOptions(data);
    const options = { ...base, peakLabels: { ...base.peakLabels, show: false } };
    const { container } = render(<FigureSvg data={data} options={options} decimate={false} />);
    const texts = Array.from(container.querySelectorAll("text")).map((t) => t.textContent);
    expect(texts).not.toContain("200.00");
  });

  it("draws a stick series as isolated vertical stems (multiple subpaths)", () => {
    const data = msData();
    const options = defaultFigureOptions(data);
    const { container } = render(<FigureSvg data={data} options={options} decimate={false} />);
    const paths = Array.from(container.querySelectorAll("path")).map((p) => p.getAttribute("d") ?? "");
    // The stick path has one "M…L…" subpath per peak (two peaks → two moves).
    const stick = paths.find((d) => (d.match(/M/g)?.length ?? 0) === 2 && d.includes("L"));
    expect(stick).toBeTruthy();
  });

  it("thins labels to maxLabels (keeps the most intense)", () => {
    const data = msData();
    const base = defaultFigureOptions(data);
    const options = { ...base, peakLabels: { ...base.peakLabels, maxLabels: 1, minGap: 0 } };
    const { container } = render(<FigureSvg data={data} options={options} decimate={false} />);
    const texts = Array.from(container.querySelectorAll("text")).map((t) => t.textContent);
    // Peak at x=200 has intensity 9 (tallest) → survives; x=400 (6) is dropped.
    expect(texts).toContain("200.00");
    expect(texts).not.toContain("400.00");
  });
});

describe("FigureSvg — per-label resolution (WP5)", () => {
  const fillOf = (container: HTMLElement, text: string) =>
    Array.from(container.querySelectorAll("text"))
      .find((t) => t.textContent === text)
      ?.getAttribute("fill");

  it("shows custom label text verbatim even when Decimals is set", () => {
    const data = msData();
    data.peakLabels![0].customText = true;
    data.peakLabels![0].text = "[M+H]+";
    const base = defaultFigureOptions(data);
    const options = { ...base, peakLabels: { ...base.peakLabels, decimals: 1 } };
    const { container } = render(<FigureSvg data={data} options={options} decimate={false} />);
    const texts = Array.from(container.querySelectorAll("text")).map((t) => t.textContent);
    expect(texts).toContain("[M+H]+"); // custom text is protected from the decimals reformat
    expect(texts).toContain("400.0"); // a plain label is still reformatted
  });

  it("uses a per-datum colour over the global label colour", () => {
    const data = msData();
    data.peakLabels![0].color = "#ff0000";
    const options = defaultFigureOptions(data);
    const { container } = render(<FigureSvg data={data} options={options} decimate={false} />);
    expect(fillOf(container, "200.00")).toBe("#ff0000");
    expect(fillOf(container, "400.00")).toBe(options.peakLabels.color); // untouched → global
  });

  it("colours labels by their series when colorBySeries is on", () => {
    const data = msData();
    data.peakLabels![0].seriesId = "sticks"; // the sticks series is #0ea5e9
    const base = defaultFigureOptions(data);
    const options = { ...base, peakLabels: { ...base.peakLabels, colorBySeries: true } };
    const { container } = render(<FigureSvg data={data} options={options} decimate={false} />);
    expect(fillOf(container, "200.00")).toBe("#0ea5e9");
  });

  it("excludes a label with a hidden override", () => {
    const data = msData();
    const base = defaultFigureOptions(data);
    const options = {
      ...base,
      peakLabels: { ...base.peakLabels, overrides: { p1: { hidden: true } } },
    };
    const { container } = render(<FigureSvg data={data} options={options} decimate={false} />);
    const texts = Array.from(container.querySelectorAll("text")).map((t) => t.textContent);
    expect(texts).not.toContain("200.00");
    expect(texts).toContain("400.00");
  });
});

describe("FigureSvg — window-aware decimation", () => {
  /** Count the vertices (`L` commands) of the first drawn line path. */
  function lineVertices(container: HTMLElement): number {
    const d = Array.from(container.querySelectorAll("path"))
      .map((p) => p.getAttribute("d") ?? "")
      .find((s) => s.startsWith("M"));
    return (d?.match(/L/g) ?? []).length;
  }

  function denseSpectrum(): FigureData {
    const n = 40001;
    const x = Array.from({ length: n }, (_, i) => i);
    const y = x.map((v) => Math.abs(Math.sin(v / 3))); // dense fine structure throughout
    return {
      x,
      series: [{ id: "profile", label: "profile", x, y, styleHints: { kind: "line" } }],
      xLabel: "m/z",
      yLabel: "Intensity",
    };
  }

  it("keeps full detail inside a zoomed-in window of a dense series", () => {
    const data = denseSpectrum();
    const base = defaultFigureOptions(data);
    // Zoom to a 500-wide window: ~500 raw points, below the decimation cap, so
    // every in-window sample is drawn. The old code decimated the whole 40k
    // series first, leaving only a few dozen vertices here.
    const options = { ...base, x: { ...base.x, min: 3000, max: 3500 } };
    const { container } = render(<FigureSvg data={data} options={options} />); // decimate defaults on
    expect(lineVertices(container)).toBeGreaterThan(300);
  });

  it("still decimates the full (un-zoomed) view of a dense series", () => {
    const data = denseSpectrum();
    const options = defaultFigureOptions(data); // auto axis → whole 40k range
    const { container } = render(<FigureSvg data={data} options={options} />);
    const v = lineVertices(container);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(40001); // not every raw point — the preview is decimated
  });
});

describe("FigureSvg — scroll scales the y-axis", () => {
  function lineData(): FigureData {
    const x = Array.from({ length: 101 }, (_, i) => i);
    return {
      x,
      series: [{ id: "s", label: "s", x, y: x.map((v) => v) }], // y spans 0..100
      xLabel: "x",
      yLabel: "y",
    };
  }

  /** Give the rendered SVG a concrete on-screen box (jsdom reports zeros), with
   *  the viewBox mapping 1:1 so clientX/Y land directly in viewBox space. */
  function mountInteractive(options: ReturnType<typeof defaultFigureOptions>) {
    const data = lineData();
    const onZoom = vi.fn();
    const onResetZoom = vi.fn();
    const { container } = render(
      <FigureSvg data={data} options={options} interactive onZoom={onZoom} onResetZoom={onResetZoom} />,
    );
    const svg = container.querySelector("svg") as SVGSVGElement;
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: options.width, bottom: options.height, width: options.width, height: options.height, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const wheel = (init: WheelEventInit) =>
      svg.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init }));
    return { svg, onZoom, onResetZoom, wheel, width: options.width, height: options.height };
  }

  it("scroll up lowers the y-max (peaks grow) with the floor pinned", () => {
    const { onZoom, wheel, width, height } = mountInteractive(defaultFigureOptions(lineData()));
    wheel({ deltaY: -120, clientX: width / 2, clientY: height / 2 });
    expect(onZoom).toHaveBeenCalledTimes(1);
    const next = onZoom.mock.calls[0][0];
    expect(next.x).toBeUndefined(); // x is untouched
    expect(next.y.min).toBe(0); // floor pinned at the baseline
    expect(next.y.max).toBeCloseTo(80, 5); // 0 + (100 - 0) * 0.8
  });

  it("scroll down raises the y-max (peaks shrink)", () => {
    const { onZoom, wheel, width, height } = mountInteractive(defaultFigureOptions(lineData()));
    wheel({ deltaY: 120, clientX: width / 2, clientY: height / 2 });
    const next = onZoom.mock.calls[0][0];
    expect(next.y.min).toBe(0);
    expect(next.y.max).toBeCloseTo(125, 5); // 0 + 100 * 1.25
  });

  it("ignores scrolls outside the plot area", () => {
    const { onZoom, wheel } = mountInteractive(defaultFigureOptions(lineData()));
    wheel({ deltaY: -120, clientX: 2, clientY: 2 }); // top-left margin, not the plot
    expect(onZoom).not.toHaveBeenCalled();
  });

  it("double-click resets the zoom", () => {
    const { svg, onResetZoom } = mountInteractive(defaultFigureOptions(lineData()));
    fireEvent.doubleClick(svg);
    expect(onResetZoom).toHaveBeenCalledTimes(1);
  });
});

describe("FigureSvg — legend", () => {
  /** The legend rows' wording (every <text> that isn't a tick or a peak label). */
  const legendTexts = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("text")).map((t) => t.textContent);

  function twoSeries(): FigureData {
    return {
      x: [1, 2],
      series: [
        { id: "sticks:a", label: "ladder A", x: [1], y: [5], styleHints: { kind: "sticks", color: "#d946ef" } },
        { id: "sticks:b", label: "ladder B", x: [2], y: [7], styleHints: { kind: "sticks", color: "#0ea5e9" } },
      ],
      xLabel: "m/z",
      yLabel: "Intensity",
      peakLabels: [],
    };
  }

  it("names one entry per visible series by default", () => {
    const data = twoSeries();
    const options = defaultFigureOptions(data);
    expect(options.legend.show).toBe(true);
    const { container } = render(<FigureSvg data={data} options={options} decimate={false} />);
    expect(legendTexts(container)).toEqual(expect.arrayContaining(["ladder A", "ladder B"]));
  });

  it("renames an entry and drops one the user hid", () => {
    const data = twoSeries();
    const base = defaultFigureOptions(data);
    const options = {
      ...base,
      legend: {
        ...base.legend,
        entries: { "sticks:a": { text: "PEG-OH" }, "sticks:b": { show: false } },
      },
    };
    const { container } = render(<FigureSvg data={data} options={options} decimate={false} />);
    const texts = legendTexts(container);
    expect(texts).toContain("PEG-OH");
    expect(texts).not.toContain("ladder A");
    expect(texts).not.toContain("ladder B");
  });

  it("lists a series the plot is hiding when the entry forces it on", () => {
    const data = twoSeries();
    const base = defaultFigureOptions(data);
    const options = {
      ...base,
      series: base.series.map((s) => (s.id === "sticks:b" ? { ...s, visible: false } : s)),
      legend: { ...base.legend, entries: { "sticks:b": { show: true } } },
    };
    const { container } = render(<FigureSvg data={data} options={options} decimate={false} />);
    expect(legendTexts(container)).toContain("ladder B");
  });

  it("draws the key as a dot instead of a line sample", () => {
    const data = twoSeries();
    const base = defaultFigureOptions(data);
    const lines = (o: typeof base) =>
      render(<FigureSvg data={data} options={o} decimate={false} />).container.querySelectorAll("line");
    const withLine = lines(base).length;
    const dotOptions = { ...base, legend: { ...base.legend, marker: "dot" as const } };
    const { container } = render(<FigureSvg data={data} options={dotOptions} decimate={false} />);
    // Two line samples become two circles in the series' own colours.
    expect(container.querySelectorAll("line").length).toBe(withLine - 2);
    const fills = Array.from(container.querySelectorAll("circle")).map((c) => c.getAttribute("fill"));
    expect(fills).toEqual(expect.arrayContaining(["#d946ef", "#0ea5e9"]));
  });

  it("a uniform stick colour repaints the stems but not the legend key", () => {
    const data = twoSeries();
    const base = defaultFigureOptions(data);
    const options = { ...base, stickColor: "#333333" };
    const { container } = render(<FigureSvg data={data} options={options} decimate={false} />);
    const strokes = Array.from(container.querySelectorAll("path")).map((p) => p.getAttribute("stroke"));
    expect(strokes).toEqual(["#333333", "#333333"]);
    // The legend keys still carry each series' colour — it is a key to the data.
    const keyStrokes = Array.from(container.querySelectorAll("line")).map((l) => l.getAttribute("stroke"));
    expect(keyStrokes).toEqual(expect.arrayContaining(["#d946ef", "#0ea5e9"]));
  });
});

describe("FigureSvg — legend, rendering splits", () => {
  /** A ladder whose sticks the adapter split because one peak was recoloured. */
  function splitData(): FigureData {
    return {
      x: [1, 2],
      series: [
        { id: "sticks:a", label: "ladder A", x: [1], y: [5], styleHints: { kind: "sticks", color: "#d946ef" } },
        {
          id: "sticks:a:c:#ff0000",
          label: "ladder A",
          x: [2],
          y: [7],
          styleHints: { kind: "sticks", color: "#ff0000" },
          legendHidden: true,
        },
      ],
      xLabel: "m/z",
      yLabel: "Intensity",
      peakLabels: [],
    };
  }

  const legendRows = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("text")).filter((t) => t.textContent === "ladder A").length;

  it("keeps a legendHidden series out of the legend without hiding its data", () => {
    const data = splitData();
    const options = defaultFigureOptions(data);
    const { container } = render(<FigureSvg data={data} options={options} decimate={false} />);
    expect(legendRows(container)).toBe(1); // not two identical rows
    expect(container.querySelectorAll("path").length).toBe(2); // both stick sets still drawn
  });

  it("an explicit show override puts it back", () => {
    const data = splitData();
    const base = defaultFigureOptions(data);
    const options = {
      ...base,
      legend: { ...base.legend, show: true, entries: { "sticks:a:c:#ff0000": { show: true } } },
    };
    const { container } = render(<FigureSvg data={data} options={options} decimate={false} />);
    expect(legendRows(container)).toBe(2);
  });
});

describe("FigureSvg — label thinning priority", () => {
  /** Two files stacked: the second sits 1000 above the first, so its drawn
   *  heights dwarf the first's even though its peaks are tiny. */
  function stackedData(withPriority: boolean): FigureData {
    const label = (id: string, x: number, y: number, priority: number) => ({
      id,
      x,
      y,
      text: id,
      ...(withPriority ? { priority } : {}),
    });
    return {
      x: [100, 900],
      series: [
        {
          id: "sticks:a",
          label: "file A",
          x: [100],
          y: [500],
          styleHints: { kind: "sticks" as const },
        },
        {
          id: "sticks:b",
          label: "file B",
          x: [900],
          y: [1001],
          baseline: 1000,
          styleHints: { kind: "sticks" as const },
        },
      ],
      xLabel: "m/z",
      yLabel: "Intensity",
      // A tall peak in file A (500) and a tiny one in file B (1), drawn at 1001
      // because of B's stacking offset.
      peakLabels: [label("tall", 100, 500, 500), label("tiny", 900, 1001, 1)],
    };
  }

  const drawn = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("text")).map((t) => t.textContent);

  it("ranks by the host's priority, so a stacked file cannot outrank a taller peak", () => {
    const data = stackedData(true);
    const base = defaultFigureOptions(data);
    const options = { ...base, peakLabels: { ...base.peakLabels, decimals: -1, maxLabels: 1 } };
    const { container } = render(<FigureSvg data={data} options={options} decimate={false} />);
    expect(drawn(container)).toContain("tall");
    expect(drawn(container)).not.toContain("tiny");
  });

  it("falls back to the drawn height when no priority is supplied", () => {
    const data = stackedData(false);
    const base = defaultFigureOptions(data);
    const options = { ...base, peakLabels: { ...base.peakLabels, decimals: -1, maxLabels: 1 } };
    const { container } = render(<FigureSvg data={data} options={options} decimate={false} />);
    expect(drawn(container)).toContain("tiny");
    expect(drawn(container)).not.toContain("tall");
  });
});

describe("FigureSvg — custom legend lines", () => {
  const withLegend = () => {
    const data = msData();
    const base = defaultFigureOptions(data);
    return {
      data,
      base: { ...base, legend: { ...base.legend, show: true } },
    };
  };

  it("draws a note row that keys nothing the figure plots", () => {
    // The gap this fills: the per-series overrides can only rename or hide rows
    // that already exist, so a caption about a few peaks had nowhere to go.
    const { data, base } = withLegend();
    const options = {
      ...base,
      legend: {
        ...base.legend,
        notes: [{ id: "n1", text: "* = matrix cluster", color: "#22c55e" }],
      },
    };
    const { container } = render(<FigureSvg data={data} options={options} decimate={false} />);
    const texts = Array.from(container.querySelectorAll("text")).map((t) => t.textContent);
    expect(texts).toContain("* = matrix cluster");
    expect(container.querySelector('line[stroke="#22c55e"]')).not.toBeNull();
  });

  it("draws a colourless note as plain text with no key", () => {
    const { data, base } = withLegend();
    const options = {
      ...base,
      legend: { ...base.legend, notes: [{ id: "n1", text: "shaded = replicate", color: null }] },
    };
    const { container } = render(<FigureSvg data={data} options={options} decimate={false} />);
    const texts = Array.from(container.querySelectorAll("text")).map((t) => t.textContent);
    expect(texts).toContain("shaded = replicate");
    expect(container.querySelector('line[stroke="#22c55e"]')).toBeNull();
  });

  it("skips a blank note so a half-typed row never renders", () => {
    const { data, base } = withLegend();
    const withNote = {
      ...base,
      legend: { ...base.legend, notes: [{ id: "n1", text: "  ", color: "#22c55e" }] },
    };
    const { container } = render(<FigureSvg data={data} options={withNote} decimate={false} />);
    expect(container.querySelector('line[stroke="#22c55e"]')).toBeNull();
  });

  it("shows notes even when no series is in the legend", () => {
    // A single-trace figure defaults the legend off; turning it on for a note
    // alone must still produce a box.
    const { data, base } = withLegend();
    const options = {
      ...base,
      legend: {
        ...base.legend,
        entries: { profile: { show: false }, sticks: { show: false } },
        notes: [{ id: "n1", text: "n = 12 shoulder", color: "#d946ef" }],
      },
    };
    const { container } = render(<FigureSvg data={data} options={options} decimate={false} />);
    const texts = Array.from(container.querySelectorAll("text")).map((t) => t.textContent);
    expect(texts).toContain("n = 12 shoulder");
    expect(texts).not.toContain("peaks");
  });
});
