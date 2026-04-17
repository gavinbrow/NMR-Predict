"""Graph-batch assembler + RBF distance expansion.

Replaces upstream ``nfp.preprocessing.sequence.GraphSequence`` plus the
``RBFSequence`` subclass defined in CASCADE's ``apply.py``. Returns
the plain dict the Keras model consumes; no Keras ``Sequence``
inheritance is needed — we just iterate over inputs ourselves.
"""
from __future__ import annotations

from typing import Dict, Iterable, List

import numpy as np


def rbf_expansion(
    distances: np.ndarray, mu: float = 0.0, delta: float = 0.1, kmax: int = 256
) -> np.ndarray:
    """256-dim Gaussian radial basis expansion used by CASCADE.

    Matches the upstream formula exactly so that weights trained
    against that embedding keep their calibration.
    """
    k = np.arange(0, kmax)
    logits = -(np.atleast_2d(distances).T - (-mu + delta * k)) ** 2 / delta
    return np.exp(logits)


def _stacked_offsets(sizes: np.ndarray, repeats: np.ndarray) -> np.ndarray:
    """Prefix-sum offsets needed when concatenating graphs into one batch."""
    return np.repeat(np.cumsum(np.hstack([0, sizes[:-1]])), repeats)


def _concat(values: List[np.ndarray]) -> np.ndarray:
    sample = np.asarray(values[0])
    if sample.ndim >= 2:
        return np.concatenate(values, axis=0)
    return np.hstack(values)


def assemble_batch(inputs: Iterable[Dict[str, np.ndarray]]) -> Dict[str, np.ndarray]:
    """Stitch per-molecule feature dicts into a single flat batch.

    The Keras model takes everything as one long tensor per field;
    connectivity and atom_index get offset so atom IDs from later
    graphs continue to reference the right atoms in the stitched
    arrays. This is the RBFSequence behaviour from ``apply.py``
    (without the batch_size machinery — we run one molecule's
    conformer ensemble at a time).
    """
    inputs = list(inputs)
    if not inputs:
        raise ValueError("assemble_batch: empty input list")

    keys = list(inputs[0].keys())
    batch = {k: _concat([ex[k] for ex in inputs]) for k in keys}

    # Offset connectivity so atom indices keep referring to the
    # right atoms after graphs are concatenated.
    bond_offset = _stacked_offsets(batch["n_atom"], batch["n_bond"])
    batch["connectivity"] = batch["connectivity"] + bond_offset[:, None]

    # Offset atom_index similarly so each target atom lands in a
    # unique output slot; -1 entries stay -1 so ReduceAtomToPro ignores them.
    atom_offset = _stacked_offsets(batch["n_pro"], batch["n_atom"])
    atom_offset = np.where(batch["atom_index"] >= 0, atom_offset, 0)
    batch["atom_index"] = batch["atom_index"] + atom_offset

    # Swap raw distances for their RBF expansion.
    batch["distance_rbf"] = rbf_expansion(batch["distance"]).astype(np.float32)

    # Keras inputs expect trailing size-1 dims where the upstream
    # Input layers declared shape=(1,).
    batch["atom_index"] = batch["atom_index"].reshape(-1, 1).astype(np.int32)
    batch["atom"] = batch["atom"].reshape(-1, 1).astype(np.int32)
    batch["n_pro"] = np.asarray(batch["n_pro"]).reshape(-1, 1).astype(np.int32)
    batch["connectivity"] = batch["connectivity"].astype(np.int32)

    # Drop the helpers the model doesn't consume.
    for junk in ("n_atom", "n_bond", "distance", "bond"):
        batch.pop(junk, None)

    return batch
