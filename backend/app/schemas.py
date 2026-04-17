from typing import List, Literal, Optional, Dict
from pydantic import BaseModel, Field


EngineName = Literal["cascade", "cdk", "orca"]
PredictionMode = Literal["individual", "consensus"]
ConformerStrategy = Literal["fast", "goat"]
Nucleus = Literal["1H", "13C"]


class PredictRequest(BaseModel):
    smiles: str = Field(..., description="SMILES string from the editor")
    engines: List[EngineName] = Field(default_factory=lambda: ["cdk"])
    mode: PredictionMode = "individual"
    nucleus: Nucleus = "1H"
    conformer_strategy: ConformerStrategy = Field(
        default="fast",
        description=(
            "Geometry search used by engines that consume a 3D structure "
            "(currently ORCA). 'fast' = RDKit ETKDG+MMFF, 'goat' = ORCA "
            "XTB2 GOAT global conformer search."
        ),
    )
    weights: Optional[Dict[EngineName, float]] = Field(
        default=None,
        description=(
            "Optional per-engine weight overrides for consensus mode. "
            "Keys not listed fall back to the engine's default_weight. "
            "Values are renormalised across engines that returned 'ok'."
        ),
    )


class AtomShift(BaseModel):
    atom_index: int
    symbol: str
    shift_ppm: float
    confidence: Optional[float] = None
    attached_atom_index: Optional[int] = None
    assignment_group: Optional[str] = None
    multiplicity: Optional[str] = None
    coupling_hz: Optional[float] = None
    neighbor_count: Optional[int] = None


class ConsensusAtomShift(AtomShift):
    """Per-atom consensus result. Extends :class:`AtomShift` with the
    engines that contributed and the unweighted standard deviation of
    their predictions (a rough spread/confidence proxy)."""
    contributing_engines: List[EngineName] = Field(default_factory=list)
    std_ppm: Optional[float] = None


class EngineResult(BaseModel):
    engine: EngineName
    status: Literal["ok", "pending", "error"]
    shifts: List[AtomShift] = Field(default_factory=list)
    message: Optional[str] = None


class ConsensusResult(BaseModel):
    """Consensus output bundle — one entry per atom that at least one
    engine returned a shift for, plus the weights that were actually
    applied (after renormalisation over engines that returned 'ok')."""
    shifts: List[ConsensusAtomShift] = Field(default_factory=list)
    weights_used: Dict[EngineName, float] = Field(default_factory=dict)


class PredictResponse(BaseModel):
    canonical_smiles: str
    atom_symbols: List[str]
    engines: Dict[EngineName, EngineResult]
    consensus: Optional[ConsensusResult] = None


class ValidationResponse(BaseModel):
    valid: bool
    canonical_smiles: Optional[str] = None
    error: Optional[str] = None


class EngineInfo(BaseModel):
    name: EngineName
    default_weight: float
    implemented: bool
    ready: bool
    message: Optional[str] = None


class EnginesResponse(BaseModel):
    engines: List[EngineInfo]


class OptionsResponse(BaseModel):
    nuclei: List[Nucleus]
    modes: List[PredictionMode]
    conformer_strategies: List[ConformerStrategy]
    engines: List[EngineName]
