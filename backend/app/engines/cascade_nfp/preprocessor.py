"""Ported `MolAPreprocessor` — converts RDKit mols into the feature
dict CASCADE's graph model expects.

This is a re-implementation of the upstream ``nfp.preprocessing``
pipeline limited to what the DFTNN (``best_model.hdf5``) flavour
actually needs. It carries the learned atom/bond vocabularies
loaded from the shipped ``preprocessor.p`` pickle — the tokenizer
dicts are pure-Python primitives so they unpickle cleanly.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Any, Sequence

import numpy as np
from rdkit import Chem


def atom_features(atom: Chem.Atom) -> int:
    """Atomic-number hash — CASCADE uses plain Z as the atom type key."""
    return atom.GetAtomicNum()


def bond_features_v1(bond: Chem.Bond, flipped: bool = False) -> str:
    """Bond feature string matching upstream ``nfp.features.bond_features_v1``.

    The tuple is stringified exactly as the legacy code does so the
    learned bond-tokenizer vocabulary (``rdkit.Chem.rdchem.BondType.X``
    repr) keeps working. Modern RDKit keeps the same repr format.
    """
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
    """Map feature keys → integer class ids. Out-of-vocab keys hit 'unk' (id 1)."""

    data: Dict[Any, int]
    num_classes: int

    @classmethod
    def from_legacy(cls, legacy: Any) -> "Tokenizer":
        # ``legacy`` is the unpickled shim with attributes _data + num_classes
        return cls(data=dict(legacy._data), num_classes=int(legacy.num_classes))

    def __call__(self, key) -> int:
        try:
            return self.data[key]
        except KeyError:
            return self.data["unk"]


class MolAPreprocessor:
    """Re-implementation of upstream ``nfp.preprocessing.MolAPreprocessor``.

    Given an RDKit mol (with explicit Hs and a 3D conformer) and an
    array of atom indices to predict on, emit the numpy feature dict
    consumed by the graph model.
    """

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
        # Matches upstream: one extra slot for the null-atom placeholder.
        return self.atom_tokenizer.num_classes + 1

    @property
    def bond_classes(self) -> int:
        return self.bond_tokenizer.num_classes + 1

    def construct(self, mol: Chem.Mol, atom_index_array: Sequence[int]) -> Dict[str, np.ndarray]:
        atom_index_array = np.asarray(atom_index_array, dtype=int)

        n_atom = mol.GetNumAtoms()
        n_pro = len(atom_index_array)

        distance_matrix = Chem.Get3DDistanceMatrix(mol)

        # Count how many (non-self) neighbours fall inside the cutoff —
        # this matches upstream's "MolAPreprocessor" which ignores the
        # n_neighbors cap in favour of cutoff-only selection.
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

            # If atom n is one of the targets, record which output slot it belongs to.
            match = np.where(atom_index_array == atom.GetIdx())[0]
            if match.size:
                atom_index_matrix[n] = int(match[0])

            neighbor_end = min(self.n_neighbors + 1, n_atom)
            cutoff_end = int((distance_matrix[n] < self.cutoff).sum())
            end_index = min(neighbor_end, cutoff_end)

            # Nearest-neighbour list excluding self (argsort[0] is self, distance 0).
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


def load_preprocessor_from_legacy_pickle(path: str) -> MolAPreprocessor:
    """Read the upstream CASCADE ``preprocessor.p`` via a shim unpickler.

    The shipped pickle references ``nfp.preprocessing.*`` which pulls
    in Keras 2's ``keras.engine`` on import — incompatible with Keras 3.
    We stub out those modules so that ``pickle`` can resolve the class
    names without triggering the imports, then lift the pure state
    (tokenizers, n_neighbors, cutoff, explicit_hs) into our own class.
    """
    import pickle
    import sys
    import types

    stub_names = (
        "keras",
        "keras.engine",
        "keras.engine.base_layer",
        "nfp",
        "nfp.preprocessing",
        "nfp.preprocessing.preprocessor",
        "nfp.preprocessing.features",
    )
    created: list[str] = []
    for name in stub_names:
        if name not in sys.modules:
            sys.modules[name] = types.ModuleType(name)
            created.append(name)

    class _ShimState:
        def __setstate__(self, state):
            if isinstance(state, dict):
                self.__dict__.update(state)

    for mod_name, cls_names in (
        (
            "nfp.preprocessing.preprocessor",
            ("MolAPreprocessor", "MolPreprocessor", "SmilesPreprocessor"),
        ),
        ("nfp.preprocessing.features", ("Tokenizer",)),
    ):
        module = sys.modules[mod_name]
        for cls_name in cls_names:
            if not hasattr(module, cls_name):
                setattr(module, cls_name, type(cls_name, (_ShimState,), {}))

    class _ShimUnpickler(pickle.Unpickler):
        def find_class(self, module, name):
            try:
                return super().find_class(module, name)
            except (ModuleNotFoundError, AttributeError):
                stub = sys.modules.setdefault(module, types.ModuleType(module))
                if not hasattr(stub, name):
                    setattr(stub, name, type(name, (_ShimState,), {}))
                return getattr(stub, name)

    try:
        with open(path, "rb") as f:
            obj = _ShimUnpickler(f).load()
    finally:
        for name in created:
            sys.modules.pop(name, None)

    if isinstance(obj, dict) and "preprocessor" in obj:
        legacy = obj["preprocessor"]
    else:
        legacy = obj

    return MolAPreprocessor(
        atom_tokenizer=Tokenizer.from_legacy(legacy.atom_tokenizer),
        bond_tokenizer=Tokenizer.from_legacy(legacy.bond_tokenizer),
        n_neighbors=int(legacy.n_neighbors),
        cutoff=float(legacy.cutoff),
        explicit_hs=bool(getattr(legacy, "explicit_hs", True)),
    )
