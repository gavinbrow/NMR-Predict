"""Command-line entry point for the NMR Predict benchmark suite.

Run from the ``backend/`` directory:

    # Compare all available engines on every scenario, both nuclei
    python -m benchmarks.cli --engines cdk cascade orca --nucleus 13C 1H

    # One engine, one scenario, skip engines that aren't ready
    python -m benchmarks.cli --engines cascade --scenario aromatic --nucleus 1H

    # Validate the dataset (canonicalize + SMARTS resolution)
    python -m benchmarks.cli --validate-dataset

    # Print the static ORCA level-of-theory ladder (pros/cons table)
    python -m benchmarks.cli ladder

    # ORCA functional/basis sweep over the cheap end of the ladder
    python -m benchmarks.cli orca-sweep --levels 1 2 3 --scenario aliphatic
"""
from __future__ import annotations

import argparse
import datetime as _dt
import sys
from typing import List, Optional

from benchmarks import report
from benchmarks.dataset import (
    SCENARIOS,
    DEFAULT_DATASET_PATH,
    load_dataset,
    validate_dataset,
)
from benchmarks.runner import run_engine

_ALL_ENGINES = ["cdk", "cascade", "orca"]
_ALL_NUCLEI = ["13C", "1H"]


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="benchmarks.cli",
        description="NMR Predict accuracy benchmark + ORCA level-of-theory sweep.",
    )
    p.add_argument(
        "command",
        nargs="?",
        default="run",
        choices=["run", "orca-sweep", "ladder", "validate"],
        help="run (default) | orca-sweep | ladder | validate",
    )
    p.add_argument("--engines", nargs="+", default=_ALL_ENGINES, choices=_ALL_ENGINES)
    p.add_argument("--nucleus", nargs="+", default=_ALL_NUCLEI, choices=_ALL_NUCLEI)
    p.add_argument("--scenario", nargs="*", default=None, choices=list(SCENARIOS))
    p.add_argument("--ids", nargs="*", default=None, help="restrict to molecule ids")
    p.add_argument("--conformer-strategy", default="fast", choices=["fast", "goat"])
    p.add_argument(
        "--strict",
        action="store_true",
        help="error if an engine is not ready (default: skip unready engines)",
    )
    p.add_argument("--exclude-exchangeable", action="store_true")
    p.add_argument(
        "--levels",
        nargs="+",
        type=int,
        default=None,
        help="orca-sweep: level numbers from the ladder (default: all)",
    )
    p.add_argument("--no-warm-tms", action="store_true", help="orca-sweep: skip TMS warm")
    p.add_argument("--dataset", default=DEFAULT_DATASET_PATH)
    p.add_argument("--validate-dataset", action="store_true")
    p.add_argument("--basename", default=None, help="report file basename (no extension)")
    p.add_argument("--quiet", action="store_true")
    return p


def _default_basename(prefix: str) -> str:
    return f"{prefix}_{_dt.datetime.now().strftime('%Y%m%d_%H%M%S')}"


def _cmd_validate(args) -> int:
    dataset = load_dataset(args.dataset)
    issues = validate_dataset(dataset)
    print(f"Dataset: {len(dataset)} molecules from {args.dataset}")
    if not issues:
        print("OK — every molecule canonicalizes and every group_smarts resolves.")
        return 0
    print(f"{len(issues)} issue(s):")
    for i in issues:
        nuc = f" [{i.nucleus}]" if i.nucleus else ""
        print(f"  - {i.molecule_id}{nuc}: {i.message}")
    return 1


def _cmd_ladder(args) -> int:
    from benchmarks.orca_sweep import render_ladder_markdown

    md = render_ladder_markdown()
    print(md)
    if args.basename:
        path = f"{args.basename}.md"
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(md)
        print(f"\nWrote {path}", file=sys.stderr)
    return 0


def _cmd_run(args) -> int:
    dataset = load_dataset(args.dataset).filter(scenarios=args.scenario, ids=args.ids)
    if not len(dataset):
        print("No molecules match the given filters.", file=sys.stderr)
        return 1
    if not args.quiet:
        print(
            f"Running engines {args.engines} on {len(dataset)} molecules, "
            f"nuclei {args.nucleus} ...",
            flush=True,
        )

    results = []
    for engine_name in args.engines:
        result = run_engine(
            engine_name,
            dataset,
            args.nucleus,
            conformer_strategy=args.conformer_strategy,
            skip_unready=not args.strict,
            exclude_exchangeable=args.exclude_exchangeable,
            progress=not args.quiet,
        )
        results.append(result)

    basename = args.basename or _default_basename("benchmark")
    md_path, csv_path, html_path = report.write_reports(
        results,
        basename=basename,
        exclude_exchangeable=args.exclude_exchangeable,
    )
    print(report.render_markdown(results, exclude_exchangeable=args.exclude_exchangeable))
    print(f"\nWrote:\n  {md_path}\n  {csv_path}\n  {html_path}", file=sys.stderr)
    return 0


def _cmd_orca_sweep(args) -> int:
    from benchmarks.orca_sweep import levels_for, run_sweep

    dataset = load_dataset(args.dataset).filter(scenarios=args.scenario, ids=args.ids)
    if not len(dataset):
        print("No molecules match the given filters.", file=sys.stderr)
        return 1
    levels = levels_for(args.levels)
    if not args.quiet:
        ladder = ", ".join(f"{l.n}:{l.functional}/{l.basis}" for l in levels)
        print(f"ORCA sweep over levels [{ladder}] on {len(dataset)} molecules", flush=True)

    results = run_sweep(
        dataset,
        args.nucleus,
        levels,
        conformer_strategy=args.conformer_strategy,
        warm_tms=not args.no_warm_tms,
        progress=not args.quiet,
    )

    basename = args.basename or _default_basename("orca_sweep")
    md_path, csv_path, html_path = report.write_reports(
        results,
        basename=basename,
        title="NMR Predict — ORCA level-of-theory sweep",
        exclude_exchangeable=args.exclude_exchangeable,
    )
    print(report.render_markdown(
        results,
        title="NMR Predict — ORCA level-of-theory sweep",
        exclude_exchangeable=args.exclude_exchangeable,
    ))
    print(f"\nWrote:\n  {md_path}\n  {csv_path}\n  {html_path}", file=sys.stderr)
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    args = _build_parser().parse_args(argv)

    if args.validate_dataset or args.command == "validate":
        return _cmd_validate(args)
    if args.command == "ladder":
        return _cmd_ladder(args)
    if args.command == "orca-sweep":
        return _cmd_orca_sweep(args)
    return _cmd_run(args)


if __name__ == "__main__":
    raise SystemExit(main())
