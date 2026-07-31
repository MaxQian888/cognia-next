"""Parity: ``cognia.PluginHook`` must equal the host ``CANONICAL_HOOK_POINTS``.

``types.py`` documents that the ``PluginHook`` enum "mirrors the host registry
``CANONICAL_HOOK_POINTS`` in ``lib/plugin/contracts/plugin-points.ts`` exactly (a
parity test asserts this enum equals that list)." This is that test — previously
the claim was comment-only. It reads the canonical list straight from the repo
so a hook added on one side and not the other fails CI.

Skips (rather than fails) when the repo TS file is not reachable — e.g. the SDK
directory was published/copied standalone — so the packaged SDK's own test run
never depends on repo layout.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

import cognia

_POINTS_REL = Path("lib/plugin/contracts/plugin-points.ts")


def _repo_root() -> Path | None:
    for parent in Path(__file__).resolve().parents:
        if (parent / _POINTS_REL).is_file():
            return parent
    return None


def _canonical_hook_points(text: str) -> list[str]:
    start = text.index("CANONICAL_HOOK_POINTS = [")
    body = text[start:]
    body = body[: body.index("\n]")]
    # Strip comments so their prose can never contribute a false token.
    body = re.sub(r"//[^\n]*", "", body)
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
    return re.findall(r'"([^"]+)"', body)


def test_plugin_hook_enum_matches_canonical_hook_points():
    root = _repo_root()
    if root is None:
        pytest.skip("repo plugin-points.ts not reachable from the SDK directory")
    points = _canonical_hook_points((root / _POINTS_REL).read_text(encoding="utf-8"))
    assert points, "failed to parse CANONICAL_HOOK_POINTS"

    ts_set = set(points)
    py_set = {member.value for member in cognia.PluginHook}

    missing_in_python = sorted(ts_set - py_set)
    extra_in_python = sorted(py_set - ts_set)
    assert not missing_in_python, f"hooks in TS but missing from PluginHook: {missing_in_python}"
    assert not extra_in_python, f"hooks in PluginHook but not in TS: {extra_in_python}"

    # No duplicates on either side, and identical cardinality.
    assert len(points) == len(ts_set), "duplicate hook id in CANONICAL_HOOK_POINTS"
    assert len(py_set) == len(list(cognia.PluginHook))
