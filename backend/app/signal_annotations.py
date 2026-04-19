from __future__ import annotations

from typing import List, Optional

from rdkit import Chem
from rdkit.Chem.rdchem import Atom, HybridizationType, Mol

from app.schemas import AtomShift

_SP3_COUPLING_HZ = 7.0
_FIRST_ORDER_MULTIPLICITY = {
    0: "s",
    1: "d",
    2: "t",
    3: "q",
    4: "quint",
    5: "sext",
    6: "sept",
}


def annotate_atom_shifts(mol: Mol, nucleus: str, shifts: List[AtomShift]) -> List[AtomShift]:
    if nucleus != "1H":
        return shifts

    return [_annotate_proton_shift(mol, shift) for shift in shifts]


def _annotate_proton_shift(mol: Mol, shift: AtomShift) -> AtomShift:
    if shift.atom_index < 0 or shift.atom_index >= mol.GetNumAtoms():
        return shift

    proton = mol.GetAtomWithIdx(shift.atom_index)
    if proton.GetAtomicNum() != 1:
        return shift

    anchor = _attached_heavy_atom(proton)
    if anchor is None:
        return shift

    neighbor_count = _estimated_neighbor_protons(anchor, exclude_idx=proton.GetIdx())
    multiplicity = _estimate_multiplicity(anchor, neighbor_count)
    coupling_hz = _estimate_coupling(anchor, neighbor_count)

    return shift.model_copy(
        update={
            "attached_atom_index": anchor.GetIdx(),
            "assignment_group": f"h@{anchor.GetIdx()}",
            "multiplicity": multiplicity,
            "coupling_hz": coupling_hz,
            "neighbor_count": neighbor_count,
        }
    )


def _attached_heavy_atom(atom: Atom) -> Optional[Atom]:
    for neighbor in atom.GetNeighbors():
        if neighbor.GetAtomicNum() > 1:
            return neighbor
    return None


def _attached_hydrogens(atom: Atom, exclude_idx: Optional[int] = None) -> int:
    count = 0
    for neighbor in atom.GetNeighbors():
        if neighbor.GetAtomicNum() != 1:
            continue
        if exclude_idx is not None and neighbor.GetIdx() == exclude_idx:
            continue
        count += 1
    return count


def _estimated_neighbor_protons(anchor: Atom, exclude_idx: int) -> int:
    if anchor.GetAtomicNum() != 6:
        return 0

    total = 0
    for neighbor in anchor.GetNeighbors():
        if neighbor.GetIdx() == exclude_idx or neighbor.GetAtomicNum() == 1:
            continue
        if neighbor.GetAtomicNum() != 6:
            continue
        total += _attached_hydrogens(neighbor)
    return total


def _estimate_multiplicity(anchor: Atom, neighbor_count: int) -> str:
    if neighbor_count <= 0:
        return "s"

    if anchor.GetIsAromatic() or anchor.GetHybridization() != HybridizationType.SP3:
        return "m"

    return _FIRST_ORDER_MULTIPLICITY.get(neighbor_count, "m")


def _estimate_coupling(anchor: Atom, neighbor_count: int) -> Optional[float]:
    if neighbor_count <= 0:
        return None
    if anchor.GetIsAromatic() or anchor.GetHybridization() != HybridizationType.SP3:
        return None
    return _SP3_COUPLING_HZ
