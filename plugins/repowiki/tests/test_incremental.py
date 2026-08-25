"""Incremental scan: a changed-path set skips unchanged modules.

The `changed_paths_since` half of upstream's file lived here and drove four
`git` subprocesses; it moved to `test_scan_since.py` when the host took over
that call. What stays is the half that matters most — that a module whose files
are all unchanged never reaches the model.
"""
from __future__ import annotations

import pytest

from repowiki.core.analyzer import Analyzer
from repowiki.core.cache import Cache
from repowiki.core.models import FileInfo, ProjectContext


# --- analyzer behaviour ------------------------------------------------------

class _RecordingLLM:
    def __init__(self):
        self.calls = 0
        self.total_input_tokens = 0
        self.total_output_tokens = 0
        self.total_cost = 0.0

    async def complete(self, messages, **_kwargs):
        self.calls += 1
        # return a no-op JSON so analyzer's downstream parsing is happy
        return '{"name": "x", "purpose": "ok"}'


def _project(paths: list[str]) -> ProjectContext:
    files = [
        FileInfo(path=p, size=10, language="python",
                 lines=1, preview="x", content="x")
        for p in paths
    ]
    return ProjectContext(name="x", root="/tmp/x", files=files,
                          file_tree="\n".join(paths))


@pytest.mark.asyncio
async def test_unchanged_modules_skipped_in_incremental_mode(tmp_path):
    cache = Cache(db_path=tmp_path / "cache.db")
    await cache.init()

    # spread across distinct top-level dirs so they become separate modules
    project = _project([
        "frontend/main.tsx",
        "frontend/util.ts",
        "backend/api.py",
        "backend/db.py",
        "scripts/build.sh",
    ])

    llm = _RecordingLLM()
    analyzer = Analyzer(
        llm=llm, cache=cache, concurrency=1,
        # only frontend changed -> backend + scripts modules skip the LLM
        changed_paths={"frontend/main.tsx"},
    )

    await analyzer.analyze(project)
    await cache.close()

    assert "backend" in analyzer.skipped_modules
    assert "scripts" in analyzer.skipped_modules
    # frontend stays
    assert "frontend" not in analyzer.skipped_modules


@pytest.mark.asyncio
async def test_full_mode_calls_llm_for_every_module(tmp_path):
    cache = Cache(db_path=tmp_path / "cache.db")
    await cache.init()

    project = _project([
        "frontend/main.tsx",
        "backend/api.py",
    ])

    llm = _RecordingLLM()
    analyzer = Analyzer(llm=llm, cache=cache, concurrency=1, changed_paths=None)
    await analyzer.analyze(project)
    await cache.close()

    assert analyzer.skipped_modules == []
    # overview + arch + guide + 2 modules = 5 calls
    assert llm.calls >= 5
