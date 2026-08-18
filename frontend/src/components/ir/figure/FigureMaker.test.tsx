// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { FigureMaker } from "./FigureMaker";
import { defaultFigureOptions, type FigureData, type FigureOptions } from "@/lib/ir/figure";

const data: FigureData = {
  x: [1, 2, 3],
  xLabel: "m/z",
  yLabel: "Intensity",
  series: [{ id: "trace", label: "trace", y: [0, 50, 100] }],
  peakLabels: [{ id: "p0", x: 2, y: 100, text: "2.00" }],
};

/** Render the maker with a host's options. These tests are about the shell —
 *  what the toggle opens and how it closes — so the options never change. */
function mount(props: { allowFullscreen?: boolean } = {}) {
  const options: FigureOptions = defaultFigureOptions(data);
  return render(<FigureMaker data={data} options={options} onChange={() => {}} {...props} />);
}

/** The fullscreen overlay, or null. It portals to <body>, so it is deliberately
 *  queried off the document rather than the render container. */
const overlay = () => document.body.querySelector('[aria-label="Figure maker, fullscreen"]');

describe("FigureMaker fullscreen", () => {
  beforeEach(() => {
    document.body.style.overflow = "";
  });

  it("offers the toggle by default", () => {
    mount();
    expect(screen.getByRole("button", { name: /fullscreen/i })).toBeInTheDocument();
    expect(overlay()).toBeNull();
  });

  it("hides the toggle when the host opts out", () => {
    mount({ allowFullscreen: false });
    expect(screen.queryByRole("button", { name: /fullscreen/i })).toBeNull();
  });

  it("opens an overlay portaled to <body>, with the controls beside the preview", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }));

    const ov = overlay();
    expect(ov).not.toBeNull();
    expect(ov!.parentElement).toBe(document.body);
    // The styling panel comes with it — a fullscreen preview you cannot restyle
    // is the thing this replaced.
    expect(within(ov as HTMLElement).getByText("Title & size")).toBeInTheDocument();
    // ...and so does the export bar.
    expect(within(ov as HTMLElement).getByText("Export")).toBeInTheDocument();
  });

  it("locks the page behind it and restores the previous overflow on exit", () => {
    document.body.style.overflow = "auto";
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }));
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));
    expect(overlay()).toBeNull();
    expect(document.body.style.overflow).toBe("auto");
  });

  it("leaves on Escape", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }));
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(overlay()).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("lets an open popup have Escape first", () => {
    // Every Select/Popover in the controls panel closes on Escape without
    // stopping the event. Dismissing one must not also close fullscreen — the
    // user would lose the view they opened to reach that control.
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }));

    const popper = document.createElement("div");
    popper.setAttribute("data-radix-popper-content-wrapper", "");
    document.body.appendChild(popper);
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(overlay()).not.toBeNull();

    popper.remove();
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(overlay()).toBeNull();
  });

  it("ignores an Escape another handler already claimed", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }));

    // `defaultPrevented` cannot be set through an event init — it has to be
    // earned, so claim the key from a capture-phase listener the way a real
    // dismissable layer would.
    const claim = (e: KeyboardEvent) => e.preventDefault();
    window.addEventListener("keydown", claim, true);
    try {
      act(() => {
        fireEvent.keyDown(window, { key: "Escape" });
      });
      expect(overlay()).not.toBeNull();
    } finally {
      window.removeEventListener("keydown", claim, true);
    }
  });
});
