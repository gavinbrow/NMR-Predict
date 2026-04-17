import logging
import os
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.chem.canonical import canonicalize, InvalidSmilesError
from app.consensus import DEFAULT_WEIGHTS, compute_consensus
from app.engines import engine_is_implemented, get_engine, list_engines
from app.engines.cascade import CascadeEngineError
from app.engines.cdk import CdkEngineError, cdk_engine
from app.engines.orca import OrcaEngineError
from app.signal_annotations import annotate_atom_shifts
from app.schemas import (
    AtomShift,
    EngineInfo,
    EngineResult,
    EnginesResponse,
    OptionsResponse,
    PredictRequest,
    PredictResponse,
    ValidationResponse,
)

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"
DEV_FRONTEND_ORIGINS = [
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]

app = FastAPI(title="NMR Predict", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=DEV_FRONTEND_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _warmup_cdk_engine() -> None:
    ready, reason = cdk_engine.is_ready()
    if not ready:
        logger.info("Skipping CDK warmup: %s", reason)
        return

    try:
        cdk_engine.warmup()
    except CdkEngineError as exc:
        logger.warning("CDK warmup failed: %s", exc)


if os.getenv("NMR_SKIP_CDK_WARMUP") != "1" and "pytest" not in sys.modules:
    _warmup_cdk_engine()


@app.get("/api/health", include_in_schema=False)
@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/engines", include_in_schema=False, response_model=EnginesResponse)
@app.get("/engines", response_model=EnginesResponse)
def engines() -> EnginesResponse:
    infos = []
    for engine in list_engines():
        ready, reason = engine.is_ready()
        infos.append(
            EngineInfo(
                name=engine.name,
                default_weight=engine.default_weight,
                implemented=engine_is_implemented(engine.name),
                ready=ready,
                message=reason,
            )
        )
    return EnginesResponse(engines=infos)


@app.get("/api/options", include_in_schema=False, response_model=OptionsResponse)
@app.get("/options", response_model=OptionsResponse)
def options() -> OptionsResponse:
    return OptionsResponse(
        nuclei=["1H", "13C"],
        modes=["individual", "consensus"],
        conformer_strategies=["fast", "goat"],
        engines=[e.name for e in list_engines()],
    )


@app.post("/api/validate", include_in_schema=False, response_model=ValidationResponse)
@app.post("/validate", response_model=ValidationResponse)
def validate(payload: dict) -> ValidationResponse:
    smiles = payload.get("smiles", "")
    try:
        canon = canonicalize(smiles, add_hs=False)
    except InvalidSmilesError as exc:
        return ValidationResponse(valid=False, error=str(exc))
    return ValidationResponse(valid=True, canonical_smiles=canon.canonical_smiles)


def _run_engine(name: str, mol, nucleus: str, **options) -> EngineResult:
    if not engine_is_implemented(name):
        return EngineResult(
            engine=name,
            status="pending",
            message=f"{name} engine not yet wired up.",
        )
    engine = get_engine(name)
    try:
        shifts: list[AtomShift] = engine.predict(mol, nucleus, **options)
    except (CdkEngineError, CascadeEngineError, OrcaEngineError) as exc:
        logger.warning("%s engine error: %s", name, exc)
        return EngineResult(engine=name, status="error", message=str(exc))
    except Exception as exc:  # noqa: BLE001 — convert to JSON error per-engine
        logger.exception("Unhandled engine failure for %s", name)
        return EngineResult(engine=name, status="error", message=f"{type(exc).__name__}: {exc}")
    shifts = annotate_atom_shifts(mol, nucleus, shifts)
    return EngineResult(engine=name, status="ok", shifts=shifts)


@app.post("/api/predict", include_in_schema=False, response_model=PredictResponse)
@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest) -> PredictResponse:
    try:
        canon = canonicalize(req.smiles, add_hs=True)
    except InvalidSmilesError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    engine_opts = {"conformer_strategy": req.conformer_strategy}
    engine_results = {
        name: _run_engine(name, canon.mol, req.nucleus, **engine_opts)
        for name in req.engines
    }

    consensus = None
    if req.mode == "consensus":
        consensus = compute_consensus(engine_results, weights=req.weights)

    return PredictResponse(
        canonical_smiles=canon.canonical_smiles,
        atom_symbols=canon.atom_symbols,
        engines=engine_results,
        consensus=consensus,
    )


if FRONTEND_DIST.exists():
    assets_dir = FRONTEND_DIST / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="frontend-assets")

    @app.get("/", include_in_schema=False)
    async def serve_frontend_root():
        return FileResponse(FRONTEND_DIST / "index.html")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_frontend_app(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")

        candidate = FRONTEND_DIST / full_path
        if candidate.is_file():
            return FileResponse(candidate)

        if "." in Path(full_path).name:
            raise HTTPException(status_code=404, detail="Asset not found")

        return FileResponse(FRONTEND_DIST / "index.html")
