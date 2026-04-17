"""CASCADE engine tests.

Import-time and registry checks run always. Live inference tests run
only when the vendored CASCADE assets are present on disk (or when
``CASCADE_PATH`` points somewhere that contains them) — CI and
minimal dev machines should still be able to run the smoke suite.
"""
from __future__ import annotations

import os

import pytest

from app.chem.canonical import canonicalize
from app.config import settings
from app.engines import engine_is_implemented, get_engine
from app.engines.cascade import CascadeEngine, CascadeEngineError


def _assets_present() -> bool:
    root = settings.cascade_path
    return bool(root) and os.path.isfile(os.path.join(root, "preprocessor.p"))


def test_registry_lists_cascade_as_implemented():
    assert engine_is_implemented("cascade")
    engine = get_engine("cascade")
    assert engine.name == "cascade"
    assert engine.default_weight == 0.3


def test_cascade_engine_rejects_unknown_nucleus():
    engine = CascadeEngine()
    canon = canonicalize("CCO", add_hs=True)
    with pytest.raises(CascadeEngineError, match="Unsupported nucleus"):
        engine.predict(canon.mol, "19F")


def test_cascade_engine_requires_assets(monkeypatch):
    from app import config as app_config

    monkeypatch.setattr(app_config.settings, "cascade_path", "")
    engine = CascadeEngine()
    with pytest.raises(CascadeEngineError, match="CASCADE_PATH"):
        engine.predict(canonicalize("CCO", add_hs=True).mol, "13C")


@pytest.mark.skipif(
    not _assets_present(),
    reason="CASCADE assets not found — skipping live inference test",
)
def test_cascade_predicts_ethanol_carbons():
    canon = canonicalize("CCO", add_hs=True)
    shifts = get_engine("cascade").predict(canon.mol, "13C")
    assert shifts, "expected carbon predictions"
    symbols = {s.symbol for s in shifts}
    assert symbols == {"C"}
    for s in shifts:
        assert -10.0 < s.shift_ppm < 250.0
        assert 0 <= s.atom_index < canon.mol.GetNumAtoms()
    # Ethanol: CH3 near ~18 ppm, CH2 near ~58 ppm
    ppm_values = sorted(s.shift_ppm for s in shifts)
    assert ppm_values[0] < 30.0, f"CH3 should be < 30 ppm, got {ppm_values[0]}"
    assert ppm_values[-1] > 45.0, f"CH2 should be > 45 ppm, got {ppm_values[-1]}"


@pytest.mark.skipif(
    not _assets_present(),
    reason="CASCADE assets not found — skipping live inference test",
)
def test_cascade_predicts_ethanol_protons():
    canon = canonicalize("CCO", add_hs=True)
    shifts = get_engine("cascade").predict(canon.mol, "1H")
    assert shifts, "expected proton predictions"
    for s in shifts:
        assert s.symbol == "H"
        assert -1.0 < s.shift_ppm < 15.0
