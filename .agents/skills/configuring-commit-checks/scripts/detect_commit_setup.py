#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Inspect repository commit-check tooling and recommend a setup."
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help="Starting path used to inspect the repository.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="as_json",
        help="Emit structured JSON output.",
    )
    parser.add_argument(
        "--max-depth",
        type=int,
        default=8,
        help="Maximum parent levels to inspect while locating the repository root.",
    )
    return parser.parse_args(argv)


@dataclass(frozen=True)
class Recommendation:
    recommendation: str
    recommended_tool: str
    supporting_tools: list[str]
    reasons: list[str]
    next_steps: list[str]


def read_text_if_exists(path: Path) -> str:
    if not path.exists():
        return ""
    for encoding in ("utf-8", "utf-8-sig", "latin-1"):
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
    return path.read_text(errors="ignore")


def load_package_json(root: Path) -> dict[str, Any]:
    package_json = root / "package.json"
    if not package_json.exists():
        return {}
    try:
        payload = json.loads(read_text_if_exists(package_json))
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def find_repository_root(start: Path, max_depth: int) -> Path:
    current = start if start.is_dir() else start.parent
    current = current.resolve()
    for _ in range(max_depth + 1):
        if (current / ".git").exists():
            return current
        if current.parent == current:
            break
        current = current.parent
    return start.resolve() if start.is_dir() else start.parent.resolve()


def is_node_project(root: Path, package_json: dict[str, Any]) -> bool:
    if package_json:
        return True
    return any(
        (root / marker).exists()
        for marker in ("package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb")
    )


def is_python_project(root: Path) -> bool:
    return any(
        (root / marker).exists()
        for marker in (
            "pyproject.toml",
            "setup.py",
            "setup.cfg",
            "requirements.txt",
            "requirements-dev.txt",
            "dev-requirements.txt",
        )
    )


def classify_project(root: Path, package_json: dict[str, Any]) -> str:
    node = is_node_project(root, package_json)
    python = is_python_project(root)
    if node and python:
        return "mixed"
    if node:
        return "node"
    if python:
        return "python"
    return "unknown"


def has_package_tool(package_json: dict[str, Any], tool_name: str) -> bool:
    for section in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
        value = package_json.get(section, {})
        if isinstance(value, dict) and tool_name in value:
            return True
    return False


def detect_existing_tools(root: Path, package_json: dict[str, Any]) -> tuple[list[str], dict[str, list[str]]]:
    tools: list[str] = []
    evidence: dict[str, list[str]] = {}

    def add(tool: str, path: str) -> None:
        if tool not in tools:
            tools.append(tool)
            evidence[tool] = []
        evidence[tool].append(path)

    if (root / ".pre-commit-config.yaml").exists():
        add("pre-commit", ".pre-commit-config.yaml")
    if (root / ".husky").is_dir():
        add("husky", ".husky/")
    if (root / "lefthook.yml").exists():
        add("lefthook", "lefthook.yml")
    if (root / "lefthook.yaml").exists():
        add("lefthook", "lefthook.yaml")

    lint_staged_present = "lint-staged" in package_json or has_package_tool(package_json, "lint-staged")
    if lint_staged_present:
        add("lint-staged", "package.json")

    commitlint_files = [
        ".commitlintrc",
        ".commitlintrc.json",
        ".commitlintrc.js",
        ".commitlintrc.cjs",
        "commitlint.config.js",
        "commitlint.config.cjs",
    ]
    if any((root / item).exists() for item in commitlint_files) or has_package_tool(package_json, "@commitlint/cli"):
        add("commitlint", "package.json" if has_package_tool(package_json, "@commitlint/cli") else "commitlint config")

    return tools, evidence


def choose_existing_primary(existing_tools: list[str]) -> str:
    for tool in ("pre-commit", "husky", "lefthook"):
        if tool in existing_tools:
            return tool
    return ""


def recommend_setup(project_type: str, existing_tools: list[str]) -> Recommendation:
    primary = choose_existing_primary(existing_tools)
    if primary:
        if primary == "husky":
            return Recommendation(
                recommendation="preserve-existing",
                recommended_tool="husky",
                supporting_tools=["lint-staged"] if project_type in {"node", "mixed"} else [],
                reasons=["Repository already uses husky; preserve the current hook system."],
                next_steps=[
                    "Keep husky as the primary hook tool.",
                    "Add only the missing hook files or package-level support such as lint-staged or commitlint.",
                ],
            )
        if primary == "pre-commit":
            return Recommendation(
                recommendation="preserve-existing",
                recommended_tool="pre-commit",
                supporting_tools=[],
                reasons=["Repository already uses pre-commit; extend the existing hook file instead of migrating."],
                next_steps=[
                    "Keep .pre-commit-config.yaml as the top-level hook entry point.",
                    "Add missing repos or hooks inside the existing pre-commit configuration.",
                ],
            )
        return Recommendation(
            recommendation="preserve-existing",
            recommended_tool="lefthook",
            supporting_tools=[],
            reasons=["Repository already uses lefthook; preserve the chosen hook system."],
            next_steps=[
                "Keep lefthook as the primary hook tool.",
                "Add missing commands inside lefthook.yml instead of introducing husky or pre-commit.",
            ],
        )

    if "lint-staged" in existing_tools and project_type in {"node", "mixed"}:
        return Recommendation(
            recommendation="complete-existing",
            recommended_tool="husky",
            supporting_tools=["lint-staged"],
            reasons=["Repository already hints at a Node commit-check stack via lint-staged but lacks a primary hook runner."],
            next_steps=[
                "Add husky and wire lint-staged through a pre-commit hook.",
                "Keep the current lint-staged rules instead of replacing them.",
            ],
        )

    if project_type == "node":
        return Recommendation(
            recommendation="add-default",
            recommended_tool="husky",
            supporting_tools=["lint-staged"],
            reasons=["Node-only repository with no existing hook tool detected."],
            next_steps=[
                "Install husky and lint-staged in package.json.",
                "Create a pre-commit hook that runs lint-staged and any existing package quality scripts.",
            ],
        )

    if project_type == "python":
        return Recommendation(
            recommendation="add-default",
            recommended_tool="pre-commit",
            supporting_tools=[],
            reasons=["Python-only repository with no existing hook tool detected."],
            next_steps=[
                "Add .pre-commit-config.yaml as the single hook entry point.",
                "Configure format, lint, and test-adjacent hooks that match the existing Python toolchain.",
            ],
        )

    if project_type == "mixed":
        return Recommendation(
            recommendation="add-default",
            recommended_tool="pre-commit",
            supporting_tools=[],
            reasons=["Mixed Node and Python repository without an existing hook tool is best served by one top-level orchestrator."],
            next_steps=[
                "Use pre-commit as the top-level orchestrator.",
                "Call both Node and Python quality commands from pre-commit hooks instead of adding competing hook systems.",
            ],
        )

    return Recommendation(
        recommendation="review-manually",
        recommended_tool="manual-review",
        supporting_tools=[],
        reasons=["Project type is unclear; choose the hook stack only after inspecting the repository manually."],
        next_steps=[
            "Inspect the repository structure and existing scripts manually.",
            "Select a hook tool only after confirming the dominant language and workflow.",
        ],
    )


def build_payload(start_root: Path, detected_root: Path) -> dict[str, Any]:
    package_json = load_package_json(detected_root)
    project_type = classify_project(detected_root, package_json)
    existing_tools, evidence = detect_existing_tools(detected_root, package_json)
    recommendation = recommend_setup(project_type, existing_tools)

    payload = {
        "project_root": str(start_root),
        "detected_root": str(detected_root),
        "project_type": project_type,
        "existing_tools": existing_tools,
        "evidence": evidence,
    }
    payload.update(asdict(recommendation))
    return payload


def print_summary(payload: dict[str, Any]) -> None:
    print(f"Detected root: {payload['detected_root']}")
    print(f"Project type: {payload['project_type']}")
    print(f"Existing tools: {', '.join(payload['existing_tools']) or 'none'}")
    print(f"Recommendation: {payload['recommendation']} -> {payload['recommended_tool']}")
    for reason in payload["reasons"]:
        print(f"- {reason}")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    root = Path(args.project_root).resolve()
    detected_root = find_repository_root(root, args.max_depth)
    payload = build_payload(root, detected_root)
    if args.as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print_summary(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
