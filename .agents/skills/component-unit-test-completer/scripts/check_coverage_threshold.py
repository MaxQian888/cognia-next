#!/usr/bin/env python3
"""Enforce minimum code coverage threshold from common coverage outputs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def parse_summary_json(path: Path) -> dict[str, float]:
    data = json.loads(path.read_text(encoding="utf-8"))
    total = data.get("total", {})
    metrics: dict[str, float] = {}
    for key in ("lines", "statements", "functions", "branches"):
        node = total.get(key)
        if isinstance(node, dict) and "pct" in node:
            metrics[key] = float(node["pct"])
    return metrics


def parse_lcov(path: Path) -> dict[str, float]:
    lf = lh = brf = brh = fnf = fnh = 0
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if raw.startswith("LF:"):
            lf += int(raw.split(":", 1)[1])
        elif raw.startswith("LH:"):
            lh += int(raw.split(":", 1)[1])
        elif raw.startswith("BRF:"):
            brf += int(raw.split(":", 1)[1])
        elif raw.startswith("BRH:"):
            brh += int(raw.split(":", 1)[1])
        elif raw.startswith("FNF:"):
            fnf += int(raw.split(":", 1)[1])
        elif raw.startswith("FNH:"):
            fnh += int(raw.split(":", 1)[1])

    metrics: dict[str, float] = {}
    if lf > 0:
        pct = (lh / lf) * 100
        metrics["lines"] = pct
        metrics["statements"] = pct
    if fnf > 0:
        metrics["functions"] = (fnh / fnf) * 100
    if brf > 0:
        metrics["branches"] = (brh / brf) * 100
    return metrics


def resolve_inputs(root: Path, summary_path: str | None, lcov_path: str | None) -> tuple[Path | None, Path | None]:
    summary = root / "coverage" / "coverage-summary.json" if not summary_path else Path(summary_path)
    lcov = root / "coverage" / "lcov.info" if not lcov_path else Path(lcov_path)
    if summary.exists():
        return summary, lcov if lcov.exists() else None
    if lcov.exists():
        return None, lcov
    return None, None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Check coverage metrics against a minimum threshold."
    )
    parser.add_argument("--root", default=".", help="Project root directory.")
    parser.add_argument(
        "--threshold",
        type=float,
        default=80.0,
        help="Minimum required percentage for each metric.",
    )
    parser.add_argument(
        "--metrics",
        default="lines,statements,functions,branches",
        help="Comma-separated metrics to enforce.",
    )
    parser.add_argument(
        "--summary",
        help="Path to coverage-summary.json (optional).",
    )
    parser.add_argument(
        "--lcov",
        help="Path to lcov.info (optional).",
    )
    args = parser.parse_args()

    root = Path(args.root).resolve()
    if not root.exists():
        print(f"root_not_found: {root}")
        return 2

    summary_file, lcov_file = resolve_inputs(root, args.summary, args.lcov)
    if summary_file is None and lcov_file is None:
        print("coverage_not_found: expected coverage/coverage-summary.json or coverage/lcov.info")
        return 2

    metrics: dict[str, float] = {}
    source = ""
    if summary_file is not None:
        metrics = parse_summary_json(summary_file)
        source = summary_file.as_posix()
    elif lcov_file is not None:
        metrics = parse_lcov(lcov_file)
        source = lcov_file.as_posix()

    required = [m.strip() for m in args.metrics.split(",") if m.strip()]
    missing_required = [m for m in required if m not in metrics]
    failed = {m: metrics[m] for m in required if m in metrics and metrics[m] < args.threshold}

    print(f"coverage_source: {source}")
    print(f"threshold: {args.threshold:.2f}")
    for metric in required:
        if metric in metrics:
            print(f"{metric}: {metrics[metric]:.2f}%")
        else:
            print(f"{metric}: unavailable")

    if missing_required:
        print(f"missing_metrics: {', '.join(missing_required)}")
    if failed:
        formatted = ", ".join(f"{k}={v:.2f}%" for k, v in failed.items())
        print(f"below_threshold: {formatted}")

    if missing_required or failed:
        return 1
    print("coverage_gate: pass")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
