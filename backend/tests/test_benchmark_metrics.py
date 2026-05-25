"""Unit tests for benchmark metrics and dataset integrity.

These need no engines (no CDK/CASCADE/ORCA), so they always run in CI.
"""
from __future__ import annotations

import math

import pytest

from benchmarks import metrics
from benchmarks.dataset import (
    canonical_for,
    load_dataset,
    resolve_reference_atoms,
    validate_dataset,
)


# --------------------------------------------------------------------------
# Metrics — hand-computed expected values
# --------------------------------------------------------------------------
def test_mae_simple():
    # errors: 1, -1, 2 -> abs 1,1,2 -> mean 4/3
    assert metrics.mae([2.0, 4.0, 7.0], [1.0, 5.0, 5.0]) == pytest.approx(4 / 3)


def test_rmse_simple():
    # squared errors: 1, 1, 4 -> mean 2 -> sqrt(2)
    assert metrics.rmse([2.0, 4.0, 7.0], [1.0, 5.0, 5.0]) == pytest.approx(math.sqrt(2))


def test_max_abs_err():
    assert metrics.max_abs_err([2.0, 4.0, 7.0], [1.0, 5.0, 5.0]) == pytest.approx(2.0)


def test_bias_signed():
    # errors 1, -1, 2 -> mean 2/3
    assert metrics.bias([2.0, 4.0, 7.0], [1.0, 5.0, 5.0]) == pytest.approx(2 / 3)


def test_r2_perfect_fit_is_one():
    assert metrics.r2([1.0, 2.0, 3.0], [1.0, 2.0, 3.0]) == pytest.approx(1.0)


def test_r2_known_value():
    # reference mean = 2; ss_tot = 1+0+1 = 2; ss_res = (1.1-1)^2+(2-2)^2+(2.9-3)^2 = 0.02
    r2 = metrics.r2([1.1, 2.0, 2.9], [1.0, 2.0, 3.0])
    assert r2 == pytest.approx(1.0 - 0.02 / 2.0)


def test_r2_undefined_for_constant_reference():
    assert math.isnan(metrics.r2([1.0, 2.0], [5.0, 5.0]))


def test_empty_returns_nan():
    assert math.isnan(metrics.mae([], []))
    assert math.isnan(metrics.rmse([], []))


def test_length_mismatch_raises():
    with pytest.raises(ValueError):
        metrics.mae([1.0, 2.0], [1.0])


def test_linear_scaling_recovers_offset():
    # reference = 2*predicted + 3, exactly
    predicted = [0.0, 1.0, 2.0, 3.0]
    reference = [3.0, 5.0, 7.0, 9.0]
    scaling = metrics.fit_linear_scaling(predicted, reference)
    assert scaling.slope == pytest.approx(2.0)
    assert scaling.intercept == pytest.approx(3.0)
    scaled = [scaling.apply(v) for v in predicted]
    assert metrics.mae(scaled, reference) == pytest.approx(0.0, abs=1e-9)


def test_linear_scaling_degenerate_returns_identity():
    scaling = metrics.fit_linear_scaling([5.0, 5.0], [1.0, 9.0])
    assert scaling.slope == 1.0 and scaling.intercept == 0.0


def test_summarize_bundles_all_metrics():
    s = metrics.summarize([2.0, 4.0, 7.0], [1.0, 5.0, 5.0])
    assert s.n == 3
    assert s.mae == pytest.approx(4 / 3)
    assert s.max_abs_err == pytest.approx(2.0)


# --------------------------------------------------------------------------
# Dataset integrity — runs without engines (RDKit only)
# --------------------------------------------------------------------------
def test_dataset_loads():
    ds = load_dataset()
    assert len(ds) >= 30
    ids = {m.id for m in ds.molecules}
    assert "ethanol" in ids and "benzene" in ids


def test_dataset_validates_clean():
    issues = validate_dataset(load_dataset())
    assert issues == [], f"dataset has unresolved groups: {issues}"


def test_every_scenario_is_represented():
    ds = load_dataset()
    present = {m.scenario for m in ds.molecules}
    # The 'larger' bucket exists to exercise ORCA scaling.
    assert "larger" in present
    assert len(present) >= 6


def test_resolve_reference_atoms_ethanol():
    ds = load_dataset()
    ethanol = next(m for m in ds.molecules if m.id == "ethanol")
    canon = canonical_for(ethanol)
    # CH3 carbon: exactly one carbon
    c = resolve_reference_atoms(canon.mol, "[CH3]", "13C")
    assert len(c) == 1
    assert canon.mol.GetAtomWithIdx(c[0]).GetSymbol() == "C"
    # CH3 protons: three hydrogens
    h = resolve_reference_atoms(canon.mol, "[CH3]", "1H")
    assert len(h) == 3
    assert all(canon.mol.GetAtomWithIdx(i).GetSymbol() == "H" for i in h)


def test_resolve_invalid_smarts_raises():
    ds = load_dataset()
    canon = canonical_for(ds.molecules[0])
    from benchmarks.dataset import DatasetError

    with pytest.raises(DatasetError):
        resolve_reference_atoms(canon.mol, "this is not smarts ][", "13C")
