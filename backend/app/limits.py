"""Centralised request and engine safety limits."""

from __future__ import annotations

MAX_SMILES_LENGTH = 256
MAX_HEAVY_ATOMS = 64
MAX_TOTAL_ATOMS = 192

# ORCA is single-worker and expensive. Keep the wait queue short so callers
# fail fast under load instead of piling up unbounded work.
DEFAULT_ORCA_MAX_PENDING_REQUESTS = 2
DEFAULT_ORCA_JOB_TTL_SECONDS = 60 * 60
DEFAULT_ORCA_RAM_CEILING_MB = 8192
