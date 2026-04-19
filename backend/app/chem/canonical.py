"""RDKit canonicalization — single source of truth for atom ordering.

Every SMILES entering the system is parsed by RDKit, validated, then
re-emitted as canonical SMILES. Downstream engines (CASCADE, CDK, ORCA)
consume the canonical molecule so that atom index N means the same atom
in every engine's output.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

from rdkit import Chem
from rdkit.Chem import AllChem

from app.limits import MAX_HEAVY_ATOMS, MAX_SMILES_LENGTH, MAX_TOTAL_ATOMS


class InvalidSmilesError(ValueError):
    pass


@dataclass(frozen=True)
class CanonicalMolecule:
    input_smiles: str
    canonical_smiles: str
    mol: Chem.Mol
    atom_symbols: List[str]
    heavy_atom_count: int

    def atom_index_map(self) -> List[int]:
        # Identity map — canonical order is our reference.
        return list(range(self.mol.GetNumAtoms()))


def canonicalize(smiles: str, add_hs: bool = True) -> CanonicalMolecule:
    """Parse, sanitize, and canonicalize a SMILES string.

    Raises InvalidSmilesError if the input cannot be parsed or violates
    valence rules.
    """
    if not smiles or not smiles.strip():
        raise InvalidSmilesError("SMILES is empty")
    if len(smiles.strip()) > MAX_SMILES_LENGTH:
        raise InvalidSmilesError(
            f"SMILES is too long (max {MAX_SMILES_LENGTH} characters)"
        )

    mol = Chem.MolFromSmiles(smiles.strip())
    if mol is None:
        raise InvalidSmilesError(f"RDKit could not parse SMILES: {smiles!r}")

    try:
        Chem.SanitizeMol(mol)
    except (Chem.AtomValenceException, Chem.KekulizeException) as exc:
        raise InvalidSmilesError(f"Sanitization failed: {exc}") from exc

    canonical = Chem.MolToSmiles(mol, canonical=True)
    # Re-parse the canonical form so atom ordering matches the string.
    mol = Chem.MolFromSmiles(canonical)
    if mol is None:
        raise InvalidSmilesError("Canonical SMILES failed to round-trip")

    heavy = sum(1 for a in mol.GetAtoms() if a.GetAtomicNum() > 1)
    if heavy > MAX_HEAVY_ATOMS:
        raise InvalidSmilesError(
            f"Molecule is too large ({heavy} heavy atoms; max {MAX_HEAVY_ATOMS})"
        )

    if add_hs:
        mol = Chem.AddHs(mol)
        if mol.GetNumAtoms() > MAX_TOTAL_ATOMS:
            raise InvalidSmilesError(
                f"Molecule is too large after adding hydrogens "
                f"({mol.GetNumAtoms()} atoms; max {MAX_TOTAL_ATOMS})"
            )

    symbols = [atom.GetSymbol() for atom in mol.GetAtoms()]

    return CanonicalMolecule(
        input_smiles=smiles,
        canonical_smiles=canonical,
        mol=mol,
        atom_symbols=symbols,
        heavy_atom_count=heavy,
    )


def validate_smiles(smiles: str) -> Optional[str]:
    """Return None if valid, otherwise a human-readable error string."""
    try:
        canonicalize(smiles, add_hs=False)
        return None
    except InvalidSmilesError as exc:
        return str(exc)
