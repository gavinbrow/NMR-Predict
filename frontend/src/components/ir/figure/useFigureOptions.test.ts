// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useFigureOptions } from "./useFigureOptions";
import type { FigureData, FigureOptions } from "@/lib/ir/figure";

/** A one-trace data set with the given axis labels. */
function data(yLabel: string, xLabel = "m/z"): FigureData {
  return {
    x: [1, 2, 3],
    xLabel,
    yLabel,
    series: [{ id: "trace", label: "trace", y: [0, 50, 100] }],
  };
}

describe("useFigureOptions", () => {
  it("starts with auto axis bounds", () => {
    const { result } = renderHook(() => useFigureOptions(data("Intensity")));
    expect(result.current[0].y.min).toBeNull();
    expect(result.current[0].y.max).toBeNull();
  });

  it("clears manual y bounds when the y unit changes", () => {
    // The MALDI case: the user scrolls the preview (which writes real numbers
    // into y.min/y.max), then a second document turns Normalize on and the axis
    // switches from counts to per cent. 0–8000 counts over 0–100 % data flattens
    // every trace onto the baseline.
    const { result, rerender } = renderHook(({ d }) => useFigureOptions(d), {
      initialProps: { d: data("Intensity") },
    });
    act(() => {
      const [options, setOptions] = result.current;
      setOptions({ ...options, y: { ...options.y, min: 0, max: 8000 } } as FigureOptions);
    });
    expect(result.current[0].y.max).toBe(8000);

    rerender({ d: data("Rel. intensity (%)") });
    expect(result.current[0].y.min).toBeNull();
    expect(result.current[0].y.max).toBeNull();
    expect(result.current[0].y.label).toBe("Rel. intensity (%)");
  });

  it("keeps the x window when only the y unit changes", () => {
    // An m/z window still means the same thing after the intensity unit moves,
    // so a drag-zoom the user set up must survive Normalize.
    const { result, rerender } = renderHook(({ d }) => useFigureOptions(d), {
      initialProps: { d: data("Intensity") },
    });
    act(() => {
      const [options, setOptions] = result.current;
      setOptions({ ...options, x: { ...options.x, min: 400, max: 900 } } as FigureOptions);
    });
    rerender({ d: data("Rel. intensity (%)") });
    expect(result.current[0].x.min).toBe(400);
    expect(result.current[0].x.max).toBe(900);
  });

  it("clears manual x bounds when the x unit changes", () => {
    const { result, rerender } = renderHook(({ d }) => useFigureOptions(d), {
      initialProps: { d: data("Intensity", "Wavenumber (cm⁻¹)") },
    });
    act(() => {
      const [options, setOptions] = result.current;
      setOptions({ ...options, x: { ...options.x, min: 400, max: 900 } } as FigureOptions);
    });
    rerender({ d: data("Intensity", "Wavelength (µm)") });
    expect(result.current[0].x.min).toBeNull();
    expect(result.current[0].x.max).toBeNull();
  });

  it("keeps a renamed axis title while still dropping its stale bounds", () => {
    const { result, rerender } = renderHook(({ d }) => useFigureOptions(d), {
      initialProps: { d: data("Intensity") },
    });
    act(() => {
      const [options, setOptions] = result.current;
      setOptions({
        ...options,
        y: { ...options.y, label: "My own label", min: 0, max: 8000 },
      } as FigureOptions);
    });
    rerender({ d: data("Rel. intensity (%)") });
    expect(result.current[0].y.label).toBe("My own label");
    expect(result.current[0].y.max).toBeNull();
  });
});
