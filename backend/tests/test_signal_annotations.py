from collections import Counter

from app.chem.canonical import canonicalize
from app.schemas import AtomShift
from app.signal_annotations import annotate_atom_shifts


def test_ethanol_proton_annotations_estimate_integrations_and_multiplicities():
    canon = canonicalize("CCO", add_hs=True)
    proton_shifts = [
        AtomShift(atom_index=atom.GetIdx(), symbol="H", shift_ppm=1.0)
        for atom in canon.mol.GetAtoms()
        if atom.GetAtomicNum() == 1
    ]

    annotated = annotate_atom_shifts(canon.mol, "1H", proton_shifts)

    grouped = {}
    for shift in annotated:
        grouped.setdefault(shift.assignment_group, []).append(shift)

    assert len(grouped) == 3

    counts_by_multiplicity = Counter(
        (group[0].multiplicity, len(group))
        for group in grouped.values()
    )

    assert counts_by_multiplicity[("t", 3)] == 1
    assert counts_by_multiplicity[("q", 2)] == 1
    assert counts_by_multiplicity[("s", 1)] == 1
