"""One scan, end to end, with a fake host.

Upstream had no test at this level: the same eight steps lived twice, once in
the CLI and once in the server coordinator, and each was only exercised through
its own transport. This drives the single pipeline directly, so the wiring
between acquire → ingest → graph → analyze → build is pinned without a model,
a network, or a real repository.
"""

from __future__ import annotations

import json

import pytest

from repowiki.config import Config
from repowiki.host import HostBridge, configure_paths, set_host
from repowiki.pipeline import build_index, reading_order, scan, spec_for, staleness


def _write_repo(root):
    (root / "core").mkdir()
    (root / "core" / "engine.py").write_text(
        "from .store import save\n\ndef run():\n    return save()\n"
    )
    (root / "core" / "store.py").write_text("def save():\n    return 1\n")
    (root / "README.md").write_text("# Demo\n\nA demo project.\n")
    (root / ".env").write_text("SECRET=nope\n")


class FakeHost(HostBridge):
    """A host that serves one local checkout and a canned model."""

    def __init__(
        self,
        root,
        *,
        entries=None,
        changed=None,
        truncated=False,
        skipped=0,
        head_ref="c0ffee",
        diff_raises=None,
    ):
        self.root = str(root)
        self._head_ref = head_ref
        self._diff_raises = diff_raises
        self.diff_refs: list[str] = []
        self._entries = entries
        self._changed = changed or []
        self._truncated = truncated
        self._skipped = skipped
        self.prompts: list[str] = []
        self.specs: list[dict] = []

    async def agent_run(self, prompt, options):
        self.prompts.append(prompt)
        # Every analyzer pass parses JSON out of the reply; one shape that
        # satisfies all of them keeps the fake honest without pretending to
        # be a model.
        return {
            "text": json.dumps(
                {
                    "name": "demo",
                    "purpose": "a demo project",
                    "summary": "it demos",
                    "description": "it demos",
                    "modules": [],
                    "components": [],
                    "steps": [],
                    "entry_points": [],
                }
            ),
            "usage": {"inputTokens": 3, "outputTokens": 5},
        }

    async def workspace_acquire(self, spec):
        self.specs.append(spec)
        acquired = {"root": self.root, "origin": "local-path", "ephemeral": False}
        if self._head_ref:
            acquired["headRef"] = self._head_ref
        return acquired

    async def workspace_walk(self, handle, options):
        entries = self._entries
        if entries is None:
            # Stand in for the host's gitignore-aware walk: everything except
            # the credential file it refuses outright.
            entries = ["core/engine.py", "core/store.py", "README.md"]
        return {
            "entries": entries,
            "truncated": self._truncated,
            "skippedSensitive": self._skipped,
        }

    async def workspace_changed_since(self, handle, ref):
        self.diff_refs.append(ref)
        if self._diff_raises:
            raise self._diff_raises
        if ref == "unknown-ref":
            raise RuntimeError("bad revision")
        return self._changed


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "demo"
    root.mkdir()
    _write_repo(root)
    configure_paths(tmp_path / "plugin-data")
    yield root
    set_host(None)
    configure_paths(None)


def test_spec_for_defers_the_remote_or_local_decision_to_the_host():
    # A second parser here would be a second answer to a question the
    # workspace API already answers, and they would drift.
    assert spec_for("  owner/repo ") == {"kind": "auto", "input": "owner/repo"}


async def test_a_full_scan_produces_pages_and_never_reads_the_withheld_file(repo):
    host = FakeHost(repo)
    set_host(host)
    steps: list[str] = []

    result = await scan(str(repo), config=Config(), on_progress=steps.append)

    assert result.project_id
    assert result.wiki.pages, "a scan with no pages is a failed scan"
    assert result.wiki.get_page("index") is not None
    # The host withheld `.env`; it must not appear even though it is on disk.
    assert all(f.path != ".env" for f in result.project.files)
    assert host.prompts, "the analyzer never reached the model"
    assert steps[0].startswith("Acquiring")
    assert result.usage["inputTokens"] > 0


async def test_the_summary_is_serialisable_because_it_crosses_the_wire(repo):
    set_host(FakeHost(repo))
    result = await scan(str(repo), config=Config())
    # A tool result that cannot be JSON-encoded reaches the caller as an error
    # after the expensive part has already run.
    json.dumps(result.to_summary())
    assert result.to_summary()["pageCount"] == len(result.wiki.pages)


async def test_a_truncated_or_censored_walk_is_carried_into_the_summary(repo):
    set_host(FakeHost(repo, truncated=True, skipped=1))
    result = await scan(str(repo), config=Config(max_files=2))
    assert result.to_summary()["truncated"] is True
    assert result.to_summary()["skippedSensitive"] == 1
    assert any("first 2 files" in w for w in result.warnings)


async def test_an_unresolvable_since_ref_falls_back_to_a_full_pass_and_says_so(repo):
    # The dangerous reading of an empty changed-set is "nothing changed", which
    # would ship a wiki that silently never updates.
    set_host(FakeHost(repo))
    result = await scan(str(repo), config=Config(), since="unknown-ref")
    assert any("unknown-ref" in w for w in result.warnings)
    assert result.skipped_modules == []


async def test_a_resolvable_since_ref_skips_the_untouched_modules(repo):
    set_host(FakeHost(repo, changed=["README.md"]))
    result = await scan(str(repo), config=Config(), since="HEAD~1")
    assert "core" in result.skipped_modules


async def test_reading_order_puts_the_most_depended_upon_file_first(repo):
    set_host(FakeHost(repo))
    result = await scan(str(repo), config=Config())
    entries = reading_order(result, top=5)
    assert entries[0]["path"] == "core/store.py"
    assert entries[0]["rank"] == 1


async def test_the_index_persists_and_is_reused_across_calls(repo):
    set_host(FakeHost(repo))
    result = await scan(str(repo), config=Config())

    first = await build_index(result, config=Config())
    assert first.chunks, "an empty index answers every question with nothing"

    # Second call reloads from disk rather than re-chunking; the proof is that
    # it comes back populated with no fresh `index()` pass.
    second = await build_index(result, config=Config())
    assert len(second.chunks) == len(first.chunks)

    hits = second.retrieve("save", top_k=3)
    assert any(chunk.file_path.endswith("store.py") for chunk in hits)


async def test_the_index_can_include_the_generated_prose(repo):
    set_host(FakeHost(repo))
    result = await scan(str(repo), config=Config())
    rag = await build_index(result, config=Config(rag_index_wiki=True), reuse=False)
    assert any(chunk.kind == "wiki" for chunk in rag.chunks)


async def test_index_reuse_can_be_refused(repo):
    set_host(FakeHost(repo))
    result = await scan(str(repo), config=Config())
    await build_index(result, config=Config())
    rebuilt = await build_index(result, config=Config(), reuse=False)
    assert rebuilt.chunks


# ---------------------------------------------------------------------------
# Staleness
# ---------------------------------------------------------------------------
#
# The badge these back is the one thing in the panel that makes a claim about
# code the wiki does not contain, so all three of its states are pinned. The
# failure they exist to prevent is the quiet one: an unanswerable check that
# renders identically to a fresh wiki.


async def test_a_scan_records_the_commit_it_was_built_at(repo):
    set_host(FakeHost(repo, head_ref="abc123"))
    result = await scan(str(repo), config=Config())
    # Without this the freshness check has no ref, and an empty diff would be
    # indistinguishable from a diff nobody could compute.
    assert result.handle.head_ref == "abc123"


async def test_no_changes_since_the_recorded_commit_reads_as_current(repo):
    host = FakeHost(repo, changed=[])
    set_host(host)
    result = await scan(str(repo), config=Config())

    answer = await staleness(result)
    assert answer.known and not answer.stale
    # It asked about the scan's own commit, not HEAD or an empty string.
    assert host.diff_refs[-1] == result.handle.head_ref


async def test_changed_files_since_the_recorded_commit_read_as_stale(repo):
    set_host(FakeHost(repo, changed=["core/engine.py", "README.md"]))
    result = await scan(str(repo), config=Config())

    answer = await staleness(result)
    assert answer.known and answer.stale
    assert answer.changed == ["README.md", "core/engine.py"]
    assert answer.to_summary()["changedCount"] == 2


async def test_a_checkout_with_no_recorded_commit_is_unknown_not_current(repo):
    # A directory that is not a repository, or a host with no git bridge. The
    # answer must not be "current" — nobody checked.
    set_host(FakeHost(repo, head_ref=""))
    result = await scan(str(repo), config=Config())

    answer = await staleness(result)
    assert not answer.known
    assert not answer.stale
    assert answer.reason


async def test_a_failed_diff_is_unknown_rather_than_swallowed_into_current(repo):
    # `changed_paths_since` deliberately collapses this into an empty set for
    # the incremental path. Staleness must not inherit that decision, or a host
    # that cannot answer would badge every wiki as up to date.
    set_host(FakeHost(repo, diff_raises=RuntimeError("no git bridge")))
    result = await scan(str(repo), config=Config())

    answer = await staleness(result)
    assert not answer.known
    assert "no git bridge" in answer.reason


async def test_the_staleness_summary_is_serialisable_because_it_crosses_the_wire(repo):
    set_host(FakeHost(repo, changed=["a.py"]))
    result = await scan(str(repo), config=Config())
    json.dumps((await staleness(result)).to_summary())
