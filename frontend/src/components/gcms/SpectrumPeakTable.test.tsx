import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SpectrumPeakTable } from "./SpectrumPeakTable";
import type { SpectrumPeakRow } from "@/lib/gcms/types";

const peaks: SpectrumPeakRow[] = [
  { id: "p100", mz: 100, intensity: 50, relPct: 50, sourceLabel: "Peak 1" },
  { id: "p200", mz: 200, intensity: 100, relPct: 100, sourceLabel: "Peak 2" },
];

const sourceProps = {
  sources: [
    { id: "live", label: "Live peak view" },
    { id: "chrom:all", label: "All chromatogram peaks (2)" },
  ],
  sourceId: "chrom:all",
  onSourceChange: vi.fn(),
};

describe("SpectrumPeakTable XIC actions", () => {
  it("requests one separate chromatogram per selected spectrum peak", () => {
    const onXicSelected = vi.fn();
    render(
      <div style={{ height: 420 }}>
        <SpectrumPeakTable
          peaks={peaks}
          {...sourceProps}
          onXicSelected={onXicSelected}
          onAddPeak={() => null}
          onDeletePeak={() => {}}
        />
      </div>,
    );

    fireEvent.click(screen.getByText("100.000").closest("tr")!);
    fireEvent.click(screen.getByText("200.000").closest("tr")!);
    fireEvent.click(screen.getByRole("button", { name: "Separate XICs" }));

    expect(onXicSelected).toHaveBeenCalledWith([100, 200], "separate");
  });

  it("keeps the combined XIC option for summed-ion workflows", () => {
    const onXicSelected = vi.fn();
    render(
      <div style={{ height: 420 }}>
        <SpectrumPeakTable
          peaks={peaks}
          {...sourceProps}
          onXicSelected={onXicSelected}
          onAddPeak={() => null}
          onDeletePeak={() => {}}
        />
      </div>,
    );

    fireEvent.click(screen.getByText("100.000").closest("tr")!);
    fireEvent.click(screen.getByRole("button", { name: "Combined XIC" }));

    expect(onXicSelected).toHaveBeenCalledWith([100], "combined");
  });

  it("switches between live, all, and individual chromatogram peak sources", () => {
    const onSourceChange = vi.fn();
    render(
      <div style={{ height: 420 }}>
        <SpectrumPeakTable
          peaks={peaks}
          sources={[
            { id: "live", label: "Live peak view" },
            { id: "chrom:all", label: "All chromatogram peaks (2)" },
            { id: "chrom:peak-1", label: "Peak 1 · RT 1.000 (0.900–1.100)" },
          ]}
          sourceId="live"
          onSourceChange={onSourceChange}
          onXicSelected={() => {}}
          onAddPeak={() => null}
          onDeletePeak={() => {}}
        />
      </div>,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Spectrum peak source" }), {
      target: { value: "chrom:all" },
    });

    expect(onSourceChange).toHaveBeenCalledWith("chrom:all");
    expect(screen.getByText("Peak 1")).toBeInTheDocument();
    expect(screen.getByText("Peak 2")).toBeInTheDocument();
  });
});
