"""NMR Predict accuracy benchmark suite.

Standalone harness (not part of the FastAPI app) that runs the prediction
engines over a curated reference dataset and reports per-scenario accuracy
metrics, plus an ORCA functional/basis level-of-theory sweep.

Run via ``python -m benchmarks.cli ...`` from the ``backend/`` directory.
"""
