"""`repowiki_deep_research` and `repowiki_codemap` — the two-generation tools.

Both stand on the same claims as `repowiki_ask` — citations travel, a stale
wiki admits it — plus their own: research iterates instead of one-shotting,
and a codemap's citations are *verified verbatim* before the guide is
believed.
"""

from __future__ import annotations

import json

import main
import pytest
from repowiki.core.models import FileInfo, ProjectContext
from repowiki.core.wiki_builder import Wiki, WikiPage
from repowiki.host import HostBridge, WorkspaceHandle, configure_paths, set_host
from repowiki.pipeline import ScanResult

SAVE_SNIPPET = "def save():"


class FakeHost(HostBridge):
    """Per-call scripted answers: a queue when the phases differ."""

    def __init__(self, *, answers=None, changed=None):
        self._answers = list(answers or [])
        self._changed = changed or []
        self.prompts: list[str] = []

    async def agent_run(self, prompt, options):
        self.prompts.append(prompt)
        text = self._answers.pop(0) if self._answers else "an answer"
        return {"text": text, "usage": {"inputTokens": 10, "outputTokens": 5}}

    async def workspace_changed_since(self, handle, ref):
        return self._changed


def _seed() -> ScanResult:
    project = ProjectContext(
        name="demo",
        root="/repo",
        files=[
            FileInfo(
                path="core/store.py",
                size=30,
                language="python",
                lines=2,
                content="def save():\n    return 1\n",
            ),
            FileInfo(
                path="core/engine.py",
                size=40,
                language="python",
                lines=3,
                content="from .store import save\n\ndef run():\n    return save()\n",
            ),
        ],
    )
    return ScanResult(
        project_id="deadbeef",
        wiki=Wiki(
            project_name="demo",
            pages=[WikiPage(id="index", title="Overview", content="# demo")],
        ),
        handle=WorkspaceHandle(root="/repo", origin="local-path", head_ref="abc"),
        project=project,
        source="/repo",
    )


@pytest.fixture(autouse=True)
def clean_state(tmp_path, monkeypatch):
    configure_paths(tmp_path / "plugin-data")
    monkeypatch.setattr(main, "get_config", dict)
    main._SCANS.clear()
    main._INDEXES.clear()
    main._FRESHNESS.clear()
    main._PANEL_STATE.clear()
    yield
    main._SCANS.clear()
    main._INDEXES.clear()
    main._FRESHNESS.clear()
    main._PANEL_STATE.clear()
    set_host(None)
    configure_paths(None)


async def test_deep_research_iterates_then_synthesizes(tmp_path):
    host = FakeHost(answers=["## Research Plan\nstep one", "## Research Update 2", "## Final Conclusion"])
    set_host(host)
    main._SCANS["deadbeef"] = _seed()

    out = await main.repowiki_deep_research("deadbeef", "how does run reach save?")

    assert out["iterations"] == 3
    assert len(out["rounds"]) == 3
    assert out["answer"] == "## Final Conclusion"
    # Round 1 plans; later rounds are told what came before.
    assert "Research Plan" in host.prompts[0]
    assert "step one" in host.prompts[1], "round 2 did not see round 1's findings"
    assert out["citations"], "research without citations is a book report"


async def test_deep_research_clamps_the_round_count(tmp_path):
    host = FakeHost()
    set_host(host)
    main._SCANS["deadbeef"] = _seed()

    out = await main.repowiki_deep_research("deadbeef", "q", iterations=99)
    assert out["iterations"] == 5
    assert len(out["rounds"]) == 5


def _skeleton(*, verbatim: bool) -> str:
    snippet = SAVE_SNIPPET if verbatim else "def save(*args, **kwargs):  # invented"
    return json.dumps(
        {
            "title": "How save works",
            "summary": "one entry point",
            "sections": [
                {
                    "id": "1",
                    "title": "Entry",
                    "guide": "",
                    "diagram": "",
                    "steps": [
                        {
                            "id": "1a",
                            "label": "call save",
                            "code": "save()",
                            "citation": {
                                "file_path": "core/store.py",
                                "start_line": 1,
                                "end_line": 1,
                                "snippet": snippet,
                            },
                        }
                    ],
                }
            ],
        }
    )


async def test_codemap_keeps_verbatim_citations_and_becomes_a_page(tmp_path):
    enriched = json.dumps(
        {
            "title": "How save works",
            "summary": "one entry point",
            "sections": [
                {
                    "id": "1",
                    "title": "Entry",
                    "guide": "save returns 1.",
                    "diagram": "flowchart TD\n  A-->B",
                    "steps": [
                        {
                            "id": "1a",
                            "label": "call save",
                            "code": "save()",
                            "citation": {
                                "file_path": "core/store.py",
                                "start_line": 1,
                                "end_line": 1,
                                "snippet": SAVE_SNIPPET,
                            },
                        }
                    ],
                }
            ],
        }
    )
    host = FakeHost(answers=[_skeleton(verbatim=True), enriched])
    set_host(host)
    result = _seed()
    main._SCANS["deadbeef"] = result

    out = await main.repowiki_codemap("deadbeef", "how does save work?")

    assert out["droppedCitations"] == 0
    page = result.wiki.get_page(out["pageId"])
    assert page is not None
    assert "flowchart TD" in page.content
    # The citation became a clickable path#L link, not bare prose.
    assert "core/store.py#L1" in page.content
    # And the snapshot was re-saved so the page survives a restart.
    store = main.WikiStore()
    await store.init()
    try:
        rehydrated = await store.load_all()
    finally:
        await store.close()
    restored = next(r for r in rehydrated if r.project_id == "deadbeef")
    assert restored.wiki.get_page(out["pageId"]) is not None


async def test_codemap_drops_a_citation_it_cannot_verify(tmp_path):
    host = FakeHost(answers=[_skeleton(verbatim=False), _skeleton(verbatim=False)])
    set_host(host)
    result = _seed()
    main._SCANS["deadbeef"] = result

    out = await main.repowiki_codemap("deadbeef", "how does save work?")

    # One drop per verification pass: the skeleton's fake citation, then the
    # same fake citation drifting back in the enriched output.
    assert out["droppedCitations"] == 2
    step = out["codemap"]["sections"][0]["steps"][0]
    assert step["citation"] is None


async def test_codemap_refuses_a_shapeless_skeleton(tmp_path):
    host = FakeHost(answers=["not json at all"])
    set_host(host)
    main._SCANS["deadbeef"] = _seed()

    with pytest.raises(ValueError, match="skeleton"):
        await main.repowiki_codemap("deadbeef", "how does save work?")


async def test_codemap_falls_back_to_the_verified_skeleton_when_enrich_fails(tmp_path):
    host = FakeHost(answers=[_skeleton(verbatim=True), "also not json"])
    set_host(host)
    main._SCANS["deadbeef"] = _seed()

    out = await main.repowiki_codemap("deadbeef", "how does save work?")
    assert out["codemap"]["sections"][0]["steps"][0]["citation"]["snippet"] == SAVE_SNIPPET
