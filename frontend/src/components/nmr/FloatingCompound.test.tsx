import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FloatingCompound } from "./FloatingCompound";

const ETHANOL_MOLFILE = `
ethanol
  NMR Predict

  3  2  0  0  0  0            999 V2000
    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.5000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    3.0000    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0  0  0  0
  2  3  1  0  0  0  0
M  END
`.trimStart();

describe("FloatingCompound", () => {
  it("blows out attached hydrogens as separate bonds for highlighted carbon atoms", () => {
    const { container } = render(
      <FloatingCompound
        id="ethanol"
        label="Ethanol"
        smiles="CCO"
        molfile={ETHANOL_MOLFILE}
        hydrogenCounts={[3, 2, 1]}
        highlightedAtoms={[0]}
        initialX={0}
        initialY={0}
        onClose={vi.fn()}
      />,
    );

    const svgLabels = Array.from(container.querySelectorAll("svg text")).map(
      (label) => label.textContent,
    );

    expect(container.querySelectorAll("[data-virtual-hydrogen]").length).toBe(3);
    expect(container.querySelectorAll("[data-virtual-hydrogen-bond]").length).toBe(3);
    expect(svgLabels.filter((label) => label === "H")).toHaveLength(3);
    expect(svgLabels).not.toContain("C");

    const hydrogenBonds = Array.from(
      container.querySelectorAll<SVGLineElement>("[data-virtual-hydrogen-bond]"),
    );
    const bondLengths = hydrogenBonds.map((bond) => {
      const x1 = Number(bond.getAttribute("x1"));
      const y1 = Number(bond.getAttribute("y1"));
      const x2 = Number(bond.getAttribute("x2"));
      const y2 = Number(bond.getAttribute("y2"));
      return Math.hypot(x2 - x1, y2 - y1);
    });

    expect(bondLengths.every((length) => length > 14)).toBe(true);
  });
});
