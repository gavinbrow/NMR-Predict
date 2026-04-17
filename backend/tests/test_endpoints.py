"""HTTP-level tests for the FastAPI endpoints.

Engines that aren't fully set up (CDK without jars, CASCADE without
weights, ORCA without a binary) surface ``status: "error"`` rather than
raising — so /predict remains testable in CI without installing any
chemistry dependencies beyond RDKit.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.schemas import EngineResult


@pytest.fixture()
def client():
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def stub_run_engine(monkeypatch):
    def fake_run_engine(name, _mol, _nucleus, **_options):
        return EngineResult(engine=name, status="error", message="stubbed for endpoint test")

    monkeypatch.setattr("app.main._run_engine", fake_run_engine)


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_engines_lists_all_three(client):
    r = client.get("/engines")
    assert r.status_code == 200
    body = r.json()
    names = {e["name"] for e in body["engines"]}
    assert names == {"cdk", "cascade", "orca"}
    weights = {e["name"]: e["default_weight"] for e in body["engines"]}
    assert weights == {"cdk": 0.5, "cascade": 0.3, "orca": 0.2}
    # Every engine must be flagged implemented; readiness depends on env.
    for entry in body["engines"]:
        assert entry["implemented"] is True
        assert "ready" in entry


def test_options_enumerates_literals(client):
    r = client.get("/options")
    assert r.status_code == 200
    body = r.json()
    assert body["nuclei"] == ["1H", "13C"]
    assert set(body["modes"]) == {"individual", "consensus"}
    assert set(body["conformer_strategies"]) == {"fast", "goat"}
    assert set(body["engines"]) == {"cdk", "cascade", "orca"}


def test_validate_accepts_benzene(client):
    r = client.post("/validate", json={"smiles": "c1ccccc1"})
    assert r.status_code == 200
    body = r.json()
    assert body["valid"] is True
    assert body["canonical_smiles"]


def test_validate_rejects_garbage(client):
    r = client.post("/validate", json={"smiles": "not a smiles"})
    assert r.status_code == 200
    body = r.json()
    assert body["valid"] is False
    assert body["error"]


def test_predict_individual_mode_returns_no_consensus(client, stub_run_engine):
    r = client.post("/predict", json={
        "smiles": "CCO",
        "engines": ["cdk"],
        "mode": "individual",
        "nucleus": "13C",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["consensus"] is None
    assert "cdk" in body["engines"]


def test_predict_consensus_mode_includes_consensus_block(client, stub_run_engine):
    # Even if every engine errors out (missing deps in CI), the consensus
    # block should be present — just with empty shifts and no weights.
    r = client.post("/predict", json={
        "smiles": "CCO",
        "engines": ["cdk", "cascade", "orca"],
        "mode": "consensus",
        "nucleus": "13C",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["consensus"] is not None
    assert "shifts" in body["consensus"]
    assert "weights_used" in body["consensus"]


def test_predict_rejects_invalid_smiles_with_400(client):
    r = client.post("/predict", json={
        "smiles": "not a smiles",
        "engines": ["cdk"],
        "mode": "individual",
        "nucleus": "1H",
    })
    assert r.status_code == 400
