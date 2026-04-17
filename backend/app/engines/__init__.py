"""Engine adapters — each module exposes predict(mol, nucleus, **options).

Use :func:`get_engine` to fetch a named engine. All three engines (CDK,
CASCADE, ORCA) are live; engines that fail to initialise still return
an ``EngineResult`` with ``status="error"`` through :mod:`app.main`
rather than raising into the HTTP response.
"""
from __future__ import annotations

from typing import Dict, List

from app.engines.base import Engine, NotImplementedEngine
from app.engines.cascade import cascade_engine
from app.engines.cdk import cdk_engine
from app.engines.orca import orca_engine


_REGISTRY: Dict[str, Engine] = {
    "cdk": cdk_engine,
    "cascade": cascade_engine,
    "orca": orca_engine,
}


def get_engine(name: str) -> Engine:
    try:
        return _REGISTRY[name]
    except KeyError as exc:
        raise KeyError(f"Unknown engine: {name!r}") from exc


def engine_is_implemented(name: str) -> bool:
    return name in _REGISTRY and not isinstance(_REGISTRY[name], NotImplementedEngine)


def list_engines() -> List[Engine]:
    """Return every registered engine, in a stable order."""
    return [_REGISTRY[name] for name in sorted(_REGISTRY)]


__all__ = ["get_engine", "engine_is_implemented", "list_engines"]
