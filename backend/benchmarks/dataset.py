"""Load and validate the curated reference dataset, and resolve reference
shift groups (SMARTS patterns) to canonical atom indices.

See ``data/README.md`` for the dataset schema and the SMARTS anchoring rules.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from rdkit import Chem

from app.chem.canonical import CanonicalMolecule, InvalidSmilesError, canonicalize

_DATA_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DATASET_PATH = os.path.join(_DATA_DIR, "data", "reference_shifts.json")

SCENARIOS = (
    "aliphatic",
    "aromatic",
    "carbonyl",
    "carboxylic_acid",
    "heteroatom_halogen",
    "conjugated_strained",
    "larger",
)

_NUCLEUS_TO_SYMBOL = {"13C": "C", "1H": "H"}


@dataclass(frozen=True)
class ReferenceShift:
    """One experimental reference value targeting a set of atoms via SMARTS."""

    group_smarts: str
    ppm: float
    exchangeable: bool = False


@dataclass(frozen=True)
class ReferenceMolecule:
    id: str
    name: str
    smiles: str
    scenario: str
    solvent: Optional[str] = None
    source: Optional[str] = None
    # nucleus -> list of reference shifts
    shifts: Dict[str, List[ReferenceShift]] = field(default_factory=dict)


@dataclass(frozen=True)
class Dataset:
    molecules: List[ReferenceMolecule]

    def by_scenario(self, scenario: str) -> "Dataset":
        return Dataset([m for m in self.molecules if m.scenario == scenario])

    def filter(
        self,
        scenarios: Optional[List[str]] = None,
        ids: Optional[List[str]] = None,
    ) -> "Dataset":
        mols = self.molecules
        if scenarios:
            wanted = set(scenarios)
            mols = [m for m in mols if m.scenario in wanted]
        if ids:
            wanted_ids = set(ids)
            mols = [m for m in mols if m.id in wanted_ids]
        return Dataset(mols)

    def __len__(self) -> int:
        return len(self.molecules)


class DatasetError(ValueError):
    pass


def load_dataset(path: str = DEFAULT_DATASET_PATH) -> Dataset:
    """Parse ``reference_shifts.json`` into a :class:`Dataset`.

    Raises :class:`DatasetError` on structural problems (missing keys, unknown
    scenario, duplicate ids). Chemistry validation (SMILES parses, SMARTS
    matches) is separate — see :func:`validate_dataset`.
    """
    with open(path, "r", encoding="utf-8") as fh:
        raw = json.load(fh)

    records = raw.get("molecules")
    if not isinstance(records, list) or not records:
        raise DatasetError("dataset has no 'molecules' list")

    molecules: List[ReferenceMolecule] = []
    seen_ids: set = set()
    for rec in records:
        try:
            mol_id = rec["id"]
            name = rec["name"]
            smiles = rec["smiles"]
            scenario = rec["scenario"]
        except KeyError as exc:
            raise DatasetError(f"molecule record missing required key {exc}") from exc

        if mol_id in seen_ids:
            raise DatasetError(f"duplicate molecule id: {mol_id!r}")
        seen_ids.add(mol_id)

        if scenario not in SCENARIOS:
            raise DatasetError(
                f"{mol_id}: unknown scenario {scenario!r} (expected one of {SCENARIOS})"
            )

        shifts: Dict[str, List[ReferenceShift]] = {}
        raw_shifts = rec.get("shifts", {})
        for nucleus, entries in raw_shifts.items():
            if nucleus not in _NUCLEUS_TO_SYMBOL:
                raise DatasetError(f"{mol_id}: unsupported nucleus {nucleus!r}")
            parsed: List[ReferenceShift] = []
            for entry in entries:
                try:
                    parsed.append(
                        ReferenceShift(
                            group_smarts=entry["group_smarts"],
                            ppm=float(entry["ppm"]),
                            exchangeable=bool(entry.get("exchangeable", False)),
                        )
                    )
                except (KeyError, TypeError, ValueError) as exc:
                    raise DatasetError(
                        f"{mol_id} [{nucleus}]: bad shift entry {entry!r}: {exc}"
                    ) from exc
            shifts[nucleus] = parsed

        if not shifts:
            raise DatasetError(f"{mol_id}: no shifts defined")

        molecules.append(
            ReferenceMolecule(
                id=mol_id,
                name=name,
                smiles=smiles,
                scenario=scenario,
                solvent=rec.get("solvent"),
                source=rec.get("source"),
                shifts=shifts,
            )
        )

    return Dataset(molecules)


def resolve_reference_atoms(
    mol: Chem.Mol, group_smarts: str, nucleus: str
) -> List[int]:
    """Resolve a reference group's SMARTS to canonical atom indices.

    The first SMARTS atom is the *anchor*:

    - ``13C``: returns the anchor carbon of each match (or the first carbon in
      the match if the anchor itself is not a carbon).
    - ``1H``: returns the hydrogen atoms bonded to each matched anchor heavy
      atom.

    Returns a sorted, de-duplicated list of atom indices. Empty list if the
    pattern matches nothing (the caller decides whether that's an error).
    """
    if nucleus not in _NUCLEUS_TO_SYMBOL:
        raise DatasetError(f"unsupported nucleus {nucleus!r}")

    query = Chem.MolFromSmarts(group_smarts)
    if query is None:
        raise DatasetError(f"invalid SMARTS: {group_smarts!r}")

    matches = mol.GetSubstructMatches(query, uniquify=True)
    if not matches:
        return []

    result: set = set()
    for match in matches:
        anchor_idx = match[0]
        anchor = mol.GetAtomWithIdx(anchor_idx)
        if nucleus == "13C":
            if anchor.GetSymbol() == "C":
                result.add(anchor_idx)
            else:
                for idx in match:
                    if mol.GetAtomWithIdx(idx).GetSymbol() == "C":
                        result.add(idx)
                        break
        else:  # 1H — hydrogens bonded to the anchor heavy atom
            for nbr in anchor.GetNeighbors():
                if nbr.GetAtomicNum() == 1:
                    result.add(nbr.GetIdx())

    return sorted(result)


@dataclass
class ValidationIssue:
    molecule_id: str
    nucleus: Optional[str]
    message: str


def validate_dataset(dataset: Dataset) -> List[ValidationIssue]:
    """Check every molecule canonicalizes and every group_smarts resolves to
    >= 1 atom of the right element. Returns a list of issues (empty == clean).
    """
    issues: List[ValidationIssue] = []
    for mol in dataset.molecules:
        try:
            canon = canonicalize(mol.smiles, add_hs=True)
        except InvalidSmilesError as exc:
            issues.append(ValidationIssue(mol.id, None, f"canonicalize failed: {exc}"))
            continue

        for nucleus, refs in mol.shifts.items():
            for ref in refs:
                try:
                    atoms = resolve_reference_atoms(
                        canon.mol, ref.group_smarts, nucleus
                    )
                except DatasetError as exc:
                    issues.append(
                        ValidationIssue(mol.id, nucleus, f"{ref.group_smarts!r}: {exc}")
                    )
                    continue
                if not atoms:
                    issues.append(
                        ValidationIssue(
                            mol.id,
                            nucleus,
                            f"{ref.group_smarts!r} matched no {nucleus} atoms",
                        )
                    )

    return issues


def canonical_for(mol: ReferenceMolecule) -> CanonicalMolecule:
    """Canonicalize a reference molecule (H-added), the same way the app does."""
    return canonicalize(mol.smiles, add_hs=True)
