import { describe, expect, it } from "vitest";
import {
  buildIntegralCurve,
  deriveSignals,
  signalSelectionAtomIndices,
} from "./signals";

describe("deriveSignals", () => {
  it("groups equivalent proton assignments into a single signal with integration", () => {
    const signals = deriveSignals(
      [
        {
          atom_index: 4,
          shift: 1.25,
          element: "H",
          engine: "cdk",
          assignment_group: "h@0",
          attached_atom_index: 0,
          multiplicity: "t",
          coupling_hz: 7,
        },
        {
          atom_index: 5,
          shift: 1.27,
          element: "H",
          engine: "cdk",
          assignment_group: "h@0",
          attached_atom_index: 0,
          multiplicity: "t",
          coupling_hz: 7,
        },
        {
          atom_index: 6,
          shift: 1.26,
          element: "H",
          engine: "cdk",
          assignment_group: "h@0",
          attached_atom_index: 0,
          multiplicity: "t",
          coupling_hz: 7,
        },
      ],
      "1H",
      "individual",
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      integration: 3,
      multiplicity: "t",
      attachedAtomIndices: [0],
      assignmentText: "H4-H6 on atom #0",
    });
    expect(signals[0].lines).toHaveLength(3);
  });

  it("keeps mixed-spectrum components separate even when atom numbering overlaps", () => {
    const signals = deriveSignals(
      [
        {
          atom_index: 3,
          shift: 1.24,
          element: "H",
          engine: "cdk",
          source_id: "component-a",
          source_label: "Component 1",
          assignment_group: "h@0",
          attached_atom_index: 0,
        },
        {
          atom_index: 3,
          shift: 1.24,
          element: "H",
          engine: "cdk",
          source_id: "component-b",
          source_label: "Component 2",
          assignment_group: "h@0",
          attached_atom_index: 0,
        },
      ],
      "1H",
      "individual",
    );

    expect(signals).toHaveLength(2);
    expect(signals.map((signal) => signal.sourceId)).toEqual(["component-a", "component-b"]);
  });

  it("merges symmetry-equivalent protons on different anchors into a single peak", () => {
    const signals = deriveSignals(
      [
        {
          atom_index: 10,
          shift: 6.80,
          element: "H",
          engine: "cascade",
          assignment_group: "h_sym:7",
          attached_atom_index: 2,
          multiplicity: "d",
          coupling_hz: 8,
        },
        {
          atom_index: 11,
          shift: 6.95,
          element: "H",
          engine: "cascade",
          assignment_group: "h_sym:7",
          attached_atom_index: 5,
          multiplicity: "d",
          coupling_hz: 8,
        },
      ],
      "1H",
      "individual",
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      integration: 2,
      attachedAtomIndices: [2, 5],
    });
    expect(signals[0].center).toBeCloseTo(6.875, 3);
  });

  it("renders zero-coupling multiplets as a single line", () => {
    const signals = deriveSignals(
      [
        {
          atom_index: 3,
          shift: 1.24,
          element: "H",
          engine: "cdk",
          assignment_group: "h@0",
          attached_atom_index: 0,
          multiplicity: "d",
          coupling_hz: 0,
        },
      ],
      "1H",
      "individual",
    );

    expect(signals).toHaveLength(1);
    expect(signals[0].lines).toEqual([{ shift: 1.24, intensity: expect.any(Number) }]);
  });
});

describe("buildIntegralCurve", () => {
  it("returns a step-like integral for proton signals", () => {
    const curve = buildIntegralCurve(
      [
        {
          id: "a",
          center: 3.5,
          atomIndices: [1, 2],
          representativeAtomIndex: 1,
          attachedAtomIndices: [0],
          assignmentText: "H1-H2 on atom #0",
          integration: 2,
          lines: [{ shift: 3.5, intensity: 1 }],
        },
        {
          id: "b",
          center: 1.2,
          atomIndices: [3, 4, 5],
          representativeAtomIndex: 3,
          attachedAtomIndices: [1],
          assignmentText: "H3-H5 on atom #1",
          integration: 3,
          lines: [{ shift: 1.2, intensity: 1 }],
        },
      ],
      [0.5, 12],
    );

    expect(curve).not.toBeNull();
    expect(curve?.x.length).toBe(curve?.y.length);
    expect(curve?.y.at(-1)).toBeGreaterThan(curve?.y[0] ?? 0);
  });
});

describe("signalSelectionAtomIndices", () => {
  it("uses the attached heavy atoms for proton assignments in the editor", () => {
    expect(
      signalSelectionAtomIndices(
        {
          atomIndices: [4, 5, 6],
          attachedAtomIndices: [0],
        },
        "1H",
      ),
    ).toEqual([0]);
  });

  it("returns every symmetry-equivalent anchor for a merged proton signal", () => {
    expect(
      signalSelectionAtomIndices(
        {
          atomIndices: [10, 11, 12, 13],
          attachedAtomIndices: [2, 5],
        },
        "1H",
      ),
    ).toEqual([2, 5]);
  });

  it("falls back to the predicted atom indices for non-proton signals", () => {
    expect(
      signalSelectionAtomIndices(
        {
          atomIndices: [2],
          attachedAtomIndices: [],
        },
        "13C",
      ),
    ).toEqual([2]);
  });
});
