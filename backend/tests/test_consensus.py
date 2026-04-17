"""Consensus manager tests — pure-Python, no engines invoked."""
from __future__ import annotations

import math

from app.consensus import DEFAULT_WEIGHTS, compute_consensus
from app.schemas import AtomShift, EngineResult


def _ok(name, shifts):
    return EngineResult(engine=name, status="ok", shifts=shifts)


def _err(name, msg="boom"):
    return EngineResult(engine=name, status="error", shifts=[], message=msg)


def _shift(idx, value, symbol="C"):
    return AtomShift(atom_index=idx, symbol=symbol, shift_ppm=value)


def test_default_weights_match_phase3_spec():
    assert DEFAULT_WEIGHTS == {"cdk": 0.5, "cascade": 0.3, "orca": 0.2}


def test_single_engine_consensus_equals_that_engine():
    results = {"cdk": _ok("cdk", [_shift(0, 25.0), _shift(1, 40.0)])}
    cons = compute_consensus(results)
    assert cons.weights_used == {"cdk": 1.0}
    assert [s.shift_ppm for s in cons.shifts] == [25.0, 40.0]
    assert all(s.std_ppm is None for s in cons.shifts)
    assert [s.contributing_engines for s in cons.shifts] == [["cdk"], ["cdk"]]


def test_three_engine_weighted_average():
    # atom 0: cdk 10, cascade 20, orca 30 -> 0.5*10 + 0.3*20 + 0.2*30 = 17
    results = {
        "cdk":     _ok("cdk",     [_shift(0, 10.0)]),
        "cascade": _ok("cascade", [_shift(0, 20.0)]),
        "orca":    _ok("orca",    [_shift(0, 30.0)]),
    }
    cons = compute_consensus(results)
    assert cons.weights_used == {"cdk": 0.5, "cascade": 0.3, "orca": 0.2}
    assert math.isclose(cons.shifts[0].shift_ppm, 17.0)
    assert set(cons.shifts[0].contributing_engines) == {"cdk", "cascade", "orca"}
    assert cons.shifts[0].std_ppm is not None and cons.shifts[0].std_ppm > 0


def test_errored_engine_dropped_and_weights_renormalise():
    # ORCA errored; cdk (0.5) and cascade (0.3) renormalise to 0.625 / 0.375
    results = {
        "cdk":     _ok("cdk",     [_shift(0, 100.0)]),
        "cascade": _ok("cascade", [_shift(0, 200.0)]),
        "orca":    _err("orca"),
    }
    cons = compute_consensus(results)
    assert math.isclose(cons.weights_used["cdk"], 0.625)
    assert math.isclose(cons.weights_used["cascade"], 0.375)
    assert "orca" not in cons.weights_used
    # 0.625 * 100 + 0.375 * 200 = 137.5
    assert math.isclose(cons.shifts[0].shift_ppm, 137.5)
    assert cons.shifts[0].contributing_engines == ["cdk", "cascade"]


def test_all_engines_errored_returns_empty_consensus():
    results = {"cdk": _err("cdk"), "cascade": _err("cascade"), "orca": _err("orca")}
    cons = compute_consensus(results)
    assert cons.shifts == []
    assert cons.weights_used == {}


def test_weight_overrides_honoured_and_renormalised():
    # Override cdk to 0.9, cascade to 0.1; renormalisation is a no-op here.
    results = {
        "cdk":     _ok("cdk",     [_shift(0, 10.0)]),
        "cascade": _ok("cascade", [_shift(0, 50.0)]),
    }
    cons = compute_consensus(results, weights={"cdk": 0.9, "cascade": 0.1})
    assert math.isclose(cons.weights_used["cdk"], 0.9)
    assert math.isclose(cons.weights_used["cascade"], 0.1)
    # 0.9 * 10 + 0.1 * 50 = 14
    assert math.isclose(cons.shifts[0].shift_ppm, 14.0)


def test_zero_weight_engine_excluded():
    # Zero weight drops the engine out even though it's 'ok'.
    results = {
        "cdk":     _ok("cdk",     [_shift(0, 10.0)]),
        "cascade": _ok("cascade", [_shift(0, 50.0)]),
    }
    cons = compute_consensus(results, weights={"cdk": 1.0, "cascade": 0.0})
    assert cons.weights_used == {"cdk": 1.0}
    assert math.isclose(cons.shifts[0].shift_ppm, 10.0)
    assert cons.shifts[0].contributing_engines == ["cdk"]


def test_partial_atom_coverage_reweights_locally():
    # ORCA only emits atom 0; atom 1 comes from cdk+cascade only.
    # Atom 0: all three contribute, weights 0.5/0.3/0.2 -> 17
    # Atom 1: cdk (0.5) + cascade (0.3), renormalised to 0.625 / 0.375
    #         0.625 * 100 + 0.375 * 200 = 137.5
    results = {
        "cdk":     _ok("cdk",     [_shift(0, 10.0), _shift(1, 100.0)]),
        "cascade": _ok("cascade", [_shift(0, 20.0), _shift(1, 200.0)]),
        "orca":    _ok("orca",    [_shift(0, 30.0)]),
    }
    cons = compute_consensus(results)
    by_idx = {s.atom_index: s for s in cons.shifts}
    assert math.isclose(by_idx[0].shift_ppm, 17.0)
    assert math.isclose(by_idx[1].shift_ppm, 137.5)
    assert set(by_idx[0].contributing_engines) == {"cdk", "cascade", "orca"}
    assert set(by_idx[1].contributing_engines) == {"cdk", "cascade"}
