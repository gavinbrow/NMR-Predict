"""CDK engine tests.

The full end-to-end predict path is skipped unless ``CDK_JAR_PATH`` is
configured — CI and developer machines without the nmrshiftdb jar
should still be able to run the smoke suite. The import-time and
registry checks always run.
"""
from __future__ import annotations

import os

import pytest

from app.chem.canonical import canonicalize
from app.engines import engine_is_implemented, get_engine
from app.engines.cdk import CdkEngine, CdkEngineError


def test_registry_lists_cdk_as_implemented():
    assert engine_is_implemented("cdk")
    assert get_engine("cdk").name == "cdk"
    assert get_engine("cdk").default_weight == 0.5


def test_cdk_engine_rejects_unknown_nucleus():
    engine = CdkEngine()
    canon = canonicalize("CCO", add_hs=True)
    with pytest.raises(CdkEngineError, match="Unsupported nucleus"):
        engine.predict(canon.mol, "19F")


def test_cdk_engine_requires_jar_path(monkeypatch):
    # Force an unconfigured classpath regardless of the host env.
    from app import config as app_config

    monkeypatch.setattr(app_config.settings, "cdk_jar_path", "")
    engine = CdkEngine()
    with pytest.raises(CdkEngineError, match="CDK_JAR_PATH"):
        engine.predict(canonicalize("CCO", add_hs=True).mol, "13C")


def test_cdk_engine_can_resolve_jvm_from_java_home(monkeypatch, tmp_path):
    java_home = tmp_path / "jdk-17"
    jvm_path = java_home / "bin" / "server" / "jvm.dll"
    jvm_path.parent.mkdir(parents=True)
    jvm_path.write_bytes(b"")

    engine = CdkEngine()
    monkeypatch.setenv("JAVA_HOME", str(java_home))
    monkeypatch.setattr("app.engines.cdk.shutil.which", lambda _name: None)
    jvm_not_found = type("JVMNotFoundException", (Exception,), {})

    class FakeJpype:
        JVMNotFoundException = jvm_not_found

        @staticmethod
        def getDefaultJVMPath():
            raise jvm_not_found()

    assert engine._resolve_jvm_path(FakeJpype) == str(jvm_path.resolve())


def test_cdk_engine_resolves_split_predictor_jars(monkeypatch, tmp_path):
    predictor_c = tmp_path / "predictorc.jar"
    predictor_h = tmp_path / "predictorh.jar"
    core = tmp_path / "cdk-2.9.jar"
    predictor_c.write_bytes(b"")
    predictor_h.write_bytes(b"")
    core.write_bytes(b"")

    from app import config as app_config

    monkeypatch.setattr(app_config.settings, "cdk_jar_path", str(tmp_path))
    engine = CdkEngine()

    entries = engine._expand_classpath_entries(str(tmp_path))
    assert str(core) in entries
    assert str(predictor_c) in entries
    assert str(predictor_h) in entries
    assert engine._has_predictor_jar(entries)
    core_jars, predictor_jars = engine._resolve_classpath()
    assert core_jars == [str(core)]
    assert predictor_jars["13C"] == str(predictor_c)
    assert predictor_jars["1H"] == str(predictor_h)


@pytest.mark.skipif(
    not os.getenv("CDK_JAR_PATH"),
    reason="CDK_JAR_PATH not set — skipping live HOSE-code prediction test",
)
def test_cdk_predicts_ethanol_carbons():
    canon = canonicalize("CCO", add_hs=True)
    shifts = get_engine("cdk").predict(canon.mol, "13C")
    assert shifts, "expected at least one carbon shift"
    for s in shifts:
        assert s.symbol == "C"
        assert -10.0 < s.shift_ppm < 250.0  # 13C domain sanity
        assert 0 <= s.atom_index < canon.mol.GetNumAtoms()


@pytest.mark.skipif(
    not os.getenv("CDK_JAR_PATH"),
    reason="CDK_JAR_PATH not set — skipping live HOSE-code prediction test",
)
def test_cdk_predicts_ethanol_protons():
    canon = canonicalize("CCO", add_hs=True)
    shifts = get_engine("cdk").predict(canon.mol, "1H")
    assert shifts, "expected at least one proton shift"
    for s in shifts:
        assert s.symbol == "H"
        assert -1.0 < s.shift_ppm < 15.0  # 1H domain sanity
