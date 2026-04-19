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
      attachedAtomIndex: 0,
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
          assignmentText: "H1-H2 on atom #0",
          integration: 2,
          lines: [{ shift: 3.5, intensity: 1 }],
        },
        {
          id: "b",
          center: 1.2,
          atomIndices: [3, 4, 5],
          representativeAtomIndex: 3,
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
  it("uses the attached heavy atom for proton assignments in the editor", () => {
    expect(
      signalSelectionAtomIndices(
        {
          atomIndices: [4, 5, 6],
          attachedAtomIndex: 0,
        },
        "1H",
      ),
    ).toEqual([0]);
  });

  it("falls back to the predicted atom indices for non-proton signals", () => {
    expect(
      signalSelectionAtomIndices(
        {
          atomIndices: [2],
        },
        "13C",
      ),
    ).toEqual([2]);
  });
});
