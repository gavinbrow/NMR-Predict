import pytest

from app.chem.canonical import canonicalize, InvalidSmilesError
from app.chem.conformer import generate_conformers
from app.limits import MAX_HEAVY_ATOMS, MAX_SMILES_LENGTH


def test_canonical_benzene_roundtrip():
    a = canonicalize("c1ccccc1", add_hs=False)
    b = canonicalize("C1=CC=CC=C1", add_hs=False)
    assert a.canonical_smiles == b.canonical_smiles


def test_invalid_smiles_rejected():
    with pytest.raises(InvalidSmilesError):
        canonicalize("this is not a smiles")


def test_valence_violation_rejected():
    with pytest.raises(InvalidSmilesError):
        canonicalize("C(C)(C)(C)(C)C")  # pentavalent carbon


def test_overlong_smiles_rejected():
    with pytest.raises(InvalidSmilesError, match="too long"):
        canonicalize("C" * (MAX_SMILES_LENGTH + 1))


def test_oversized_molecule_rejected():
    with pytest.raises(InvalidSmilesError, match="too large"):
        canonicalize("C" * (MAX_HEAVY_ATOMS + 1))


def test_conformer_generation_ethanol():
    canon = canonicalize("CCO", add_hs=True)
    ensemble = generate_conformers(canon.mol, num_confs=3)
    assert len(ensemble.conformer_ids) >= 1
    assert len(ensemble.energies_kcal) == len(ensemble.conformer_ids)
