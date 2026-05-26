"""Accuracy regression gate.

Runs the benchmark harness over the curated dataset and asserts each engine's
overall MAE (per nucleus) stays under a calibrated threshold. Thresholds are set
with headroom above the values observed on the first real run, so they catch
regressions (a broken engine, a bad model swap) rather than normal variance.

Engines that aren't available are skipped, mirroring the gating in
``test_cdk_engine.py`` / ``test_cascade_engine.py`` / ``test_orca_engine.py`` —
this file never fails just because an engine isn't installed.

Exchangeable (OH/NH/COOH) protons are excluded from the 1H gate because their
experimental shifts are solvent/concentration dependent and noisy.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.config import settings
from app.engines import get_engine
from benchmarks import metrics
from benchmarks.dataset import load_dataset
from benchmarks.runner import run_engine


# --- gating helpers (mirror the per-engine test modules) -------------------
def _cdk_ready() -> bool:
    return bool(os.getenv("CDK_JAR_PATH")) and get_engine("cdk").is_ready()[0]


def _cascade_assets_present() -> bool:
    root = settings.cascade_path
    return bool(root) and os.path.isfile(os.path.join(root, "preprocessor.p"))


def _orca_live_tests_enabled() -> bool:
    return os.getenv("RUN_ORCA_TESTS") == "1" and Path(settings.orca_exe).is_file()


# overall MAE ceilings (ppm), per engine + nucleus. Calibrated with headroom.
_THRESHOLDS = {
    ("cdk", "13C"): 6.0,
    ("cdk", "1H"): 1.0,
    ("cascade", "13C"): 4.0,
    ("cascade", "1H"): 0.6,
    # ORCA live tests are expensive and benchmark-dependent, so keep this
    # generous enough to catch breakage rather than method-to-method variance.
    ("orca", "13C"): 25.0,
    ("orca", "1H"): 2.0,
}


def _assert_engine_within_threshold(engine_name: str) -> None:
    dataset = load_dataset()
    result = run_engine(
        engine_name,
        dataset,
        ["13C", "1H"],
        skip_unready=True,
        exclude_exchangeable=True,
    )
    # If everything was skipped, the engine wasn't actually available.
    if all(r.status == "skipped" for r in result.runs):
        pytest.skip(f"{engine_name} engine not available")

    for nucleus in ("13C", "1H"):
        pts = [p for p in result.points if p.nucleus == nucleus]
        assert pts, f"{engine_name} produced no scorable {nucleus} points"
        mae = metrics.mae(
            [p.predicted_ppm for p in pts], [p.reference_ppm for p in pts]
        )
        ceiling = _THRESHOLDS[(engine_name, nucleus)]
        assert mae < ceiling, (
            f"{engine_name} {nucleus} MAE {mae:.3f} exceeds {ceiling} "
            f"(regression?). n={len(pts)}"
        )


@pytest.mark.skipif(not _cdk_ready(), reason="CDK_JAR_PATH not set / CDK not ready")
def test_cdk_accuracy_within_threshold():
    _assert_engine_within_threshold("cdk")


@pytest.mark.skipif(
    not _cascade_assets_present(), reason="CASCADE assets not found"
)
def test_cascade_accuracy_within_threshold():
    _assert_engine_within_threshold("cascade")


@pytest.mark.skipif(
    not _orca_live_tests_enabled(),
    reason="ORCA live tests disabled (set RUN_ORCA_TESTS=1 and install ORCA)",
)
def test_orca_accuracy_within_threshold():
    _assert_engine_within_threshold("orca")


def test_harness_skips_unready_engine_gracefully(monkeypatch):
    """A not-ready engine yields all-skipped runs, never an exception."""
    from app import config as app_config

    # Force CDK unready by blanking its classpath.
    monkeypatch.setattr(app_config.settings, "cdk_jar_path", "")
    dataset = load_dataset().filter(ids=["ethanol", "benzene"])
    result = run_engine("cdk", dataset, ["13C"], skip_unready=True)
    assert result.points == []
    assert result.runs and all(r.status == "skipped" for r in result.runs)
