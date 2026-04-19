"""Ported `MolAPreprocessor` for CASCADE feature construction."""
from __future__ import annotations

import hashlib
import pickle
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Sequence

import numpy as np
from rdkit import Chem

_EXPECTED_PREPROCESSOR_SHA256 = (
    "e9160321e192de2a5ddf706be7b048a634b79e8d928feea6b1558151349bcb21"
)


def atom_features(atom: Chem.Atom) -> int:
    return atom.GetAtomicNum()


def bond_features_v1(bond: Chem.Bond, flipped: bool = False) -> str:
    return str(
        (
            bond.GetBondType(),
            bond.GetIsConjugated(),
            bond.IsInRing(),
            sorted(
                [
                    bond.GetBeginAtom().GetSymbol(),
                    bond.GetEndAtom().GetSymbol(),
                ]
            ),
        )
    )


@dataclass
class Tokenizer:
    """Map feature keys to integer class ids. OOV keys hit ``unk``."""

    data: Dict[Any, int]
    num_classes: int

    @classmethod
    def from_legacy(cls, legacy: Any) -> "Tokenizer":
        return cls(data=dict(legacy._data), num_classes=int(legacy.num_classes))

    def __call__(self, key) -> int:
        try:
            return self.data[key]
        except KeyError:
            return self.data["unk"]


class MolAPreprocessor:
    """Re-implementation of upstream ``nfp.preprocessing.MolAPreprocessor``."""

    def __init__(
        self,
        atom_tokenizer: Tokenizer,
        bond_tokenizer: Tokenizer,
        n_neighbors: int,
        cutoff: float,
        explicit_hs: bool = True,
    ) -> None:
        self.atom_tokenizer = atom_tokenizer
        self.bond_tokenizer = bond_tokenizer
        self.n_neighbors = n_neighbors
        self.cutoff = cutoff
        self.explicit_hs = explicit_hs

    @property
    def atom_classes(self) -> int:
        return self.atom_tokenizer.num_classes + 1

    @property
    def bond_classes(self) -> int:
        return self.bond_tokenizer.num_classes + 1

    def construct(self, mol: Chem.Mol, atom_index_array: Sequence[int]) -> Dict[str, np.ndarray]:
        atom_index_array = np.asarray(atom_index_array, dtype=int)

        n_atom = mol.GetNumAtoms()
        n_pro = len(atom_index_array)
        distance_matrix = Chem.Get3DDistanceMatrix(mol)

        n_bond = int(((distance_matrix < self.cutoff) & (distance_matrix != 0)).sum())
        if n_bond == 0:
            n_bond = 1

        atom_feature_matrix = np.zeros(n_atom, dtype=np.int32)
        bond_feature_matrix = np.zeros(n_bond, dtype=np.int32)
        bond_distance_matrix = np.zeros(n_bond, dtype=np.float32)
        atom_index_matrix = np.full(n_atom, -1, dtype=np.int32)
        connectivity = np.zeros((n_bond, 2), dtype=np.int32)

        bond_index = 0
        for n, atom in enumerate(mol.GetAtoms()):
            atom_feature_matrix[n] = self.atom_tokenizer(atom_features(atom))

            match = np.where(atom_index_array == atom.GetIdx())[0]
            if match.size:
                atom_index_matrix[n] = int(match[0])

            neighbor_end = min(self.n_neighbors + 1, n_atom)
            cutoff_end = int((distance_matrix[n] < self.cutoff).sum())
            end_index = min(neighbor_end, cutoff_end)
            neighbor_inds = distance_matrix[n].argsort()[1:end_index]
            if len(neighbor_inds) == 0:
                neighbor_inds = np.array([n], dtype=int)

            for neighbor in neighbor_inds:
                bond = mol.GetBondBetweenAtoms(int(n), int(neighbor))
                if bond is None:
                    bond_feature_matrix[bond_index] = 0
                else:
                    flipped = bond.GetBeginAtomIdx() != n
                    bond_feature_matrix[bond_index] = self.bond_tokenizer(
                        bond_features_v1(bond, flipped=flipped)
                    )
                bond_distance_matrix[bond_index] = distance_matrix[n, int(neighbor)]
                connectivity[bond_index, 0] = n
                connectivity[bond_index, 1] = int(neighbor)
                bond_index += 1

        return {
            "n_atom": n_atom,
            "n_bond": n_bond,
            "n_pro": n_pro,
            "atom": atom_feature_matrix,
            "bond": bond_feature_matrix,
            "distance": bond_distance_matrix,
            "connectivity": connectivity,
            "atom_index": atom_index_matrix,
        }


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_preprocessor_from_legacy_pickle(path: str) -> MolAPreprocessor:
    """Read the upstream CASCADE ``preprocessor.p`` via a restricted unpickler."""

    pickle_path = Path(path)
    actual_hash = _sha256_file(pickle_path)
    if actual_hash != _EXPECTED_PREPROCESSOR_SHA256:
        raise RuntimeError(
            "CASCADE preprocessor hash mismatch. Refusing to load an untrusted "
            f"pickle from {pickle_path}."
        )

    class _ShimState:
        def __setstate__(self, state):
            if isinstance(state, dict):
                self.__dict__.update(state)

    def _shim_class(module: str, name: str):
        return type(name, (_ShimState,), {"__module__": module})

    allowed_globals = {
        ("nfp.preprocessing.preprocessor", "MolAPreprocessor"): _shim_class(
            "nfp.preprocessing.preprocessor",
            "MolAPreprocessor",
        ),
        ("nfp.preprocessing.preprocessor", "MolPreprocessor"): _shim_class(
            "nfp.preprocessing.preprocessor",
            "MolPreprocessor",
        ),
        ("nfp.preprocessing.preprocessor", "SmilesPreprocessor"): _shim_class(
            "nfp.preprocessing.preprocessor",
            "SmilesPreprocessor",
        ),
        ("nfp.preprocessing.features", "Tokenizer"): _shim_class(
            "nfp.preprocessing.features",
            "Tokenizer",
        ),
        ("nfp.preprocessing.features", "atom_features"): atom_features,
        ("nfp.preprocessing.features", "bond_features_v1"): bond_features_v1,
    }

    class _RestrictedUnpickler(pickle.Unpickler):
        def find_class(self, module, name):
            key = (module, name)
            if key in allowed_globals:
                return allowed_globals[key]
            if module == "builtins":
                return getattr(__import__("builtins"), name)
            raise pickle.UnpicklingError(
                f"CASCADE pickle references unexpected global {module}.{name}"
            )

    with pickle_path.open("rb") as handle:
        obj = _RestrictedUnpickler(handle).load()

    legacy = obj["preprocessor"] if isinstance(obj, dict) and "preprocessor" in obj else obj

    return MolAPreprocessor(
        atom_tokenizer=Tokenizer.from_legacy(legacy.atom_tokenizer),
        bond_tokenizer=Tokenizer.from_legacy(legacy.bond_tokenizer),
        n_neighbors=int(legacy.n_neighbors),
        cutoff=float(legacy.cutoff),
        explicit_hs=bool(getattr(legacy, "explicit_hs", True)),
    )
