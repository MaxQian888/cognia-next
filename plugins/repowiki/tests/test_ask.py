"""`repowiki_ask`: the single-shot, cited answer.

The chat prompt builder shipped in the port but nothing called it — the panel
conversation had taken over the multi-turn path. These pin the tool that wires
retrieval → prompt → answer, including the two contracts that make the answer
trustworthy: citations travel with it, and a stale wiki has to say so.
"""

from __future__ import annotations

import main
import pytest
from repowiki.core.models import FileInfo, ProjectContext
from repowiki.core.wiki_builder import Wiki, WikiPage
from repowiki.host import HostBridge, WorkspaceHandle, configure_paths, set_host
from repowiki.pipeline import ScanResult


class FakeHost(HostBridge):
    def __init__(self, *, answer="the answer", changed=None, diff_raises=None):
        self._answer = answer
        self._changed = changed or []
        self._diff_raises = diff_raises
        self.prompts: list[str] = []
        self.systems: list[str] = []

    async def agent_run(self, prompt, options):
        self.prompts.append(prompt)
        self.systems.append(options.get("system") or "")
        return {
            "text": self._answer,
            "usage": {"inputTokens": 11, "outputTokens": 7},
        }

    async def workspace_changed_since(self, handle, ref):
        if self._diff_raises:
            raise self._diff_raises
        return self._changed


def _seed(tmp_path, *, head_ref="abc") -> ScanResult:
    """A scan result with real file contents, so the index can be built."""
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
        handle=WorkspaceHandle(root="/repo", origin="local-path", head_ref=head_ref),
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
    yield
    main._SCANS.clear()
    main._INDEXES.clear()
    main._FRESHNESS.clear()
    set_host(None)
    configure_paths(None)


async def test_ask_retrieves_then_answers_with_citations(tmp_path):
    host = FakeHost()
    set_host(host)
    main._SCANS["deadbeef"] = _seed(tmp_path)

    out = await main.repowiki_ask("deadbeef", "where does save live?")

    assert out["answer"] == "the answer"
    assert out["citations"], "an answer with nothing it read is not grounded"
    # Two model calls: the query expansion pass, then the answer.
    assert out["usage"] == {"inputTokens": 22, "outputTokens": 14}
    # The question reached the model, and the retrieved excerpts did too.
    assert "where does save live?" in host.prompts[-1]
    assert "save" in host.prompts[-1]
    # The grounding rules went out as the system message, not the prompt.
    assert "actual code" in host.systems[-1]


async def test_ask_still_answers_when_expansion_fails(tmp_path):
    class ExplodingExpand(FakeHost):
        async def agent_run(self, prompt, options):
            if "code search terms" in prompt:
                raise RuntimeError("expansion backend down")
            return await super().agent_run(prompt, options)

    host = ExplodingExpand()
    set_host(host)
    main._SCANS["deadbeef"] = _seed(tmp_path)

    out = await main.repowiki_ask("deadbeef", "where does save live?")
    assert out["answer"] == "the answer"


async def test_ask_on_a_stale_wiki_makes_the_model_own_the_admission(tmp_path):
    host = FakeHost(changed=["core/store.py"])
    set_host(host)
    main._SCANS["deadbeef"] = _seed(tmp_path)

    out = await main.repowiki_ask("deadbeef", "what does save do?")

    assert out["freshness"]["stale"] is True
    assert "out of date" in host.prompts[-1]


async def test_ask_on_an_uncheckable_wiki_says_uncertainty_not_current(tmp_path):
    host = FakeHost(diff_raises=RuntimeError("no git bridge"))
    set_host(host)
    main._SCANS["deadbeef"] = _seed(tmp_path)

    out = await main.repowiki_ask("deadbeef", "what does save do?")

    assert out["freshness"]["known"] is False
    assert "could not be determined" in host.prompts[-1]


async def test_ask_threads_history_into_the_prompt(tmp_path):
    host = FakeHost()
    set_host(host)
    main._SCANS["deadbeef"] = _seed(tmp_path)

    await main.repowiki_ask(
        "deadbeef",
        "and the caller?",
        history=[
            {"role": "user", "content": "what does save do?"},
            {"role": "assistant", "content": "it returns 1"},
        ],
    )

    assert "what does save do?" in host.prompts[-1]
    assert "it returns 1" in host.prompts[-1]


async def test_ask_on_an_unknown_project_fails_instead_of_answering_from_memory(tmp_path):
    with pytest.raises(ValueError, match="No wiki for"):
        await main.repowiki_ask("nope", "anything")
