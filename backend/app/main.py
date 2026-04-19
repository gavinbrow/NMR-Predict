import logging
import os
import sys
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.chem.canonical import InvalidSmilesError, canonicalize
from app.consensus import compute_consensus
from app.engines import engine_is_implemented, get_engine, list_engines
from app.engines.cascade import CascadeEngineError
from app.engines.cdk import CdkEngineError, cdk_engine
from app.engines.orca import OrcaEngineError
from app.schemas import (
    AtomShift,
    EngineInfo,
    EngineResult,
    EnginesResponse,
    OptionsResponse,
    PredictRequest,
    PredictResponse,
    ValidationRequest,
    ValidationResponse,
)
from app.signal_annotations import annotate_atom_shifts

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
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
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
def validate(payload: ValidationRequest) -> ValidationResponse:
    try:
        canon = canonicalize(payload.smiles, add_hs=False)
    except InvalidSmilesError as exc:
        return ValidationResponse(valid=False, error=str(exc))
    return ValidationResponse(valid=True, canonical_smiles=canon.canonical_smiles)


def _validate_atom_indices(engine_name: str, atom_count: int, shifts: list[AtomShift]) -> None:
    for shift in shifts:
        if not 0 <= shift.atom_index < atom_count:
            raise ValueError(
                f"{engine_name} returned atom_index={shift.atom_index} for a molecule "
                f"with {atom_count} atoms"
            )
        if shift.attached_atom_index is not None and not 0 <= shift.attached_atom_index < atom_count:
            raise ValueError(
                f"{engine_name} returned attached_atom_index={shift.attached_atom_index} "
                f"for a molecule with {atom_count} atoms"
            )


def _sanitized_engine_message(name: str, error_id: str) -> str:
    return f"{name} prediction failed. Reference ID: {error_id}"


def _resolve_frontend_candidate(frontend_root: Path, full_path: str) -> Path:
    requested = full_path.replace("\\", "/").lstrip("/")
    candidate = (frontend_root / requested).resolve(strict=False)
    try:
        candidate.relative_to(frontend_root)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Not found") from exc
    return candidate


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
        _validate_atom_indices(name, mol.GetNumAtoms(), shifts)
        shifts = annotate_atom_shifts(mol, nucleus, shifts)
        _validate_atom_indices(name, mol.GetNumAtoms(), shifts)
    except (CdkEngineError, CascadeEngineError, OrcaEngineError, ValueError):
        error_id = uuid.uuid4().hex[:12]
        logger.exception("%s engine failure [%s]", name, error_id)
        return EngineResult(
            engine=name,
            status="error",
            message=_sanitized_engine_message(name, error_id),
        )
    except Exception:  # noqa: BLE001
        error_id = uuid.uuid4().hex[:12]
        logger.exception("Unhandled engine failure for %s [%s]", name, error_id)
        return EngineResult(
            engine=name,
            status="error",
            message=_sanitized_engine_message(name, error_id),
        )

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
    FRONTEND_ROOT = FRONTEND_DIST.resolve()

    assets_dir = FRONTEND_DIST / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="frontend-assets")

    @app.get("/", include_in_schema=False)
    async def serve_frontend_root():
        return FileResponse(FRONTEND_DIST / "index.html")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_frontend_app(full_path: str):
        normalized_path = full_path.replace("\\", "/").lstrip("/")
        lowered_path = normalized_path.lower()
        if lowered_path == "api" or lowered_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")

        candidate = _resolve_frontend_candidate(FRONTEND_ROOT, normalized_path)
        if candidate.is_file():
            return FileResponse(candidate)

        if "." in Path(normalized_path).name:
            raise HTTPException(status_code=404, detail="Asset not found")

        return FileResponse(FRONTEND_DIST / "index.html")
