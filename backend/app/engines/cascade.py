"""CASCADE engine — 3D graph neural network chemical-shift prediction.

Wraps the Paton-lab CASCADE model (DFTNN variant) ported to Keras 3.
Generates an ETKDGv3 conformer ensemble for each input mol, runs the
model per conformer, then returns a Boltzmann-weighted per-atom shift
at 298.15 K.

The model assets (``preprocessor.p`` and the two HDF5 weights files)
live in the vendored ``backend/vendor/cascade`` tree; the path can be
overridden via ``CASCADE_PATH`` (``settings.cascade_path``). If the
assets are missing the engine surfaces a ``CascadeEngineError`` so
``/predict`` reports ``status: "error"`` without touching other engines.
"""
from __future__ import annotations

import logging
import math
import os
from hashlib import sha256
from typing import Dict, List, Optional

import numpy as np
from rdkit import Chem

from app.chem.conformer import ConformerError, generate_conformers
from app.config import settings
from app.engines.base import Engine
from app.schemas import AtomShift

logger = logging.getLogger(__name__)


class CascadeEngineError(RuntimeError):
    """Raised when CASCADE assets are missing or inference fails."""


# Boltzmann factor denominator used by upstream: R in kcal/(mol·K) · 298.15 K.
_RT_KCAL = 0.001987 * 298.15

_WEIGHTS_FILE = {
    "13C": "best_model.hdf5",
    "1H": "best_model_H_DFTNN.hdf5",
}
_EXPECTED_ASSET_HASHES = {
    ("preprocessor.p",): "e9160321e192de2a5ddf706be7b048a634b79e8d928feea6b1558151349bcb21",
    ("trained_model", "best_model.hdf5"): "056b2da63696eb4a8f319ed52c0a9f8e20a0971d5f471b9a89f8468ab9ee5180",
    ("trained_model", "best_model_H_DFTNN.hdf5"): "256c7c334c386105aac0532a6d25d5ec14c7e28c2238a9308fc15ff6a3a80b01",
}

_TARGET_Z = {"13C": 6, "1H": 1}
_TARGET_SYMBOL = {"13C": "C", "1H": "H"}


class CascadeEngine(Engine):
    name = "cascade"
    default_weight = 0.3

    def __init__(self, num_confs: int = 10) -> None:
        self.num_confs = num_confs
        self._preprocessor = None
        self._models: Dict[str, "object"] = {}

    # ------------------------------------------------------------------
    # Lazy asset loading
    # ------------------------------------------------------------------
    def _verify_asset_hash(self, path: str, parts: tuple[str, ...]) -> None:
        expected = _EXPECTED_ASSET_HASHES.get(parts)
        if expected is None:
            return

        digest = sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)

        actual = digest.hexdigest()
        if actual != expected:
            raise CascadeEngineError(
                f"CASCADE asset hash mismatch for {path}. Refusing to load a tampered asset."
            )

    def _resolve_asset(self, *parts: str) -> str:
        root = settings.cascade_path
        if not root:
            raise CascadeEngineError(
                "CASCADE_PATH not configured. Point it at the CASCADE "
                "model directory (containing preprocessor.p and trained_model/)."
            )
        path = os.path.join(root, *parts)
        if not os.path.isfile(path):
            raise CascadeEngineError(
                f"CASCADE asset missing: {path}. "
                "Clone patonlab/CASCADE into backend/vendor/ or set CASCADE_PATH."
            )
        self._verify_asset_hash(path, tuple(parts))
        return path

    def _ensure_preprocessor(self):
        if self._preprocessor is None:
            from app.engines.cascade_nfp.preprocessor import (
                load_preprocessor_from_legacy_pickle,
            )

            pickle_path = self._resolve_asset("preprocessor.p")
            self._preprocessor = load_preprocessor_from_legacy_pickle(pickle_path)
            logger.info(
                "CASCADE preprocessor loaded (atom_classes=%d)",
                self._preprocessor.atom_classes,
            )
        return self._preprocessor

    def _ensure_model(self, nucleus: str):
        if nucleus in self._models:
            return self._models[nucleus]
        from app.engines.cascade_nfp.model import build_cascade_model

        pp = self._ensure_preprocessor()
        weights_path = self._resolve_asset("trained_model", _WEIGHTS_FILE[nucleus])
        model = build_cascade_model(atom_classes=pp.atom_classes)
        model.load_weights(weights_path)
        logger.info("CASCADE %s model loaded from %s", nucleus, weights_path)
        self._models[nucleus] = model
        return model

    # ------------------------------------------------------------------
    # Readiness (cheap — never loads the model)
    # ------------------------------------------------------------------
    def is_ready(self):
        root = settings.cascade_path
        if not root:
            return False, "CASCADE_PATH not set"
        if not os.path.isdir(root):
            return False, f"CASCADE path not a directory: {root}"
        required = [
            os.path.join(root, "preprocessor.p"),
            os.path.join(root, "trained_model", "best_model.hdf5"),
            os.path.join(root, "trained_model", "best_model_H_DFTNN.hdf5"),
        ]
        missing = [p for p in required if not os.path.isfile(p)]
        if missing:
            return False, f"Missing CASCADE assets: {missing}"
        return True, None

    # ------------------------------------------------------------------
    # Prediction
    # ------------------------------------------------------------------
    def predict(self, mol: Chem.Mol, nucleus: str, **_options) -> List[AtomShift]:
        if nucleus not in _WEIGHTS_FILE:
            raise CascadeEngineError(f"Unsupported nucleus: {nucleus!r}")

        target_z = _TARGET_Z[nucleus]
        target_atoms = [a.GetIdx() for a in mol.GetAtoms() if a.GetAtomicNum() == target_z]
        if not target_atoms:
            return []

        try:
            ensemble = generate_conformers(
                Chem.Mol(mol),  # defensive copy — caller's mol stays pristine
                num_confs=self.num_confs,
                optimize=True,
            )
        except ConformerError as exc:
            raise CascadeEngineError(f"Conformer generation failed: {exc}") from exc

        pp = self._ensure_preprocessor()
        model = self._ensure_model(nucleus)

        target_idx_array = np.asarray(target_atoms, dtype=int)
        min_energy = ensemble.energies_kcal[0]  # ensemble is energy-sorted ascending

        # Accumulate Boltzmann-weighted predictions across conformers.
        weight_sum = 0.0
        weighted_shift = np.zeros(len(target_atoms), dtype=np.float64)

        for conf_id, energy in zip(ensemble.conformer_ids, ensemble.energies_kcal):
            conf_mol = _mol_with_single_conformer(ensemble.mol, conf_id)
            features = pp.construct(conf_mol, target_idx_array)
            batch = _assemble([features])
            prediction = model.predict_on_batch(batch).reshape(-1)
            boltzmann = math.exp(-(energy - min_energy) / _RT_KCAL)
            weighted_shift += boltzmann * prediction
            weight_sum += boltzmann

        if weight_sum == 0.0:
            raise CascadeEngineError("All conformer weights collapsed to zero")

        averaged = weighted_shift / weight_sum

        symbol = _TARGET_SYMBOL[nucleus]
        return [
            AtomShift(
                atom_index=int(idx),
                symbol=symbol,
                shift_ppm=float(shift),
                confidence=None,
            )
            for idx, shift in zip(target_atoms, averaged)
        ]


def _mol_with_single_conformer(ensemble_mol: Chem.Mol, conf_id: int) -> Chem.Mol:
    """Return a clone of the ensemble mol retaining only ``conf_id``.

    CASCADE's preprocessor reads ``GetConformer()`` (the default
    conformer); stripping the ensemble to a single conformer makes
    that unambiguous regardless of which ``conf_id`` is passed.
    """
    mol = Chem.Mol(ensemble_mol)
    source = ensemble_mol.GetConformer(conf_id)
    mol.RemoveAllConformers()
    mol.AddConformer(source, assignId=True)
    return mol


def _assemble(features_list):
    from app.engines.cascade_nfp.sequence import assemble_batch

    return assemble_batch(features_list)


cascade_engine = CascadeEngine()
