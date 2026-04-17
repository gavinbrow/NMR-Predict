"""Consensus manager — combines per-engine predictions into a single
weighted shift per atom.

Default weights follow the Phase-3 plan:

    W_cdk = 0.5  (HOSE-code lookup; reliable for common environments)
    W_ml  = 0.3  (CASCADE 3D graph neural network)
    W_qm  = 0.2  (ORCA DFT)

Engines whose ``status != "ok"`` are dropped and the remaining weights
are renormalised so they sum to 1.0. The caller may override any weight
via the optional ``weights`` dict on :class:`app.schemas.PredictRequest`.

Per-atom output carries:

* ``shift_ppm`` — weighted mean across contributing engines
* ``std_ppm``  — unweighted standard deviation of the engine predictions
  (spread proxy; ``None`` when only one engine contributed)
* ``contributing_engines`` — which engines produced a value for that atom
"""
from __future__ import annotations

import math
from typing import Dict, List, Mapping, Optional

from app.schemas import (
    AtomShift,
    ConsensusAtomShift,
    ConsensusResult,
    EngineName,
    EngineResult,
)


DEFAULT_WEIGHTS: Dict[EngineName, float] = {
    "cdk": 0.5,
    "cascade": 0.3,
    "orca": 0.2,
}


def _effective_weights(
    ok_engines: List[EngineName],
    overrides: Optional[Mapping[EngineName, float]],
) -> Dict[EngineName, float]:
    """Pick weights for the engines that returned 'ok', honouring
    overrides, then renormalise to sum to 1.0. Weights <= 0 are dropped."""
    base = dict(DEFAULT_WEIGHTS)
    if overrides:
        for name, value in overrides.items():
            base[name] = float(value)

    raw = {name: base.get(name, 0.0) for name in ok_engines}
    raw = {k: v for k, v in raw.items() if v > 0}
    total = sum(raw.values())
    if total <= 0:
        return {}
    return {k: v / total for k, v in raw.items()}


def compute_consensus(
    engine_results: Mapping[EngineName, EngineResult],
    weights: Optional[Mapping[EngineName, float]] = None,
) -> ConsensusResult:
    """Merge per-engine shifts into a single weighted prediction per atom.

    Only engines with ``status == "ok"`` contribute. When no engine is ok
    the returned :class:`ConsensusResult` carries an empty shift list and
    ``weights_used == {}``.
    """
    ok_engines: List[EngineName] = [
        name for name, result in engine_results.items() if result.status == "ok"
    ]
    weights_used = _effective_weights(ok_engines, weights)
    if not weights_used:
        return ConsensusResult(shifts=[], weights_used={})

    # atom_index -> list of (engine_name, shift_ppm, AtomShift)
    per_atom: Dict[int, List[tuple]] = {}
    for name in ok_engines:
        if name not in weights_used:
            continue
        for shift in engine_results[name].shifts:
            per_atom.setdefault(shift.atom_index, []).append(
                (name, float(shift.shift_ppm), shift)
            )

    consensus_shifts: List[ConsensusAtomShift] = []
    for atom_index in sorted(per_atom):
        entries = per_atom[atom_index]
        template_shift = entries[0][2]
        symbol = template_shift.symbol

        # Renormalise weights across the engines that actually reported
        # *this* atom — otherwise a partial engine would bias atoms it
        # skipped (can't happen today because all three engines emit one
        # shift per target atom, but cheap insurance).
        local_total = sum(weights_used[name] for name, _, _ in entries)
        if local_total <= 0:
            continue
        weighted_mean = (
            sum(weights_used[name] * value for name, value, _ in entries)
            / local_total
        )

        if len(entries) > 1:
            values = [value for _, value, _ in entries]
            mean = sum(values) / len(values)
            variance = sum((v - mean) ** 2 for v in values) / len(values)
            std = math.sqrt(variance)
        else:
            std = None

        consensus_shifts.append(
            ConsensusAtomShift(
                atom_index=atom_index,
                symbol=symbol,
                shift_ppm=weighted_mean,
                std_ppm=std,
                contributing_engines=[name for name, _, _ in entries],
                attached_atom_index=template_shift.attached_atom_index,
                assignment_group=template_shift.assignment_group,
                multiplicity=template_shift.multiplicity,
                coupling_hz=template_shift.coupling_hz,
                neighbor_count=template_shift.neighbor_count,
            )
        )

    return ConsensusResult(shifts=consensus_shifts, weights_used=weights_used)


__all__ = ["DEFAULT_WEIGHTS", "compute_consensus"]
