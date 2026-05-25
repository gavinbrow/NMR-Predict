"""Accuracy metrics for NMR shift predictions.

Pure functions over paired (predicted, reference) ppm values. No engine or
RDKit imports, so these are trivially unit-testable with hand-computed numbers.

All functions take two equal-length sequences ``predicted`` and ``reference``
and return a single float. They raise ``ValueError`` on length mismatch and
return ``float('nan')`` for an empty input (so an engine that produced no
matchable shifts surfaces as NaN rather than a misleading 0.0).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence, Tuple


def _check(predicted: Sequence[float], reference: Sequence[float]) -> int:
    if len(predicted) != len(reference):
        raise ValueError(
            f"predicted/reference length mismatch: {len(predicted)} vs {len(reference)}"
        )
    return len(predicted)


def mae(predicted: Sequence[float], reference: Sequence[float]) -> float:
    """Mean absolute error."""
    n = _check(predicted, reference)
    if n == 0:
        return float("nan")
    return sum(abs(p - r) for p, r in zip(predicted, reference)) / n


def rmse(predicted: Sequence[float], reference: Sequence[float]) -> float:
    """Root-mean-square error."""
    n = _check(predicted, reference)
    if n == 0:
        return float("nan")
    return math.sqrt(sum((p - r) ** 2 for p, r in zip(predicted, reference)) / n)


def max_abs_err(predicted: Sequence[float], reference: Sequence[float]) -> float:
    """Largest single absolute error."""
    n = _check(predicted, reference)
    if n == 0:
        return float("nan")
    return max(abs(p - r) for p, r in zip(predicted, reference))


def bias(predicted: Sequence[float], reference: Sequence[float]) -> float:
    """Signed mean error (predicted − reference). Positive = over-prediction."""
    n = _check(predicted, reference)
    if n == 0:
        return float("nan")
    return sum(p - r for p, r in zip(predicted, reference)) / n


def r2(predicted: Sequence[float], reference: Sequence[float]) -> float:
    """Coefficient of determination of predicted vs reference.

    Defined here as 1 − SS_res / SS_tot, where SS_res uses (predicted −
    reference) and SS_tot is the variance of the reference values. Returns NaN
    if fewer than two points or if the reference values are all identical
    (SS_tot == 0), where R² is undefined.
    """
    n = _check(predicted, reference)
    if n < 2:
        return float("nan")
    mean_ref = sum(reference) / n
    ss_tot = sum((r - mean_ref) ** 2 for r in reference)
    if ss_tot == 0.0:
        return float("nan")
    ss_res = sum((p - r) ** 2 for p, r in zip(predicted, reference))
    return 1.0 - ss_res / ss_tot


@dataclass(frozen=True)
class LinearScaling:
    """A least-squares fit ``reference ≈ slope * predicted + intercept``.

    DFT-NMR shifts are often systematically biased but highly linear vs
    experiment; applying this regression removes the bias so a cheap level of
    theory that is merely *offset* isn't unfairly penalised.
    """

    slope: float
    intercept: float

    def apply(self, predicted_value: float) -> float:
        return self.slope * predicted_value + self.intercept


def fit_linear_scaling(
    predicted: Sequence[float], reference: Sequence[float]
) -> LinearScaling:
    """Ordinary least-squares fit of reference onto predicted.

    Returns the identity scaling (slope 1, intercept 0) when there are fewer
    than two points or the predicted values have zero variance.
    """
    n = _check(predicted, reference)
    if n < 2:
        return LinearScaling(slope=1.0, intercept=0.0)
    mean_p = sum(predicted) / n
    mean_r = sum(reference) / n
    var_p = sum((p - mean_p) ** 2 for p in predicted)
    if var_p == 0.0:
        return LinearScaling(slope=1.0, intercept=0.0)
    cov = sum((p - mean_p) * (r - mean_r) for p, r in zip(predicted, reference))
    slope = cov / var_p
    intercept = mean_r - slope * mean_p
    return LinearScaling(slope=slope, intercept=intercept)


@dataclass(frozen=True)
class MetricSummary:
    """Bundle of all scalar metrics for one set of paired shifts."""

    n: int
    mae: float
    rmse: float
    max_abs_err: float
    bias: float
    r2: float

    def as_row(self) -> Tuple[int, float, float, float, float, float]:
        return (self.n, self.mae, self.rmse, self.max_abs_err, self.bias, self.r2)


def summarize(
    predicted: Sequence[float], reference: Sequence[float]
) -> MetricSummary:
    """Compute every metric in one pass-friendly call."""
    n = _check(predicted, reference)
    return MetricSummary(
        n=n,
        mae=mae(predicted, reference),
        rmse=rmse(predicted, reference),
        max_abs_err=max_abs_err(predicted, reference),
        bias=bias(predicted, reference),
        r2=r2(predicted, reference),
    )
