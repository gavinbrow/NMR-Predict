from __future__ import annotations

from abc import ABC, abstractmethod
from typing import List, Optional, Tuple

from rdkit import Chem

from app.schemas import AtomShift


class Engine(ABC):
    name: str
    default_weight: float

    @abstractmethod
    def predict(self, mol: Chem.Mol, nucleus: str, **options) -> List[AtomShift]:
        ...

    def is_ready(self) -> Tuple[bool, Optional[str]]:
        """Return (True, None) when prerequisites (env, assets, binaries) look
        satisfied; otherwise (False, reason). Cheap — no heavy loads or JVM
        starts. Used by ``GET /engines`` so the frontend can grey out engines
        whose deps aren't installed.
        """
        return True, None


class NotImplementedEngine(Engine):
    def __init__(self, name: str, weight: float):
        self.name = name
        self.default_weight = weight

    def predict(self, mol: Chem.Mol, nucleus: str, **options) -> List[AtomShift]:
        raise NotImplementedError(f"{self.name} engine not wired up yet")

    def is_ready(self) -> Tuple[bool, Optional[str]]:
        return False, f"{self.name} engine not wired up yet"
