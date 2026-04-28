#!/usr/bin/env python3
"""Audit one-to-one mapping between component files and unit test files."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


DEFAULT_COMPONENT_EXTS = (".tsx", ".jsx", ".vue", ".svelte")
DEFAULT_TEST_EXTS = (".tsx", ".jsx", ".ts", ".js")
DEFAULT_EXCLUDE_DIRS = (
    ".git",
    ".next",
    ".nuxt",
    "coverage",
    "dist",
    "build",
    "node_modules",
    "out",
)
SKIP_NAME_TOKENS = (".test.", ".spec.", ".stories.", ".story.", ".d.")


@dataclass(frozen=True)
class MappingResult:
    component: Path
    matched_tests: list[Path]
    expected_candidates: list[Path]


def parse_csv(value: str) -> tuple[str, ...]:
    return tuple(item.strip() for item in value.split(",") if item.strip())


def normalize_rel(path: Path) -> str:
    return path.as_posix().lower()


def should_skip_component_file(path: Path) -> bool:
    lower_name = path.name.lower()
    if any(token in lower_name for token in SKIP_NAME_TOKENS):
        return True
    if "__tests__" in (part.lower() for part in path.parts):
        return True
    return False


def is_component_file(path: Path, component_exts: tuple[str, ...]) -> bool:
    if path.suffix.lower() not in component_exts:
        return False
    return not should_skip_component_file(path)


def is_test_file(path: Path, test_exts: tuple[str, ...]) -> bool:
    suffix = path.suffix.lower()
    if suffix not in test_exts:
        return False
    name = path.name.lower()
    return ".test." in name or ".spec." in name


def iter_files(root: Path, exclude_dirs: tuple[str, ...]) -> Iterable[Path]:
    exclude = {d.lower() for d in exclude_dirs}
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        if any(part.lower() in exclude for part in p.parts):
            continue
        yield p


def preferred_test_ext(component_ext: str) -> str:
    mapping = {
        ".tsx": ".tsx",
        ".jsx": ".jsx",
        ".vue": ".ts",
        ".svelte": ".ts",
        ".ts": ".ts",
        ".js": ".js",
    }
    return mapping.get(component_ext.lower(), ".ts")


def candidate_paths(
    component_rel: Path, test_exts: tuple[str, ...]
) -> tuple[list[Path], Path]:
    base = component_rel.with_suffix("")
    name = component_rel.stem
    parent = component_rel.parent
    test_root_base = Path("tests") / base
    in_tests_dir_base = Path("tests") / parent / name
    candidates: list[Path] = []
    for ext in test_exts:
        candidates.append(Path(f"{base}.test{ext}"))
        candidates.append(Path(f"{base}.spec{ext}"))
        candidates.append(parent / "__tests__" / f"{name}.test{ext}")
        candidates.append(parent / "__tests__" / f"{name}.spec{ext}")
        candidates.append(Path(f"{test_root_base}.test{ext}"))
        candidates.append(Path(f"{test_root_base}.spec{ext}"))
        candidates.append(Path(f"{in_tests_dir_base}.test{ext}"))
        candidates.append(Path(f"{in_tests_dir_base}.spec{ext}"))

    scaffold_ext = preferred_test_ext(component_rel.suffix)
    scaffold_path = Path(f"{base}.test{scaffold_ext}")
    return dedupe_paths(candidates), scaffold_path


def dedupe_paths(paths: Iterable[Path]) -> list[Path]:
    seen: set[str] = set()
    ordered: list[Path] = []
    for p in paths:
        key = normalize_rel(p)
        if key in seen:
            continue
        seen.add(key)
        ordered.append(p)
    return ordered


def render_scaffold(component_rel: Path) -> str:
    component_name = component_rel.stem
    return f"""/**
 * Generated scaffold for {component_rel.as_posix()}.
 * Replace placeholders with real behavior assertions.
 */
import {{ describe, it, expect }} from "vitest";

describe("{component_name}", () => {{
  it("TODO: render and assert critical behavior", () => {{
    expect(true).toBe(true);
  }});
}});
"""


def audit_mappings(
    root: Path,
    component_exts: tuple[str, ...],
    test_exts: tuple[str, ...],
    exclude_dirs: tuple[str, ...],
) -> tuple[list[MappingResult], list[Path], list[Path]]:
    components_rel: list[Path] = []
    tests_rel: list[Path] = []
    for file_path in iter_files(root, exclude_dirs):
        rel = file_path.relative_to(root)
        if is_component_file(rel, component_exts):
            components_rel.append(rel)
        if is_test_file(rel, test_exts):
            tests_rel.append(rel)

    tests_key_to_rel = {normalize_rel(p): p for p in tests_rel}
    mapped_test_keys: set[str] = set()
    results: list[MappingResult] = []

    for component in sorted(components_rel):
        candidates, _ = candidate_paths(component, test_exts)
        matched = [tests_key_to_rel[normalize_rel(c)] for c in candidates if normalize_rel(c) in tests_key_to_rel]
        for match in matched:
            mapped_test_keys.add(normalize_rel(match))
        results.append(
            MappingResult(
                component=component,
                matched_tests=matched,
                expected_candidates=candidates,
            )
        )

    missing = [r.component for r in results if not r.matched_tests]
    orphan_tests = sorted(
        [test for test in tests_rel if normalize_rel(test) not in mapped_test_keys]
    )
    return results, missing, orphan_tests


def maybe_scaffold_missing(
    root: Path,
    missing_components: list[Path],
    test_exts: tuple[str, ...],
    force: bool,
) -> list[Path]:
    created: list[Path] = []
    for component in missing_components:
        _, scaffold = candidate_paths(component, test_exts)
        dst = root / scaffold
        if dst.exists() and not force:
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(render_scaffold(component), encoding="utf-8")
        created.append(scaffold)
    return created


def print_summary(
    results: list[MappingResult],
    missing: list[Path],
    duplicates: list[MappingResult],
    orphan_tests: list[Path],
    created: list[Path],
) -> None:
    print(f"components_total: {len(results)}")
    print(f"mapped_exactly_one: {sum(1 for r in results if len(r.matched_tests) == 1)}")
    print(f"missing: {len(missing)}")
    print(f"duplicates: {len(duplicates)}")
    print(f"orphan_tests: {len(orphan_tests)}")
    if created:
        print(f"scaffold_created: {len(created)}")
    if missing:
        print("\nMissing test files:")
        for item in missing:
            print(f"  - {item.as_posix()}")
    if duplicates:
        print("\nDuplicate test mappings:")
        for item in duplicates:
            tests = ", ".join(t.as_posix() for t in item.matched_tests)
            print(f"  - {item.component.as_posix()} -> {tests}")
    if orphan_tests:
        print("\nOrphan tests:")
        for item in orphan_tests:
            print(f"  - {item.as_posix()}")
    if created:
        print("\nCreated scaffolds:")
        for item in created:
            print(f"  - {item.as_posix()}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Check one-to-one mapping between component files and test files."
    )
    parser.add_argument("--root", default=".", help="Project root to scan.")
    parser.add_argument(
        "--component-exts",
        default=",".join(DEFAULT_COMPONENT_EXTS),
        help="Comma-separated component file extensions.",
    )
    parser.add_argument(
        "--test-exts",
        default=",".join(DEFAULT_TEST_EXTS),
        help="Comma-separated test file extensions.",
    )
    parser.add_argument(
        "--exclude-dirs",
        default=",".join(DEFAULT_EXCLUDE_DIRS),
        help="Comma-separated directory names to skip.",
    )
    parser.add_argument(
        "--scaffold-missing",
        action="store_true",
        help="Create co-located test scaffolds for missing components.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite scaffold files when they already exist.",
    )
    parser.add_argument(
        "--strict-orphans",
        action="store_true",
        help="Fail when unmatched test files are detected.",
    )
    parser.add_argument(
        "--json-out",
        help="Optional path to write JSON report.",
    )
    args = parser.parse_args()

    root = Path(args.root).resolve()
    if not root.exists():
        print(f"root_not_found: {root}")
        return 2

    component_exts = tuple(ext.lower() for ext in parse_csv(args.component_exts))
    test_exts = tuple(ext.lower() for ext in parse_csv(args.test_exts))
    exclude_dirs = parse_csv(args.exclude_dirs)

    results, missing, orphan_tests = audit_mappings(
        root=root,
        component_exts=component_exts,
        test_exts=test_exts,
        exclude_dirs=exclude_dirs,
    )
    duplicates = [r for r in results if len(r.matched_tests) > 1]

    created: list[Path] = []
    if args.scaffold_missing and missing:
        created = maybe_scaffold_missing(
            root=root, missing_components=missing, test_exts=test_exts, force=args.force
        )

    print_summary(results, missing, duplicates, orphan_tests, created)

    if args.json_out:
        payload = {
            "components_total": len(results),
            "mapped_exactly_one": sum(1 for r in results if len(r.matched_tests) == 1),
            "missing": [p.as_posix() for p in missing],
            "duplicates": [
                {
                    "component": r.component.as_posix(),
                    "tests": [t.as_posix() for t in r.matched_tests],
                }
                for r in duplicates
            ],
            "orphan_tests": [p.as_posix() for p in orphan_tests],
            "scaffold_created": [p.as_posix() for p in created],
        }
        json_path = Path(args.json_out)
        json_path.parent.mkdir(parents=True, exist_ok=True)
        json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    has_hard_failure = bool(missing or duplicates)
    if args.strict_orphans:
        has_hard_failure = has_hard_failure or bool(orphan_tests)
    return 1 if has_hard_failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
