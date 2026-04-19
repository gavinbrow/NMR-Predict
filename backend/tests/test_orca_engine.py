"""ORCA engine tests."""
from __future__ import annotations

import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from app.chem.canonical import canonicalize
from app.config import settings
from app.engines import engine_is_implemented, get_engine
from app.engines.orca import (
    OrcaEngine,
    OrcaEngineError,
    _build_goat_input,
    _build_nmr_input,
    _get_tms_reference,
    _run_orca,
    _tms_cache_key,
    parse_shieldings,
)


def _orca_live_tests_enabled() -> bool:
    return os.getenv("RUN_ORCA_TESTS") == "1" and Path(settings.orca_exe).is_file()


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

    key = _tms_cache_key(app_config.settings.orca_functional, app_config.settings.orca_basis)
    (tmp_path / "tms_refs.json").write_text(
        json.dumps({key: {"1H": 31.8, "13C": 188.1}}),
        encoding="utf-8",
    )

    engine = OrcaEngine()
    canon = canonicalize("CCO", add_hs=True)
    with pytest.raises(OrcaEngineError, match="ORCA binary not found"):
        engine.predict(canon.mol, "13C")


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


def test_run_orca_times_out_and_cleans_job_dir(monkeypatch, tmp_path):
    from app import config as app_config

    orca_exe = tmp_path / "orca.exe"
    orca_exe.write_text("", encoding="utf-8")
    monkeypatch.setattr(app_config.settings, "orca_exe", str(orca_exe))
    monkeypatch.setattr(app_config.settings, "orca_work_dir", str(tmp_path))
    monkeypatch.setattr(app_config.settings, "orca_timeout_seconds", 30)

    class FakeTimedOutProcess:
        pid = 1234
        returncode = None

        def wait(self, timeout):
            raise subprocess.TimeoutExpired(cmd="orca", timeout=timeout)

        def poll(self):
            return None

        def kill(self):
            self.returncode = -9

    monkeypatch.setattr("app.engines.orca.subprocess.Popen", lambda *args, **kwargs: FakeTimedOutProcess())
    monkeypatch.setattr(
        "app.engines.orca.subprocess.run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args, 0),
    )

    job_dir = tmp_path / "job-timeout"
    with pytest.raises(OrcaEngineError, match="timed out"):
        _run_orca("! test", base="sample", subdir="job-timeout")

    assert not job_dir.exists()


def test_get_tms_reference_serializes_cache_updates(monkeypatch, tmp_path):
    from app import config as app_config

    monkeypatch.setattr(app_config.settings, "orca_work_dir", str(tmp_path))

    def fake_compute(functional: str, basis: str):
        return {"1H": float(len(functional)), "13C": float(len(basis))}

    monkeypatch.setattr("app.engines.orca._compute_tms_reference", fake_compute)

    with ThreadPoolExecutor(max_workers=2) as executor:
        future_a = executor.submit(_get_tms_reference, "PBE", "def2-SVP")
        future_b = executor.submit(_get_tms_reference, "B3LYP", "def2-TZVP")
        assert future_a.result()["1H"] == 3.0
        assert future_b.result()["13C"] == 9.0

    cache = json.loads((tmp_path / "tms_refs.json").read_text(encoding="utf-8"))
    assert cache[_tms_cache_key("PBE", "def2-SVP")] == {"1H": 3.0, "13C": 8.0}
    assert cache[_tms_cache_key("B3LYP", "def2-TZVP")] == {"1H": 5.0, "13C": 9.0}


@pytest.mark.skipif(
    not _orca_live_tests_enabled(),
    reason="ORCA live tests disabled (set RUN_ORCA_TESTS=1 and install ORCA to enable)",
)
def test_orca_predicts_methane_carbon_live():
    canon = canonicalize("C", add_hs=True)
    shifts = get_engine("orca").predict(canon.mol, "13C", conformer_strategy="fast")
    assert len(shifts) == 1
    delta = shifts[0].shift_ppm
    assert -30.0 < delta < 30.0, f"CH4 13C shift out of sane range: {delta}"
    assert shifts[0].symbol == "C"
    assert shifts[0].atom_index == 0
