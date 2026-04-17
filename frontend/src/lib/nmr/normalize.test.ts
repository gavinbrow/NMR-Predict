import { describe, expect, it } from "vitest";
import type { PredictRequest } from "@/types/nmr";
import {
  normalizeEnginesResponse,
  normalizeOptionsResponse,
  normalizePredictResponse,
} from "./normalize";

describe("normalizeOptionsResponse", () => {
  it("maps backend engine names to the frontend options shape", () => {
    const normalized = normalizeOptionsResponse({
      nuclei: ["1H", "13C"],
      modes: ["individual", "consensus"],
      conformer_strategies: ["fast", "goat"],
      engines: ["cdk", "cascade", "orca"],
    });

    expect(normalized.engine_names).toEqual(["cdk", "cascade", "orca"]);
  });
});

describe("normalizeEnginesResponse", () => {
  it("maps backend engine messages onto the UI reason field", () => {
    const normalized = normalizeEnginesResponse([
      {
        name: "orca",
        ready: false,
        implemented: true,
        default_weight: 0.2,
        message: "ORCA binary not found",
      },
    ]);

    expect(normalized[0].reason).toBe("ORCA binary not found");
  });
});

describe("normalizePredictResponse", () => {
  it("flattens an individual-mode backend response into UI shifts", () => {
    const request: PredictRequest = {
      smiles: "CCO",
      engines: ["cdk"],
      mode: "individual",
      nucleus: "13C",
      conformer_strategy: "fast",
    };

    const normalized = normalizePredictResponse(
      {
        canonical_smiles: "CCO",
        atom_symbols: ["C", "C", "O"],
        engines: {
          cdk: {
            engine: "cdk",
            status: "ok",
            shifts: [
              { atom_index: 0, symbol: "C", shift_ppm: 58.2 },
              { atom_index: 1, symbol: "C", shift_ppm: 18.4 },
            ],
          },
        },
        consensus: null,
      },
      request,
    );

    expect(normalized.shifts).toEqual([
      {
        atom_index: 0,
        element: "C",
        shift: 58.2,
        intensity: 1,
        engine: "cdk",
        std: undefined,
        attached_atom_index: undefined,
        assignment_group: undefined,
        multiplicity: undefined,
        coupling_hz: undefined,
        neighbor_count: undefined,
      },
      {
        atom_index: 1,
        element: "C",
        shift: 18.4,
        intensity: 1,
        engine: "cdk",
        std: undefined,
        attached_atom_index: undefined,
        assignment_group: undefined,
        multiplicity: undefined,
        coupling_hz: undefined,
        neighbor_count: undefined,
      },
    ]);
  });

  it("uses the consensus block for consensus-mode results and preserves engine warnings", () => {
    const request: PredictRequest = {
      smiles: "CCO",
      engines: ["cdk", "orca"],
      mode: "consensus",
      nucleus: "13C",
      conformer_strategy: "fast",
      weights: { cdk: 0.7, orca: 0.3 },
    };

    const normalized = normalizePredictResponse(
      {
        canonical_smiles: "CCO",
        atom_symbols: ["C", "C", "O"],
        engines: {
          cdk: {
            engine: "cdk",
            status: "ok",
            shifts: [{ atom_index: 0, symbol: "C", shift_ppm: 57.9 }],
          },
          orca: {
            engine: "orca",
            status: "error",
            shifts: [],
            message: "ORCA executable not configured",
          },
        },
        consensus: {
          shifts: [
            {
              atom_index: 0,
              symbol: "C",
              shift_ppm: 57.9,
              std_ppm: 0.4,
              contributing_engines: ["cdk"],
            },
          ],
          weights_used: { cdk: 1 },
        },
      },
      request,
    );

    expect(normalized.shifts).toEqual([
      {
        atom_index: 0,
        element: "C",
        shift: 57.9,
        intensity: 1,
        engine: undefined,
        std: 0.4,
        attached_atom_index: undefined,
        assignment_group: undefined,
        multiplicity: undefined,
        coupling_hz: undefined,
        neighbor_count: undefined,
      },
    ]);
    expect(normalized.engines_used).toEqual(["cdk"]);
    expect(normalized.warnings).toEqual(["orca: ORCA executable not configured"]);
  });

  it("preserves proton annotation metadata for the viewer", () => {
    const request: PredictRequest = {
      smiles: "CCO",
      engines: ["cdk"],
      mode: "individual",
      nucleus: "1H",
      conformer_strategy: "fast",
    };

    const normalized = normalizePredictResponse(
      {
        canonical_smiles: "CCO",
        atom_symbols: ["C", "C", "O", "H"],
        engines: {
          cdk: {
            engine: "cdk",
            status: "ok",
            shifts: [
              {
                atom_index: 3,
                symbol: "H",
                shift_ppm: 1.21,
                attached_atom_index: 0,
                assignment_group: "h@0",
                multiplicity: "t",
                coupling_hz: 7.0,
                neighbor_count: 2,
              },
            ],
          },
        },
        consensus: null,
      },
      request,
    );

    expect(normalized.shifts[0]).toMatchObject({
      atom_index: 3,
      element: "H",
      shift: 1.21,
      attached_atom_index: 0,
      assignment_group: "h@0",
      multiplicity: "t",
      coupling_hz: 7.0,
      neighbor_count: 2,
    });
  });
});
