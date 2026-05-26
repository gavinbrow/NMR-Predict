"""Command-line entry point for the NMR Predict benchmark suite.

Run from the ``backend/`` directory:

    # Compare all available engines on every scenario, both nuclei.
    # "orca" expands to the full ORCA functional/basis ladder.
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
import os
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
        choices=["run", "orca-sweep", "ladder", "validate", "merge-csv"],
        help="run (default) | orca-sweep | ladder | validate | merge-csv",
    )
    p.add_argument("--engines", nargs="+", default=_ALL_ENGINES, choices=_ALL_ENGINES)
    p.add_argument("--nucleus", nargs="+", default=_ALL_NUCLEI, choices=_ALL_NUCLEI)
    p.add_argument("--scenario", nargs="*", default=None, choices=list(SCENARIOS))
    p.add_argument("--ids", nargs="*", default=None, help="restrict to molecule ids")
    p.add_argument("--conformer-strategy", default="fast", choices=["fast"])
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
        help="ORCA level numbers from the ladder for run/orca-sweep (default: all)",
    )
    p.add_argument("--no-warm-tms", action="store_true", help="orca-sweep: skip TMS warm")
    p.add_argument("--dataset", default=DEFAULT_DATASET_PATH)
    p.add_argument(
        "--merge-csvs",
        nargs="+",
        default=None,
        help="CSV reports to combine when command is merge-csv",
    )
    p.add_argument("--validate-dataset", action="store_true")
    p.add_argument("--basename", default=None, help="report file basename (no extension)")
    p.add_argument(
        "--append-existing",
        action="store_true",
        help=(
            "load an existing basename CSV first and keep writing combined "
            "results back to the same CSV/MD/HTML files"
        ),
    )
    p.add_argument("--quiet", action="store_true")
    return p


def _default_basename(prefix: str) -> str:
    return f"{prefix}_{_dt.datetime.now().strftime('%Y%m%d_%H%M%S')}"


def _checkpoint_csv(results, basename: str, quiet: bool) -> None:
    """Write the growing raw CSV so long ORCA sweeps are resumable-inspectable."""
    _md_path, csv_path, _html_path = report.report_paths(basename=basename)
    report.write_csv(results, csv_path)
    if not quiet:
        print(f"[checkpoint] wrote partial CSV: {csv_path}", file=sys.stderr, flush=True)


def _checkpoint_reports(
    results,
    basename: str,
    quiet: bool,
    *,
    title: str = "NMR Predict â€” Accuracy Benchmark",
    exclude_exchangeable: bool = False,
) -> None:
    """Write the growing CSV/Markdown/HTML set for append-in-place sweeps."""
    md_path, csv_path, html_path = report.write_reports(
        results,
        basename=basename,
        title=title,
        exclude_exchangeable=exclude_exchangeable,
    )
    if not quiet:
        print(
            f"[checkpoint] updated reports: {md_path}, {csv_path}, {html_path}",
            file=sys.stderr,
            flush=True,
        )


def _existing_results(basename: str, quiet: bool):
    _md_path, csv_path, _html_path = report.report_paths(basename=basename)
    if not os.path.exists(csv_path):
        return []
    results = report.read_csv_results([csv_path])
    if not quiet:
        print(
            f"Loaded {len(results)} existing result group(s) from {csv_path}",
            flush=True,
        )
    return results


def _orca_label(functional: str, basis: str) -> str:
    return f"orca [{functional}/{basis}]"


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
    from benchmarks.orca_sweep import levels_for, run_sweep

    dataset = load_dataset(args.dataset).filter(scenarios=args.scenario, ids=args.ids)
    if not len(dataset):
        print("No molecules match the given filters.", file=sys.stderr)
        return 1
    basename = args.basename or _default_basename("benchmark")
    if not args.quiet:
        print(
            f"Running engines {args.engines} on {len(dataset)} molecules, "
            f"nuclei {args.nucleus} ...",
            flush=True,
        )

    results = _existing_results(basename, args.quiet) if args.append_existing else []
    existing_labels = {result.label for result in results}
    for engine_name in args.engines:
        if args.append_existing and engine_name != "orca" and engine_name in existing_labels:
            if not args.quiet:
                print(f"Skipping existing result group: {engine_name}", flush=True)
            continue
        if engine_name == "orca":
            levels = levels_for(args.levels)
            if args.append_existing:
                levels = [
                    level for level in levels
                    if _orca_label(level.functional, level.basis) not in existing_labels
                ]
            if not args.quiet:
                ladder = ", ".join(
                    f"{level.n}:{level.functional}/{level.basis}"
                    for level in levels
                )
                print(f"Expanding ORCA to ladder levels [{ladder}]", flush=True)

            def _on_orca_level_done(result) -> None:
                results.append(result)
                if args.append_existing:
                    _checkpoint_reports(
                        results,
                        basename,
                        args.quiet,
                        exclude_exchangeable=args.exclude_exchangeable,
                    )
                else:
                    _checkpoint_csv(results, basename, args.quiet)

            if levels:
                run_sweep(
                    dataset,
                    args.nucleus,
                    levels,
                    conformer_strategy=args.conformer_strategy,
                    skip_unready=not args.strict,
                    warm_tms=not args.no_warm_tms,
                    exclude_exchangeable=args.exclude_exchangeable,
                    progress=not args.quiet,
                    on_level_done=_on_orca_level_done,
                )
        else:
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
            if args.append_existing:
                _checkpoint_reports(
                    results,
                    basename,
                    args.quiet,
                    exclude_exchangeable=args.exclude_exchangeable,
                )
            else:
                _checkpoint_csv(results, basename, args.quiet)

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

    basename = args.basename or _default_basename("orca_sweep")
    title = (
        "NMR Predict â€” Accuracy Benchmark"
        if args.append_existing
        else "NMR Predict â€” ORCA level-of-theory sweep"
    )
    results = _existing_results(basename, args.quiet) if args.append_existing else []
    existing_labels = {result.label for result in results}
    if args.append_existing:
        levels = [
            level for level in levels
            if _orca_label(level.functional, level.basis) not in existing_labels
        ]

    def _on_level_done(result) -> None:
        results.append(result)
        if args.append_existing:
            _checkpoint_reports(
                results,
                basename,
                args.quiet,
                title=title,
                exclude_exchangeable=args.exclude_exchangeable,
            )
        else:
            _checkpoint_csv(results, basename, args.quiet)

    run_results = []
    if levels:
        run_results = run_sweep(
            dataset,
            args.nucleus,
            levels,
            conformer_strategy=args.conformer_strategy,
            skip_unready=not args.strict,
            warm_tms=not args.no_warm_tms,
            exclude_exchangeable=args.exclude_exchangeable,
            progress=not args.quiet,
            on_level_done=_on_level_done,
        )
    if not results:
        results = run_results

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


def _cmd_merge_csv(args) -> int:
    if not args.merge_csvs:
        print("merge-csv requires --merge-csvs <csv> [<csv> ...]", file=sys.stderr)
        return 1
    basename = args.basename or _default_basename("benchmark_merged")
    results = report.read_csv_results(args.merge_csvs)
    md_path, csv_path, html_path = report.write_reports(
        results,
        basename=basename,
        title="NMR Predict — merged benchmark comparison",
        exclude_exchangeable=args.exclude_exchangeable,
    )
    print(report.render_markdown(
        results,
        title="NMR Predict — merged benchmark comparison",
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
    if args.command == "merge-csv":
        return _cmd_merge_csv(args)
    return _cmd_run(args)


if __name__ == "__main__":
    raise SystemExit(main())
