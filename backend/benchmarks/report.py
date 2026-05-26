"""Render :class:`BenchmarkResult` collections to CSV and Markdown reports.

Aggregation groups the raw per-group data points (see ``runner.DataPoint``) by
(engine/level, nucleus) and by (engine/level, nucleus, scenario), then computes
the metrics from :mod:`benchmarks.metrics`. Also emits a "worst offenders" list
to surface systematic failures.
"""
from __future__ import annotations

import csv
import datetime as _dt
import math
import os
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from benchmarks import metrics
from benchmarks.runner import BenchmarkResult, DataPoint, MoleculeRun

_REPORTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")


def _fmt(x: float) -> str:
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return "—"
    return f"{x:.3f}"


_SIZE_BUCKETS = (
    (1, 3, "tiny (1-3 heavy atoms)"),
    (4, 7, "small (4-7 heavy atoms)"),
    (8, 14, "medium (8-14 heavy atoms)"),
    (15, 10**9, "large (15+ heavy atoms)"),
)
_SIZE_BUCKET_ORDER = {bucket[2]: i for i, bucket in enumerate(_SIZE_BUCKETS)}


def size_bucket(heavy_atoms: Optional[int]) -> str:
    """Return the molecule-size bucket used for accuracy/time breakdowns."""
    if heavy_atoms is None:
        return "unknown"
    for lo, hi, label in _SIZE_BUCKETS:
        if lo <= heavy_atoms <= hi:
            return label
    return "unknown"


def _size_sort_key(bucket: str) -> int:
    return _SIZE_BUCKET_ORDER.get(bucket, len(_SIZE_BUCKET_ORDER))


def _safe_div(numerator: float, denominator: float) -> float:
    if denominator <= 0:
        return float("nan")
    return numerator / denominator


@dataclass(frozen=True)
class GroupSummary:
    label: str
    nucleus: str
    scenario: Optional[str]  # None == overall
    summary: metrics.MetricSummary
    seconds: float
    seconds_per_heavy_atom: float
    scaled_mae: float  # MAE after linear scaling (bias-removed)


@dataclass(frozen=True)
class SizeSummary:
    label: str
    nucleus: str
    bucket: str
    summary: metrics.MetricSummary
    seconds: float
    seconds_per_heavy_atom: float
    run_count: int


def _collect(results: Sequence[BenchmarkResult]) -> List[DataPoint]:
    pts: List[DataPoint] = []
    for r in results:
        pts.extend(r.points)
    return pts


def _summary_for(points: Sequence[DataPoint]) -> Tuple[metrics.MetricSummary, float]:
    """Return (metric summary, scaled MAE) for a set of points."""
    predicted = [p.predicted_ppm for p in points]
    reference = [p.reference_ppm for p in points]
    summary = metrics.summarize(predicted, reference)
    scaling = metrics.fit_linear_scaling(predicted, reference)
    scaled_pred = [scaling.apply(v) for v in predicted]
    scaled_mae = metrics.mae(scaled_pred, reference)
    return summary, scaled_mae


def summarize_results(results: Sequence[BenchmarkResult]) -> List[GroupSummary]:
    """Per (label, nucleus) overall summaries + per-scenario breakdowns."""
    summaries: List[GroupSummary] = []
    seconds_by_label_nuc: Dict[Tuple[str, str], float] = {}
    heavy_atoms_by_label_nuc: Dict[Tuple[str, str], int] = {}
    for r in results:
        for run in r.runs:
            key = (r.label, run.nucleus)
            seconds_by_label_nuc.setdefault(key, 0.0)
            seconds_by_label_nuc[key] += run.seconds
            if run.status != "skipped" and run.heavy_atoms:
                heavy_atoms_by_label_nuc.setdefault(key, 0)
                heavy_atoms_by_label_nuc[key] += run.heavy_atoms

    # Group points by label (engine + optional level) and nucleus.
    by_label_nuc: Dict[Tuple[str, str], List[DataPoint]] = {}
    for r in results:
        for p in r.points:
            by_label_nuc.setdefault((r.label, p.nucleus), []).append(p)

    for (label, nucleus), pts in sorted(by_label_nuc.items()):
        summary, scaled = _summary_for(pts)
        key = (label, nucleus)
        seconds = seconds_by_label_nuc.get(key, 0.0)
        summaries.append(
            GroupSummary(
                label=label,
                nucleus=nucleus,
                scenario=None,
                summary=summary,
                seconds=seconds,
                seconds_per_heavy_atom=_safe_div(
                    seconds,
                    heavy_atoms_by_label_nuc.get(key, 0),
                ),
                scaled_mae=scaled,
            )
        )
        # Per-scenario.
        scenarios = sorted({p.scenario for p in pts})
        for scenario in scenarios:
            spts = [p for p in pts if p.scenario == scenario]
            s_summary, s_scaled = _summary_for(spts)
            summaries.append(
                GroupSummary(
                    label=label,
                    nucleus=nucleus,
                    scenario=scenario,
                    summary=s_summary,
                    seconds=0.0,
                    seconds_per_heavy_atom=float("nan"),
                    scaled_mae=s_scaled,
                )
            )

    return summaries


def summarize_size_results(results: Sequence[BenchmarkResult]) -> List[SizeSummary]:
    """Summaries grouped by model, nucleus, and molecule heavy-atom bucket."""
    points_by_key: Dict[Tuple[str, str, str], List[DataPoint]] = {}
    seconds_by_key: Dict[Tuple[str, str, str], float] = {}
    heavy_atoms_by_key: Dict[Tuple[str, str, str], int] = {}
    runs_by_key: Dict[Tuple[str, str, str], int] = {}

    for r in results:
        for p in r.points:
            key = (r.label, p.nucleus, size_bucket(p.molecule_heavy_atoms))
            points_by_key.setdefault(key, []).append(p)
        for run in r.runs:
            if run.status == "skipped" or not run.heavy_atoms:
                continue
            key = (r.label, run.nucleus, size_bucket(run.heavy_atoms))
            seconds_by_key.setdefault(key, 0.0)
            heavy_atoms_by_key.setdefault(key, 0)
            runs_by_key.setdefault(key, 0)
            seconds_by_key[key] += run.seconds
            heavy_atoms_by_key[key] += run.heavy_atoms
            runs_by_key[key] += 1

    summaries: List[SizeSummary] = []
    for key, pts in sorted(
        points_by_key.items(),
        key=lambda item: (item[0][0], item[0][1], _size_sort_key(item[0][2])),
    ):
        summary, _scaled = _summary_for(pts)
        seconds = seconds_by_key.get(key, 0.0)
        summaries.append(
            SizeSummary(
                label=key[0],
                nucleus=key[1],
                bucket=key[2],
                summary=summary,
                seconds=seconds,
                seconds_per_heavy_atom=_safe_div(
                    seconds,
                    heavy_atoms_by_key.get(key, 0),
                ),
                run_count=runs_by_key.get(key, 0),
            )
        )
    return summaries


def worst_offenders(
    results: Sequence[BenchmarkResult], top_n: int = 15
) -> List[DataPoint]:
    pts = _collect(results)
    return sorted(pts, key=lambda p: p.abs_error, reverse=True)[:top_n]


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------
def render_markdown(
    results: Sequence[BenchmarkResult],
    *,
    title: str = "NMR Predict — Accuracy Benchmark",
    exclude_exchangeable: bool = False,
) -> str:
    summaries = summarize_results(results)
    overall = [s for s in summaries if s.scenario is None]
    per_scenario = [s for s in summaries if s.scenario is not None]

    lines: List[str] = []
    lines.append(f"# {title}")
    lines.append("")
    lines.append(f"_Generated {_dt.datetime.now().isoformat(timespec='seconds')}_")
    if exclude_exchangeable:
        lines.append("")
        lines.append("> Exchangeable (OH/NH/COOH) protons excluded from metrics.")
    lines.append("")

    # Skip / error accounting.
    lines.append("## Run coverage")
    lines.append("")
    lines.append("| Label | Nucleus | ok | skipped | error |")
    lines.append("| --- | --- | --- | --- | --- |")
    cov: Dict[Tuple[str, str], Dict[str, int]] = {}
    for r in results:
        for run in r.runs:
            d = cov.setdefault((r.label, run.nucleus), {"ok": 0, "skipped": 0, "error": 0})
            d[run.status] = d.get(run.status, 0) + 1
    for (label, nucleus), d in sorted(cov.items()):
        lines.append(f"| {label} | {nucleus} | {d['ok']} | {d['skipped']} | {d['error']} |")
    lines.append("")

    # Headline metrics.
    lines.append("## Overall accuracy")
    lines.append("")
    lines.append(
        "| Label | Nucleus | n | MAE | RMSE | Max err | Bias | R² | "
        "Scaled MAE | Total s | s/heavy atom |"
    )
    lines.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for s in overall:
        m = s.summary
        lines.append(
            f"| {s.label} | {s.nucleus} | {m.n} | {_fmt(m.mae)} | {_fmt(m.rmse)} | "
            f"{_fmt(m.max_abs_err)} | {_fmt(m.bias)} | {_fmt(m.r2)} | {_fmt(s.scaled_mae)} | "
            f"{_fmt(s.seconds)} | {_fmt(s.seconds_per_heavy_atom)} |"
        )
    lines.append("")
    lines.append(
        "_Scaled MAE = MAE after a least-squares linear correction "
        "(removes systematic bias; rewards levels that are linear-but-offset)._"
    )
    lines.append("")

    # Per-scenario breakdown.
    lines.append("## Per-scenario accuracy")
    lines.append("")
    lines.append("| Label | Nucleus | Scenario | n | MAE | RMSE | Max err | Bias |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for s in per_scenario:
        m = s.summary
        lines.append(
            f"| {s.label} | {s.nucleus} | {s.scenario} | {m.n} | {_fmt(m.mae)} | "
            f"{_fmt(m.rmse)} | {_fmt(m.max_abs_err)} | {_fmt(m.bias)} |"
        )
    lines.append("")

    # Molecule-size breakdown.
    size_summaries = summarize_size_results(results)
    if size_summaries:
        lines.append("## Per-size accuracy and speed")
        lines.append("")
        lines.append(
            "| Label | Nucleus | Size bucket | n | MAE | RMSE | Total s | s/heavy atom |"
        )
        lines.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
        for s in size_summaries:
            m = s.summary
            lines.append(
                f"| {s.label} | {s.nucleus} | {s.bucket} | {m.n} | {_fmt(m.mae)} | "
                f"{_fmt(m.rmse)} | {_fmt(s.seconds)} | {_fmt(s.seconds_per_heavy_atom)} |"
            )
        lines.append("")

    # Worst offenders.
    offenders = worst_offenders(results)
    if offenders:
        lines.append("## Worst offenders (largest absolute errors)")
        lines.append("")
        lines.append(
            "| Label | Nucleus | Molecule | Group | Ref ppm | Pred ppm | Abs err |"
        )
        lines.append("| --- | --- | --- | --- | --- | --- | --- |")
        # Recover label per point: search results.
        label_lookup = _point_label_lookup(results)
        for p in offenders:
            label = label_lookup.get(id(p), p.engine)
            lines.append(
                f"| {label} | {p.nucleus} | {p.molecule_id} | `{p.group_smarts}` | "
                f"{_fmt(p.reference_ppm)} | {_fmt(p.predicted_ppm)} | {_fmt(p.abs_error)} |"
            )
        lines.append("")

    return "\n".join(lines)


_HTML_STYLE = """
body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
       margin: 2rem auto; max-width: 1100px; color: #1b1b1b; line-height: 1.45; }
h1 { font-size: 1.6rem; margin-bottom: 0.2rem; }
h2 { font-size: 1.2rem; margin-top: 2rem; border-bottom: 2px solid #eee; padding-bottom: 0.2rem; }
.meta { color: #666; font-size: 0.9rem; }
.note { background: #f6f8fa; border-left: 3px solid #b8c2cc; padding: 0.5rem 0.8rem;
        margin: 0.8rem 0; font-size: 0.9rem; color: #444; }
table { border-collapse: collapse; width: 100%; margin: 0.6rem 0 1.4rem; font-size: 0.9rem; }
th, td { border: 1px solid #e1e4e8; padding: 0.35rem 0.6rem; text-align: right; }
th { background: #f1f3f5; text-align: center; }
td:first-child, th:first-child, td.l, th.l { text-align: left; }
tr:nth-child(even) td { background: #fafbfc; }
code { background: #f1f3f5; padding: 0.05rem 0.3rem; border-radius: 3px; font-size: 0.85em; }
.chart { border: 1px solid #e1e4e8; border-radius: 10px; padding: 0.8rem 1rem;
         margin: 1rem 0 1.4rem; background: linear-gradient(180deg, #fff, #f8fafc); }
.chart figcaption { font-weight: 700; margin-bottom: 0.7rem; }
.bar-row { display: grid; grid-template-columns: minmax(13rem, 28%) 1fr 7rem;
           gap: 0.7rem; align-items: center; margin: 0.35rem 0; font-size: 0.85rem; }
.bar-label { overflow-wrap: anywhere; color: #243042; }
.bar-track { background: #e8edf3; border-radius: 999px; height: 0.75rem; overflow: hidden; }
.bar-fill { background: linear-gradient(90deg, #2f80ed, #1f9d8a); height: 100%; border-radius: 999px; }
.bar-value { color: #243042; font-variant-numeric: tabular-nums; text-align: right; }
"""


def _html_escape(s: str) -> str:
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _html_table(headers: Sequence[str], rows: Sequence[Sequence[object]],
                left_cols: Sequence[int] = ()) -> str:
    left = set(left_cols)
    out = ["<table>", "<thead><tr>"]
    for i, h in enumerate(headers):
        cls = ' class="l"' if i in left else ""
        out.append(f"<th{cls}>{_html_escape(h)}</th>")
    out.append("</tr></thead><tbody>")
    for row in rows:
        out.append("<tr>")
        for i, cell in enumerate(row):
            cls = ' class="l"' if i in left else ""
            out.append(f"<td{cls}>{cell}</td>")  # cells pre-escaped/formatted
        out.append("</tr>")
    out.append("</tbody></table>")
    return "".join(out)


def _chart_rows(
    rows: Sequence[Tuple[str, float, str]],
    *,
    value_suffix: str = "",
) -> str:
    finite = [value for _label, value, _meta in rows if not math.isnan(value)]
    if not finite:
        return "<div class='note'>No finite values available.</div>"
    max_value = max(finite) or 1.0
    out: List[str] = []
    for label, value, meta in rows:
        if math.isnan(value):
            width = 0.0
            value_text = "n/a"
        else:
            width = max(1.0, min(100.0, (value / max_value) * 100.0))
            value_text = f"{value:.3f}{value_suffix}"
        if meta:
            label = f"{label} ({meta})"
        out.append(
            "<div class='bar-row'>"
            f"<div class='bar-label'>{_html_escape(label)}</div>"
            "<div class='bar-track'>"
            f"<div class='bar-fill' style='width:{width:.1f}%'></div>"
            "</div>"
            f"<div class='bar-value'>{_html_escape(value_text)}</div>"
            "</div>"
        )
    return "".join(out)


def _bar_chart(
    title: str,
    rows: Sequence[Tuple[str, float, str]],
    *,
    value_suffix: str = "",
) -> str:
    if not rows:
        return ""
    return (
        "<figure class='chart'>"
        f"<figcaption>{_html_escape(title)}</figcaption>"
        f"{_chart_rows(rows, value_suffix=value_suffix)}"
        "</figure>"
    )


def render_html(
    results: Sequence[BenchmarkResult],
    *,
    title: str = "NMR Predict — Accuracy Benchmark",
    exclude_exchangeable: bool = False,
) -> str:
    """Render the same report as :func:`render_markdown` to a standalone HTML page."""
    summaries = summarize_results(results)
    overall = [s for s in summaries if s.scenario is None]
    per_scenario = [s for s in summaries if s.scenario is not None]
    size_summaries = summarize_size_results(results)
    esc = _html_escape

    parts: List[str] = []
    parts.append("<!doctype html><html lang='en'><head><meta charset='utf-8'>")
    parts.append(f"<title>{esc(title)}</title><style>{_HTML_STYLE}</style></head><body>")
    parts.append(f"<h1>{esc(title)}</h1>")
    parts.append(
        f"<p class='meta'>Generated {esc(_dt.datetime.now().isoformat(timespec='seconds'))}</p>"
    )
    if exclude_exchangeable:
        parts.append(
            "<div class='note'>Exchangeable (OH/NH/COOH) protons excluded from metrics.</div>"
        )

    # Figures.
    if overall:
        parts.append("<h2>Figures</h2>")
        parts.append(_bar_chart(
            "Overall MAE by model and nucleus",
            [
                (f"{s.label} | {s.nucleus}", s.summary.mae, f"n={s.summary.n}")
                for s in sorted(overall, key=lambda x: (x.nucleus, x.summary.mae))
            ],
        ))
        parts.append(_bar_chart(
            "Overall seconds per heavy atom",
            [
                (
                    f"{s.label} | {s.nucleus}",
                    s.seconds_per_heavy_atom,
                    f"total {s.seconds:.1f}s",
                )
                for s in sorted(overall, key=lambda x: (x.nucleus, x.label))
            ],
            value_suffix="s",
        ))
        for nucleus in sorted({s.nucleus for s in size_summaries}):
            by_size = [
                s for s in size_summaries
                if s.nucleus == nucleus and not math.isnan(s.summary.mae)
            ]
            by_size = sorted(by_size, key=lambda x: (_size_sort_key(x.bucket), x.label))
            parts.append(_bar_chart(
                f"MAE by molecule size ({nucleus})",
                [
                    (f"{s.bucket} | {s.label}", s.summary.mae, f"n={s.summary.n}")
                    for s in by_size
                ],
            ))
            parts.append(_bar_chart(
                f"Seconds per heavy atom by molecule size ({nucleus})",
                [
                    (
                        f"{s.bucket} | {s.label}",
                        s.seconds_per_heavy_atom,
                        f"{s.run_count} run(s)",
                    )
                    for s in by_size
                ],
                value_suffix="s",
            ))

    # Run coverage.
    cov: Dict[Tuple[str, str], Dict[str, int]] = {}
    for r in results:
        for run in r.runs:
            d = cov.setdefault((r.label, run.nucleus), {"ok": 0, "skipped": 0, "error": 0})
            d[run.status] = d.get(run.status, 0) + 1
    parts.append("<h2>Run coverage</h2>")
    parts.append(_html_table(
        ["Label", "Nucleus", "ok", "skipped", "error"],
        [[esc(label), esc(nucleus), d["ok"], d["skipped"], d["error"]]
         for (label, nucleus), d in sorted(cov.items())],
        left_cols=[0, 1],
    ))

    # Overall accuracy.
    parts.append("<h2>Overall accuracy</h2>")
    parts.append(_html_table(
        ["Label", "Nucleus", "n", "MAE", "RMSE", "Max err", "Bias", "R²",
         "Scaled MAE", "Total s", "s/heavy atom"],
        [[esc(s.label), esc(s.nucleus), s.summary.n, _fmt(s.summary.mae),
          _fmt(s.summary.rmse), _fmt(s.summary.max_abs_err), _fmt(s.summary.bias),
          _fmt(s.summary.r2), _fmt(s.scaled_mae), _fmt(s.seconds),
          _fmt(s.seconds_per_heavy_atom)]
         for s in overall],
        left_cols=[0, 1],
    ))
    parts.append(
        "<div class='note'>Scaled MAE = MAE after a least-squares linear correction "
        "(removes systematic bias; rewards levels that are linear-but-offset).</div>"
    )

    # Per-scenario.
    parts.append("<h2>Per-scenario accuracy</h2>")
    parts.append(_html_table(
        ["Label", "Nucleus", "Scenario", "n", "MAE", "RMSE", "Max err", "Bias"],
        [[esc(s.label), esc(s.nucleus), esc(s.scenario), s.summary.n,
          _fmt(s.summary.mae), _fmt(s.summary.rmse), _fmt(s.summary.max_abs_err),
          _fmt(s.summary.bias)]
         for s in per_scenario],
        left_cols=[0, 1, 2],
    ))

    # Per-size.
    if size_summaries:
        parts.append("<h2>Per-size accuracy and speed</h2>")
        parts.append(_html_table(
            ["Label", "Nucleus", "Size bucket", "n", "MAE", "RMSE",
             "Total s", "s/heavy atom"],
            [[esc(s.label), esc(s.nucleus), esc(s.bucket), s.summary.n,
              _fmt(s.summary.mae), _fmt(s.summary.rmse), _fmt(s.seconds),
              _fmt(s.seconds_per_heavy_atom)]
             for s in size_summaries],
            left_cols=[0, 1, 2],
        ))

    # Worst offenders.
    offenders = worst_offenders(results)
    if offenders:
        label_lookup = _point_label_lookup(results)
        parts.append("<h2>Worst offenders (largest absolute errors)</h2>")
        parts.append(_html_table(
            ["Label", "Nucleus", "Molecule", "Group", "Ref ppm", "Pred ppm", "Abs err"],
            [[esc(label_lookup.get(id(p), p.engine)), esc(p.nucleus),
              esc(p.molecule_id), f"<code>{esc(p.group_smarts)}</code>",
              _fmt(p.reference_ppm), _fmt(p.predicted_ppm), _fmt(p.abs_error)]
             for p in offenders],
            left_cols=[0, 1, 2, 3],
        ))

    parts.append("</body></html>")
    return "".join(parts)


def _point_label_lookup(results: Sequence[BenchmarkResult]) -> Dict[int, str]:
    lookup: Dict[int, str] = {}
    for r in results:
        for p in r.points:
            lookup[id(p)] = r.label
    return lookup


def write_csv(results: Sequence[BenchmarkResult], path: str) -> None:
    """Write raw per-group data points (one row per scored group)."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(
            [
                "label", "engine", "functional", "basis", "nucleus", "molecule",
                "scenario", "group_smarts", "n_atoms", "molecule_heavy_atoms",
                "molecule_total_atoms", "size_bucket", "run_seconds",
                "run_seconds_per_heavy_atom", "reference_ppm", "predicted_ppm",
                "error", "abs_error", "exchangeable",
            ]
        )
        for r in results:
            for p in r.points:
                seconds_per_atom = _safe_div(p.run_seconds, p.molecule_heavy_atoms)
                writer.writerow(
                    [
                        r.label, r.engine, r.functional or "", r.basis or "",
                        p.nucleus, p.molecule_id, p.scenario, p.group_smarts,
                        p.n_atoms, p.molecule_heavy_atoms, p.molecule_total_atoms,
                        size_bucket(p.molecule_heavy_atoms), f"{p.run_seconds:.4f}",
                        _fmt(seconds_per_atom), f"{p.reference_ppm:.4f}",
                        f"{p.predicted_ppm:.4f}",
                        f"{p.error:.4f}", f"{p.abs_error:.4f}", int(p.exchangeable),
                    ]
                )


def _parse_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _parse_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def read_csv_results(paths: Sequence[str]) -> List[BenchmarkResult]:
    """Reconstruct benchmark results from raw CSV report rows.

    CSV reports intentionally store scored datapoints, not every skipped/error
    molecule run. Reconstructed ``runs`` therefore represent successful
    molecule/nucleus runs only, which is sufficient for merged accuracy and
    speed comparisons without rerunning old expensive levels.
    """
    results_by_label: Dict[str, BenchmarkResult] = {}
    runs_seen: set[Tuple[str, str, str]] = set()
    points_seen: set[Tuple[object, ...]] = set()

    for path in paths:
        with open(path, newline="", encoding="utf-8") as fh:
            reader = csv.DictReader(fh)
            for row in reader:
                label = row.get("label") or row.get("engine") or "unknown"
                engine = row.get("engine") or label.split(" ", 1)[0]
                functional = row.get("functional") or None
                basis = row.get("basis") or None
                result = results_by_label.get(label)
                if result is None:
                    result = BenchmarkResult(
                        engine=engine,
                        functional=functional,
                        basis=basis,
                    )
                    results_by_label[label] = result

                nucleus = row.get("nucleus") or ""
                molecule = row.get("molecule") or ""
                scenario = row.get("scenario") or ""
                group_smarts = row.get("group_smarts") or ""
                reference_ppm = _parse_float(row.get("reference_ppm"))
                predicted_ppm = _parse_float(row.get("predicted_ppm"))
                n_atoms = _parse_int(row.get("n_atoms"))
                heavy_atoms = _parse_int(row.get("molecule_heavy_atoms"))
                total_atoms = _parse_int(row.get("molecule_total_atoms"))
                run_seconds = _parse_float(row.get("run_seconds"))
                exchangeable = bool(_parse_int(row.get("exchangeable")))

                point_key = (
                    label,
                    nucleus,
                    molecule,
                    scenario,
                    group_smarts,
                    reference_ppm,
                    predicted_ppm,
                    n_atoms,
                )
                if point_key not in points_seen:
                    points_seen.add(point_key)
                    result.points.append(
                        DataPoint(
                            engine=engine,
                            nucleus=nucleus,
                            molecule_id=molecule,
                            scenario=scenario,
                            group_smarts=group_smarts,
                            reference_ppm=reference_ppm,
                            predicted_ppm=predicted_ppm,
                            n_atoms=n_atoms,
                            molecule_heavy_atoms=heavy_atoms,
                            molecule_total_atoms=total_atoms,
                            run_seconds=run_seconds,
                            exchangeable=exchangeable,
                        )
                    )

                run_key = (label, nucleus, molecule)
                if run_key not in runs_seen:
                    runs_seen.add(run_key)
                    result.runs.append(
                        MoleculeRun(
                            molecule,
                            nucleus,
                            "ok",
                            run_seconds,
                            heavy_atoms=heavy_atoms,
                            total_atoms=total_atoms,
                        )
                    )

    return list(results_by_label.values())


def report_paths(
    *,
    basename: str,
    reports_dir: str = _REPORTS_DIR,
) -> Tuple[str, str, str]:
    return (
        os.path.join(reports_dir, f"{basename}.md"),
        os.path.join(reports_dir, f"{basename}.csv"),
        os.path.join(reports_dir, f"{basename}.html"),
    )


def write_reports(
    results: Sequence[BenchmarkResult],
    *,
    basename: str,
    reports_dir: str = _REPORTS_DIR,
    title: str = "NMR Predict — Accuracy Benchmark",
    exclude_exchangeable: bool = False,
) -> Tuple[str, str, str]:
    """Write ``<basename>.md``, ``<basename>.csv`` and ``<basename>.html``.

    Returns (markdown_path, csv_path, html_path).
    """
    os.makedirs(reports_dir, exist_ok=True)
    md_path, csv_path, html_path = report_paths(
        basename=basename,
        reports_dir=reports_dir,
    )
    md = render_markdown(
        results, title=title, exclude_exchangeable=exclude_exchangeable
    )
    with open(md_path, "w", encoding="utf-8") as fh:
        fh.write(md)
    html = render_html(
        results, title=title, exclude_exchangeable=exclude_exchangeable
    )
    with open(html_path, "w", encoding="utf-8") as fh:
        fh.write(html)
    write_csv(results, csv_path)
    return md_path, csv_path, html_path
