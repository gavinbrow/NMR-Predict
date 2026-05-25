from __future__ import annotations

from typing import List, Optional, Sequence

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

# Typical carboxylic-acid proton shift in common organic solvents.
# Used to override engine predictions, which routinely underestimate
# COOH shifts because trained ML models average across solvents and
# gas-phase DFT misses H-bonding/exchange.
_COOH_PROTON_SHIFT_PPM = 12.0
_COOH_SMARTS = Chem.MolFromSmarts("C(=O)[OH]")


def annotate_atom_shifts(mol: Mol, nucleus: str, shifts: List[AtomShift]) -> List[AtomShift]:
    if nucleus != "1H":
        return shifts

    # Symmetry-equivalent atoms share a rank when breakTies=False, so protons
    # on different heavy atoms that sit at equivalent molecular positions
    # (e.g. the ortho-H's of a para-substituted benzene, or the two halves of
    # a C2-symmetric molecule) collapse into a single assignment group. The
    # frontend relies on this to merge those peaks and to highlight every
    # equivalent heavy atom on hover.
    ranks = list(Chem.CanonicalRankAtoms(mol, breakTies=False, includeChirality=True))
    return [_annotate_proton_shift(mol, shift, ranks) for shift in shifts]


def apply_exchangeable_proton_corrections(
    mol: Mol, nucleus: str, shifts: List[AtomShift]
) -> List[AtomShift]:
    """Override engine-predicted shifts for protons that engines handle poorly.

    Currently covers carboxylic-acid protons only — experimental COOH shifts
    cluster around 11–13 ppm, but ML and gas-phase DFT models both routinely
    predict them in the 5–7 ppm range.
    """
    if nucleus != "1H":
        return shifts

    cooh_proton_indices = _cooh_proton_indices(mol)
    if not cooh_proton_indices:
        return shifts

    return [
        shift.model_copy(update={"shift_ppm": _COOH_PROTON_SHIFT_PPM})
        if shift.atom_index in cooh_proton_indices
        else shift
        for shift in shifts
    ]


def _cooh_proton_indices(mol: Mol) -> set[int]:
    if _COOH_SMARTS is None:
        return set()
    indices: set[int] = set()
    for match in mol.GetSubstructMatches(_COOH_SMARTS):
        oxygen = mol.GetAtomWithIdx(match[2])
        for neighbor in oxygen.GetNeighbors():
            if neighbor.GetAtomicNum() == 1:
                indices.add(neighbor.GetIdx())
    return indices


def _annotate_proton_shift(mol: Mol, shift: AtomShift, ranks: Sequence[int]) -> AtomShift:
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
            "assignment_group": f"h_sym:{ranks[proton.GetIdx()]}",
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
