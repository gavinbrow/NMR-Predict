import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MoleculeEditor } from "./MoleculeEditor";

vi.mock("ketcher-react/dist/index.css", () => ({}));
vi.mock("ketcher-react", () => {
  throw new Error("Ketcher unavailable in test");
});
vi.mock("ketcher-standalone", () => {
  throw new Error("Ketcher unavailable in test");
});

describe("MoleculeEditor", () => {
  it("keeps the manual SMILES fallback controlled by parent state", async () => {
    const onSmilesChange = vi.fn();
    const { rerender } = render(<MoleculeEditor value="CCO" onSmilesChange={onSmilesChange} />);

    const textarea = await screen.findByPlaceholderText("Enter a SMILES string, e.g. CCO");
    expect(textarea).toHaveValue("CCO");

    rerender(<MoleculeEditor value="CCC" onSmilesChange={onSmilesChange} />);
    expect(await screen.findByPlaceholderText("Enter a SMILES string, e.g. CCO")).toHaveValue(
      "CCC",
    );

    fireEvent.change(textarea, { target: { value: "CO" } });
    expect(onSmilesChange).toHaveBeenCalledWith("CO");
  });
});
