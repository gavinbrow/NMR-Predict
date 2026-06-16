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
