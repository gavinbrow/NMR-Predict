import { describe, expect, it } from "vitest";
import { buildNmriumViewerModel } from "./nmrium";

describe("buildNmriumViewerModel", () => {
  it("creates a single consensus spectrum model", () => {
    const model = buildNmriumViewerModel(
      [
        { atom_index: 0, shift: 7.2, element: "H", attached_atom_index: 1, assignment_group: "ar-1", multiplicity: "d" },
        { atom_index: 1, shift: 2.1, element: "H", attached_atom_index: 2, assignment_group: "me-1", multiplicity: "s" },
      ],
      "1H",
      "consensus",
      16,
    );

    expect(model.state.version).toBe(16);
    expect(model.state.data?.spectra).toHaveLength(1);
    expect(model.state.data?.spectra[0]?.info?.name).toBe("Consensus prediction");
  });

  it("creates one synthetic spectrum per engine in individual mode", () => {
    const model = buildNmriumViewerModel(
      [
        { atom_index: 0, shift: 7.25, element: "H", engine: "cdk", assignment_group: "ar-1", multiplicity: "d" },
        { atom_index: 1, shift: 7.15, element: "H", engine: "cdk", assignment_group: "ar-1", multiplicity: "d" },
        { atom_index: 0, shift: 7.35, element: "H", engine: "cascade", assignment_group: "ar-1", multiplicity: "d" },
      ],
      "1H",
      "individual",
      16,
    );

    const spectra = model.state.data?.spectra ?? [];

    expect(spectra).toHaveLength(2);
    expect(spectra.map((spectrum) => spectrum.info?.name)).toEqual(["cdk", "cascade"]);
    expect(model.state.view?.spectra?.showLegend).toBe(false);
    expect(
      spectra.every(
        (spectrum) =>
          typeof (spectrum.display as { color?: string } | undefined)?.color === "string",
      ),
    ).toBe(true);
  });
});
