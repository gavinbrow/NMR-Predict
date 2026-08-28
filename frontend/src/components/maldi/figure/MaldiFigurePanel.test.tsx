// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MaldiFigurePanel, type MaldiFigureFileInfo } from "./MaldiFigurePanel";
import { defaultFigureOptions, type FigureData } from "@/lib/ir/figure";
import type { Peak, SpectrumData } from "@/lib/maldi/types";

// Composing a MULTI-SPECTRUM figure has to be possible from inside the Figure
// tab: the figure maker opens fullscreen, where the Documents panel — the only
// other place a spectrum can be drawn, scaled or stacked — is not on screen.
// These tests pin that reach down, and pin down that it is still the Documents
// panel's own state being driven (one visibility flag, one stack), not a second
// figure-local copy of it.

const spectrum: SpectrumData = {
  mz: new Float64Array([100, 200, 300]),
  intensity: new Float64Array([0, 50, 100]),
};

const peak = (id: string): Peak => ({ id, mz: 200, intensity: 50, accepted: true });

const data: FigureData = {
  x: [100, 200, 300],
  xLabel: "m/z",
  yLabel: "Intensity",
  series: [{ id: "profile:a", label: "A", y: [0, 50, 100] }],
  peakLabels: [],
};

const file = (over: Partial<MaldiFigureFileInfo> & { id: string }): MaldiFigureFileInfo => ({
  name: over.id.toUpperCase(),
  color: "#0ea5e9",
  visible: true,
  active: false,
  peakCount: 1,
  scale: 1,
  offset: 0,
  ladders: [],
  ...over,
});

type Handlers = {
  onToggleFileVisible: ReturnType<typeof vi.fn>;
  onSetFileOffset: ReturnType<typeof vi.fn>;
  onStackedChange: ReturnType<typeof vi.fn>;
};

function mount(files: MaldiFigureFileInfo[], stacked = false) {
  const handlers: Handlers = {
    onToggleFileVisible: vi.fn(),
    onSetFileOffset: vi.fn(),
    onStackedChange: vi.fn(),
  };
  render(
    <MaldiFigurePanel
      active={spectrum}
      peaks={[peak("p1")]}
      showProfile
      onShowProfileChange={() => {}}
      showSticks
      onShowSticksChange={() => {}}
      selectedOnly={false}
      onSelectedOnlyChange={() => {}}
      includeFlagged={false}
      onIncludeFlaggedChange={() => {}}
      shownPeaks={[peak("p1")]}
      files={files}
      selectedSeriesIds={new Set()}
      onToggleSeries={() => {}}
      onToggleFileSeries={() => {}}
      onSetFileScale={() => {}}
      onToggleFileVisible={handlers.onToggleFileVisible}
      onSetFileOffset={handlers.onSetFileOffset}
      stacked={stacked}
      onStackedChange={handlers.onStackedChange}
      hiddenPeakCount={0}
      onRestorePeaks={() => {}}
      onDeletePeak={() => {}}
      onSetPeakColor={() => {}}
      figureData={data}
      figureOptions={defaultFigureOptions(data)}
      onFigureOptionsChange={() => {}}
    />,
  );
  return handlers;
}

/** The per-spectrum "draw this" tick, by the file's name. */
const drawBox = (name: string) =>
  screen.getByRole("checkbox", { name: `Draw ${name} in the figure` }) as HTMLInputElement;

describe("MaldiFigurePanel — putting more than one spectrum in a figure", () => {
  it("lists every open spectrum, drawn or not, and ticks the drawn ones", () => {
    mount([
      file({ id: "a", active: true }),
      file({ id: "b", visible: false }),
    ]);
    expect(drawBox("A").checked).toBe(true);
    expect(drawBox("B").checked).toBe(false);
    // A hidden spectrum says so where its peak count would be, so the row can't
    // be mistaken for one that is drawn but empty.
    expect(screen.getByText("not drawn")).toBeInTheDocument();
    expect(screen.getByText("1 of 2 spectra")).toBeInTheDocument();
  });

  it("adds a second spectrum to the figure from here", () => {
    const h = mount([file({ id: "a", active: true }), file({ id: "b", visible: false })]);
    fireEvent.click(drawBox("B"));
    expect(h.onToggleFileVisible).toHaveBeenCalledWith("b", true);
  });

  it("won't let the active spectrum be unticked out of its own figure", () => {
    mount([file({ id: "a", active: true }), file({ id: "b" })]);
    // The host forces the active document visible, so an enabled box that sprang
    // back would just look broken.
    expect(drawBox("A").disabled).toBe(true);
    expect(drawBox("B").disabled).toBe(false);
  });

  it("offers a spectrum's ladders and its numbers only while it is drawn", () => {
    mount([
      file({ id: "a", active: true, ladders: [{ id: "l1", label: "PEG [M+Na]+", color: "#f00" }] }),
      file({ id: "b", visible: false, ladders: [{ id: "l2", label: "PMMA [M+H]+", color: "#00f" }] }),
    ]);
    expect(screen.getByText("PEG [M+Na]+")).toBeInTheDocument();
    // A tick on a hidden spectrum's ladder would read as "draw only this ladder"
    // and empty the figure, with nothing on screen to explain why.
    expect(screen.queryByText("PMMA [M+H]+")).toBeNull();
    expect(screen.getByLabelText("Vertical offset for A")).toBeInTheDocument();
    expect(screen.queryByLabelText("Vertical offset for B")).toBeNull();
  });

  it("needs a second spectrum before it offers to stack", () => {
    mount([file({ id: "a", active: true })]);
    // One spectrum has nothing to be stacked against, and a lone spectrum lifted
    // off its own baseline is just a figure with a wrong y-axis.
    expect(screen.getByRole("switch", { name: /stack spectra/i })).toBeDisabled();
  });

  it("hands the stack toggle straight to the host's shared state", () => {
    const h = mount([file({ id: "a", active: true }), file({ id: "b" })]);
    const stack = screen.getByRole("switch", { name: /stack spectra/i });
    expect(stack).not.toBeDisabled();
    fireEvent.click(stack);
    expect(h.onStackedChange).toHaveBeenCalledWith(true);
  });

  it("nudges one spectrum up the stack on its own", () => {
    const h = mount([file({ id: "a", active: true }), file({ id: "b" })], true);
    fireEvent.change(screen.getByLabelText("Vertical offset for B"), {
      target: { value: "250" },
    });
    expect(h.onSetFileOffset).toHaveBeenCalledWith("b", 250);
  });
});
