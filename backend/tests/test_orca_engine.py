"""ORCA engine tests.

Registry and unit-level parser tests always run; a live end-to-end
prediction test is gated on ``RUN_ORCA_TESTS=1`` because a cold cache
requires a TMS reference calculation plus a sample calculation, which
together take several minutes even at the cheap PBE/def2-SVP defaults.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from app.chem.canonical import canonicalize
from app.config import settings
from app.engines import engine_is_implemented, get_engine
from app.engines.orca import (
    OrcaEngine,
    OrcaEngineError,
    _build_nmr_input,
    _build_goat_input,
    _tms_cache_key,
    parse_shieldings,
)


def _orca_live_tests_enabled() -> bool:
    return (
        os.getenv("RUN_ORCA_TESTS") == "1"
        and Path(settings.orca_exe).is_file()
    )


# ---------------------------------------------------------------------
# Registry + trivial guards
# ---------------------------------------------------------------------

def test_registry_lists_orca_as_implemented():
    assert engine_is_implemented("orca")
    engine = get_engine("orca")
    assert engine.name == "orca"
    assert engine.default_weight == 0.2


def test_orca_rejects_unknown_nucleus():
    engine = OrcaEngine()
    canon = canonicalize("CCO", add_hs=True)
    with pytest.raises(OrcaEngineError, match="Unsupported nucleus"):
        engine.predict(canon.mol, "19F")


def test_orca_rejects_unknown_conformer_strategy():
    engine = OrcaEngine()
    canon = canonicalize("CCO", add_hs=True)
    with pytest.raises(OrcaEngineError, match="conformer_strategy"):
        engine.predict(canon.mol, "13C", conformer_strategy="oracle")


def test_orca_requires_binary(monkeypatch, tmp_path):
    from app import config as app_config

    monkeypatch.setattr(app_config.settings, "orca_exe", str(tmp_path / "no_orca_here.exe"))
    monkeypatch.setattr(app_config.settings, "orca_work_dir", str(tmp_path))

    # Seed the TMS cache so we fail on the sample run, not the reference run.
    key = _tms_cache_key(app_config.settings.orca_functional, app_config.settings.orca_basis)
    (tmp_path / "tms_refs.json").write_text(
        json.dumps({key: {"1H": 31.8, "13C": 188.1}}),
        encoding="utf-8",
    )

    engine = OrcaEngine()
    canon = canonicalize("CCO", add_hs=True)
    with pytest.raises(OrcaEngineError, match="ORCA binary not found"):
        engine.predict(canon.mol, "13C")


# ---------------------------------------------------------------------
# Input builders
# ---------------------------------------------------------------------

def test_build_nmr_input_shape():
    inp = _build_nmr_input(
        xyz_block="  H   0.0  0.0  0.0",
        charge=0,
        multiplicity=1,
        functional="PBE",
        basis="def2-SVP",
        cpus=4,
        ram_mb=2000,
    )
    assert inp.startswith("! PBE def2-SVP NMR TightSCF")
    assert "%maxcore 2000" in inp
    assert "nprocs 4" in inp
    assert "* xyz 0 1" in inp
    assert inp.rstrip().endswith("*")


def test_build_goat_input_includes_goat_block():
    inp = _build_goat_input(
        xyz_block="  H   0.0  0.0  0.0",
        charge=-1,
        multiplicity=2,
        cpus=8,
        ram_mb=3000,
    )
    assert inp.startswith("! XTB2 GOAT")
    assert "%goat" in inp
    assert "NWorkers 8" in inp
    assert "* xyz -1 2" in inp


# ---------------------------------------------------------------------
# Shielding parser — covers both per-atom block and summary-table formats
# ---------------------------------------------------------------------

_PER_ATOM_SAMPLE = """
--------------------------------
CHEMICAL SHIELDINGS AND ANISOTROPIES
--------------------------------

 Nucleus  0 C :
   Total shielding tensor (ppm):
       100.0   0.0   0.0
         0.0 100.0   0.0
         0.0   0.0 100.0
   Isotropic shielding:    184.3456 ppm
   Shielding anisotropy:     12.3421 ppm

 Nucleus  1 H :
   Total isotropic shielding  =   31.8234 ppm
   Shielding anisotropy:       5.1234 ppm

****ORCA TERMINATED NORMALLY****
"""


def test_parse_shieldings_per_atom_block():
    result = parse_shieldings(_PER_ATOM_SAMPLE)
    assert result == {0: 184.3456, 1: 31.8234}


_TABLE_SAMPLE = """
-----------------------------------------
 CHEMICAL SHIELDING SUMMARY (ppm)
-----------------------------------------

  Nucleus  Element  Isotropic      Anisotropy
  -------  -------  ------------   -------------
     0        C       184.3456       12.3421
     1        H        31.8234        5.1234
     2        H        31.7901        5.0012

****ORCA TERMINATED NORMALLY****
"""


def test_parse_shieldings_summary_table():
    result = parse_shieldings(_TABLE_SAMPLE)
    assert result == {0: 184.3456, 1: 31.8234, 2: 31.7901}


def test_parse_shieldings_missing_returns_empty():
    result = parse_shieldings("no shielding data here\n")
    assert result == {}


# ---------------------------------------------------------------------
# Live end-to-end — gated on RUN_ORCA_TESTS=1 because it's slow
# ---------------------------------------------------------------------

@pytest.mark.skipif(
    not _orca_live_tests_enabled(),
    reason="ORCA live tests disabled (set RUN_ORCA_TESTS=1 and install ORCA to enable)",
)
def test_orca_predicts_methane_carbon_live():
    canon = canonicalize("C", add_hs=True)
    shifts = get_engine("orca").predict(canon.mol, "13C", conformer_strategy="fast")
    assert len(shifts) == 1
    delta = shifts[0].shift_ppm
    # Methane δ(13C) is experimentally ≈ -2 ppm vs TMS; cheap DFT will
    # drift but should still sit in this broad band.
    assert -30.0 < delta < 30.0, f"CH4 13C shift out of sane range: {delta}"
    assert shifts[0].symbol == "C"
    assert shifts[0].atom_index == 0
