"""The host seam: the only module in this package that knows about Cognia.

Everything the port replaced lands here, so these are the tests that would
catch a regression back toward litellm, `~/.repowiki`, or `os.walk`.
"""

from __future__ import annotations

import json

import pytest

from repowiki.host import (
    PATHS,
    HostBridge,
    HostUnavailableError,
    LLMClient,
    LLMError,
    WorkspaceHandle,
    acquire_workspace,
    changed_since,
    configure_paths,
    get_host,
    release_workspace,
    set_host,
    split_messages,
)


class RecordingHost(HostBridge):
    def __init__(self, *, run_result=None, acquire=None, walk=None, changed=None, released=True):
        self.runs: list[tuple[str, dict]] = []
        self.acquires: list[dict] = []
        self.walks: list[tuple[dict, dict]] = []
        self.releases: list[dict] = []
        self._run_result = run_result if run_result is not None else {"text": "ok"}
        self._acquire = acquire
        self._walk = walk or {"entries": [], "truncated": False, "skippedSensitive": 0}
        self._changed = changed or []
        self._released = released

    async def agent_run(self, prompt, options):
        self.runs.append((prompt, options))
        return self._run_result

    async def workspace_acquire(self, spec):
        self.acquires.append(spec)
        return self._acquire

    async def workspace_walk(self, handle, options):
        self.walks.append((handle, options))
        return self._walk

    async def workspace_changed_since(self, handle, ref):
        return self._changed

    async def workspace_release(self, handle):
        self.releases.append(handle)
        return self._released


@pytest.fixture(autouse=True)
def isolate_host(tmp_path):
    previous = PATHS.data_dir
    yield
    set_host(None)
    PATHS.data_dir = previous


# -- storage ---------------------------------------------------------------


def test_storage_paths_refuse_to_guess():
    # Upstream defaulted to `~/.repowiki`. A plugin writing there is a plugin
    # writing outside its own sandbox, so an unconfigured path is an error
    # rather than a fallback.
    PATHS.data_dir = None
    with pytest.raises(HostUnavailableError):
        _ = PATHS.cache_db
    with pytest.raises(HostUnavailableError):
        _ = PATHS.index_db


def test_configure_paths_creates_the_directory_and_names_both_files(tmp_path):
    target = tmp_path / "plugin-data"
    paths = configure_paths(target)
    assert target.is_dir()
    assert paths.cache_db == target / "cache.db"
    assert paths.index_db == target / "indexes.db"
    assert paths.repos_dir == target / "repos"


def test_configure_paths_with_none_disarms_storage(tmp_path):
    configure_paths(tmp_path)
    configure_paths(None)
    with pytest.raises(HostUnavailableError):
        _ = PATHS.cache_db


# -- LLM -------------------------------------------------------------------


def test_split_messages_folds_a_chat_list_into_prompt_and_system():
    prompt, system = split_messages(
        [
            {"role": "system", "content": "be terse"},
            {"role": "user", "content": "what is this repo"},
        ]
    )
    assert system == "be terse"
    assert prompt == "what is this repo"


def test_split_messages_keeps_roles_on_a_multi_turn_prompt():
    # `ctx.agent.run` takes one prompt; dropping who-said-what would turn a
    # repair round trip into an unattributed wall of text.
    prompt, _ = split_messages(
        [
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "reply"},
            {"role": "user", "content": "second"},
        ]
    )
    assert prompt == "first\n\nassistant: reply\n\nuser: second"


def test_split_messages_joins_several_system_turns():
    _, system = split_messages(
        [{"role": "system", "content": "a"}, {"role": "system", "content": "b"}]
    )
    assert system == "a\n\nb"


def test_split_messages_ignores_malformed_entries():
    prompt, system = split_messages(
        [None, {"role": "user"}, {"content": ""}, {"role": "user", "content": "hi"}]
    )
    assert prompt == "hi"
    assert system == ""


async def test_complete_reaches_the_host_and_counts_usage():
    host = RecordingHost(
        run_result={"text": "an answer", "usage": {"inputTokens": 11, "outputTokens": 7}}
    )
    set_host(host)
    llm = LLMClient(model="some-model")

    assert await llm.complete([{"role": "user", "content": "hi"}], temperature=0.1) == "an answer"
    prompt, options = host.runs[0]
    assert prompt == "hi"
    assert options["model"] == "some-model"
    assert options["temperature"] == 0.1
    assert llm.total_input_tokens == 11
    assert llm.total_output_tokens == 7


async def test_complete_asks_for_structured_output_and_returns_it_as_json():
    host = RecordingHost(run_result={"text": "ignored prose", "object": {"name": "x"}})
    set_host(host)
    llm = LLMClient()

    raw = await llm.complete(
        [{"role": "user", "content": "hi"}],
        response_format={"type": "json_schema", "json_schema": {"schema": {"type": "object"}}},
    )
    # The analyzer parses with `extract_json`; handing it the parsed object as
    # JSON keeps that the single parse site rather than adding a second shape.
    assert json.loads(raw) == {"name": "x"}
    assert host.runs[0][1]["outputFormat"] == {
        "type": "json_schema",
        "schema": {"type": "object"},
    }


async def test_complete_without_a_response_format_asks_for_no_schema():
    host = RecordingHost()
    set_host(host)
    await LLMClient().complete([{"role": "user", "content": "hi"}])
    assert "outputFormat" not in host.runs[0][1]


async def test_a_host_failure_becomes_an_llm_error_carrying_its_cause():
    class BoomHost(HostBridge):
        async def agent_run(self, prompt, options):
            raise TimeoutError("took too long")

    set_host(BoomHost())
    with pytest.raises(LLMError) as excinfo:
        await LLMClient().complete([{"role": "user", "content": "hi"}])
    assert isinstance(excinfo.value.cause, TimeoutError)


async def test_a_non_object_run_result_is_refused_rather_than_stringified():
    # `str(None)` in a wiki page reads as content. Refusing is louder.
    set_host(RecordingHost(run_result="just a string"))
    with pytest.raises(LLMError):
        await LLMClient().complete([{"role": "user", "content": "hi"}])


async def test_stream_yields_the_whole_completion_once():
    # Deliberately one chunk: `runStreamed` returns a live handle, and a handle
    # cannot cross the plugin's stdio boundary. Faking deltas would make a
    # caller believe it was watching a model think.
    set_host(RecordingHost(run_result={"text": "all of it"}))
    pieces = [piece async for piece in LLMClient().stream([{"role": "user", "content": "hi"}])]
    assert pieces == ["all of it"]


# -- workspace -------------------------------------------------------------


async def test_acquire_takes_the_hosts_checkout_and_its_allow_list():
    host = RecordingHost(
        acquire={"root": "/repo", "origin": "clone", "ephemeral": True},
        walk={"entries": ["a.py", {"path": "b.py"}], "truncated": True, "skippedSensitive": 3},
    )
    set_host(host)

    handle = await acquire_workspace({"kind": "auto", "input": "o/r"}, max_files=42)

    assert handle.root == "/repo"
    assert handle.ephemeral is True
    assert handle.paths == ["a.py", "b.py"]
    assert handle.truncated is True
    assert handle.skipped_sensitive == 3
    assert host.walks[0][1]["maxEntries"] == 42


async def test_acquire_refuses_a_checkout_with_no_root():
    # An empty root would walk the process CWD — the host's own guard against
    # this is why `acquire` reports failure as an absent root.
    set_host(RecordingHost(acquire={"origin": "clone"}))
    with pytest.raises(HostUnavailableError):
        await acquire_workspace({"kind": "auto", "input": "o/r"})


async def test_changed_since_normalises_and_drops_blanks():
    set_host(RecordingHost(changed=["a.py", "b\\c.py", "", None]))
    assert await changed_since(WorkspaceHandle(root="/r", origin="clone"), "HEAD") == {
        "a.py",
        "b/c.py",
    }


async def test_release_forwards_the_handle_spec():
    host = RecordingHost()
    set_host(host)
    handle = WorkspaceHandle(
        root="/repo", origin="clone", ephemeral=True, remote={"repo": "r"}
    )
    assert await release_workspace(handle) is True
    assert host.releases[0] == {
        "root": "/repo",
        "origin": "clone",
        "ephemeral": True,
        "remote": {"repo": "r"},
    }


def test_set_host_none_restores_the_real_bridge():
    set_host(RecordingHost())
    assert isinstance(get_host(), RecordingHost)
    set_host(None)
    assert type(get_host()) is HostBridge
