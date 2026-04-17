"""3D conformer generation via RDKit ETKDGv3.

Produces an ensemble of low-energy conformers. Used by the ML (CASCADE)
and QM (ORCA) engines — empirical HOSE-code lookup does not need 3D.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List

from rdkit import Chem
from rdkit.Chem import AllChem


class ConformerError(RuntimeError):
    pass


@dataclass
class ConformerEnsemble:
    mol: Chem.Mol  # mol with embedded conformers
    conformer_ids: List[int]
    energies_kcal: List[float]


def generate_conformers(
    mol: Chem.Mol,
    num_confs: int = 10,
    max_attempts: int = 200,
    optimize: bool = True,
    prune_rms_thresh: float = 0.5,
    random_seed: int = 0xF00D,
) -> ConformerEnsemble:
    """Generate a 3D conformer ensemble using ETKDGv3 + MMFF optimization.

    The input `mol` should already have explicit hydrogens (use
    canonicalize(..., add_hs=True)). Conformers are sorted by MMFF energy
    ascending.
    """
    if mol.GetNumAtoms() == 0:
        raise ConformerError("Empty molecule — nothing to embed")

    params = AllChem.ETKDGv3()
    params.randomSeed = random_seed
    params.pruneRmsThresh = prune_rms_thresh
    # `maxAttempts` moved around between RDKit releases; set it only if the
    # attribute is writable on this version. ETKDGv3 also accepts it as a
    # constructor kwarg-less property in some builds.
    try:
        params.maxAttempts = max_attempts
    except AttributeError:
        pass

    conf_ids = list(AllChem.EmbedMultipleConfs(mol, numConfs=num_confs, params=params))
    if not conf_ids:
        raise ConformerError("ETKDGv3 failed to embed any conformer")

    energies: List[float] = []
    if optimize:
        results = AllChem.MMFFOptimizeMoleculeConfs(mol, maxIters=500)
        # results is a list of (not_converged, energy) tuples parallel to conf_ids.
        for (_converged, energy), cid in zip(results, conf_ids):
            energies.append(float(energy))
    else:
        energies = [0.0] * len(conf_ids)

    paired = sorted(zip(conf_ids, energies), key=lambda p: p[1])
    sorted_ids = [cid for cid, _ in paired]
    sorted_energies = [e for _, e in paired]

    return ConformerEnsemble(
        mol=mol,
        conformer_ids=sorted_ids,
        energies_kcal=sorted_energies,
    )
