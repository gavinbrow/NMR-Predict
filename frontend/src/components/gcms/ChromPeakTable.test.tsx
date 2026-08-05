import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ChromPeak } from "@/lib/gcms/types";
import { ChromPeakTable } from "./ChromPeakTable";

const peak: ChromPeak = {
  id: "peak-1",
  runId: "run-1",
  traceId: "trace-1",
  rtApex: 7.401,
  rtStart: 7.2,
  rtEnd: 7.6,
  scanApex: 1247,
  height: 123_456,
  area: 987_654,
  areaPct: 12.34,
  basePeakMz: 162.3,
  name: "Example",
};

function renderTable(overrides?: {
  onRangeChange?: (id: string, start: number, end: number) => string | null;
  onRowClick?: (peak: ChromPeak) => void;
}) {
  const onRangeChange = vi.fn(overrides?.onRangeChange ?? (() => null));
  const onRowClick = vi.fn(overrides?.onRowClick ?? (() => undefined));
  render(
    <ChromPeakTable
      peaks={[peak]}
      onRowClick={onRowClick}
      onRangeChange={onRangeChange}
      onRename={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
  return { onRangeChange, onRowClick };
}

describe("ChromPeakTable range editing", () => {
  it("renders sortable Start/End columns, editable bounds, and the derived Width", () => {
    renderTable();

    expect(screen.getByRole("button", { name: /Start/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /End/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Width/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Peak 7.401 start retention time (min)")).toHaveValue(7.2);
    expect(screen.getByLabelText("Peak 7.401 end retention time (min)")).toHaveValue(7.6);
    expect(screen.getByText("0.400")).toBeInTheDocument();
  });

  it("commits the complete range on blur and Enter", () => {
    const { onRangeChange } = renderTable();
    const start = screen.getByLabelText("Peak 7.401 start retention time (min)");
    const end = screen.getByLabelText("Peak 7.401 end retention time (min)");

    fireEvent.change(start, { target: { value: "7.1" } });
    fireEvent.blur(start);
    expect(onRangeChange).toHaveBeenLastCalledWith("peak-1", 7.1, 7.6);

    fireEvent.change(end, { target: { value: "7.8" } });
    fireEvent.focus(end);
    fireEvent.keyDown(end, { key: "Enter" });
    expect(onRangeChange).toHaveBeenLastCalledWith("peak-1", 7.1, 7.8);
  });

  it("announces a callback validation error and Escape restores canonical bounds", () => {
    const { onRangeChange } = renderTable({
      onRangeChange: () => "Start retention time must precede end retention time.",
    });
    const start = screen.getByLabelText("Peak 7.401 start retention time (min)");
    const end = screen.getByLabelText("Peak 7.401 end retention time (min)");

    fireEvent.change(start, { target: { value: "8" } });
    fireEvent.blur(start);

    expect(onRangeChange).toHaveBeenCalledWith("peak-1", 8, 7.6);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Start retention time must precede end retention time.",
    );
    expect(start).toHaveAttribute("aria-invalid", "true");
    expect(end).toHaveAttribute("aria-invalid", "true");
    expect(start).toHaveAccessibleDescription(
      "Start retention time must precede end retention time.",
    );

    fireEvent.keyDown(start, { key: "Escape" });
    expect(start).toHaveValue(7.2);
    expect(end).toHaveValue(7.6);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not select the row when a range input is clicked", () => {
    const { onRowClick } = renderTable();

    fireEvent.click(screen.getByLabelText("Peak 7.401 start retention time (min)"));
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
