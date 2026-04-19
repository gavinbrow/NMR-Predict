"""HTTP-level tests for the FastAPI endpoints."""
from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import main as main_module
from app.chem.canonical import canonicalize
from app.limits import MAX_SMILES_LENGTH
from app.schemas import AtomShift, EngineResult


@pytest.fixture()
def client():
    with TestClient(main_module.app) as test_client:
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


def test_validate_forbids_extra_keys(client):
    r = client.post("/validate", json={"smiles": "CCO", "extra": "nope"})
    assert r.status_code == 422


def test_validate_rejects_oversized_smiles_payload(client):
    r = client.post("/validate", json={"smiles": "C" * (MAX_SMILES_LENGTH + 1)})
    assert r.status_code == 422


def test_predict_individual_mode_returns_no_consensus(client, stub_run_engine):
    r = client.post(
        "/predict",
        json={
            "smiles": "CCO",
            "engines": ["cdk"],
            "mode": "individual",
            "nucleus": "13C",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["consensus"] is None
    assert "cdk" in body["engines"]


def test_predict_consensus_mode_includes_consensus_block(client, stub_run_engine):
    r = client.post(
        "/predict",
        json={
            "smiles": "CCO",
            "engines": ["cdk", "cascade", "orca"],
            "mode": "consensus",
            "nucleus": "13C",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["consensus"] is not None
    assert "shifts" in body["consensus"]
    assert "weights_used" in body["consensus"]


def test_predict_rejects_invalid_smiles_with_400(client):
    r = client.post(
        "/predict",
        json={
            "smiles": "not a smiles",
            "engines": ["cdk"],
            "mode": "individual",
            "nucleus": "1H",
        },
    )
    assert r.status_code == 400


def test_predict_rejects_oversized_molecule_with_400(client):
    r = client.post(
        "/predict",
        json={
            "smiles": "C" * 65,
            "engines": ["cdk"],
            "mode": "individual",
            "nucleus": "13C",
        },
    )
    assert r.status_code == 400
    assert "too large" in r.json()["detail"]


def test_run_engine_sanitizes_internal_engine_errors(monkeypatch):
    class BrokenEngine:
        def predict(self, _mol, _nucleus, **_options):
            raise RuntimeError("secret filesystem path")

    monkeypatch.setattr(main_module, "engine_is_implemented", lambda _name: True)
    monkeypatch.setattr(main_module, "get_engine", lambda _name: BrokenEngine())

    canon = canonicalize("CCO", add_hs=True)
    result = main_module._run_engine("orca", canon.mol, "13C")

    assert result.status == "error"
    assert "Reference ID:" in (result.message or "")
    assert "secret filesystem path" not in (result.message or "")


def test_run_engine_rejects_invalid_atom_indices(monkeypatch):
    class InvalidIndexEngine:
        def predict(self, _mol, _nucleus, **_options):
            return [AtomShift(atom_index=999, symbol="C", shift_ppm=10.0)]

    monkeypatch.setattr(main_module, "engine_is_implemented", lambda _name: True)
    monkeypatch.setattr(main_module, "get_engine", lambda _name: InvalidIndexEngine())

    canon = canonicalize("CCO", add_hs=True)
    result = main_module._run_engine("cdk", canon.mol, "13C")

    assert result.status == "error"
    assert "Reference ID:" in (result.message or "")


def test_resolve_frontend_candidate_rejects_path_traversal(tmp_path):
    frontend_root = (tmp_path / "dist").resolve()
    frontend_root.mkdir()

    with pytest.raises(HTTPException) as excinfo:
        main_module._resolve_frontend_candidate(frontend_root, "../README.md")

    assert excinfo.value.status_code == 404


@pytest.mark.skipif(
    not main_module.FRONTEND_DIST.exists(),
    reason="frontend dist not built in this checkout",
)
def test_frontend_api_guard_is_case_insensitive(client):
    r = client.get("/API/health")
    assert r.status_code == 404
