"""The one module that knows there is a host.

Everything else in this package is the upstream RepoWiki code, vendored with
its algorithms and tests intact. Only three layers had to change to run inside
Cognia, and all three route through here:

* **LLM** — :class:`LLMClient` speaks ``ctx.agent`` instead of litellm, so
  every model call goes through the host's provider routing, PII gate, cost
  accounting and trace spans. Upstream's prompts are untouched.
* **Storage** — upstream wrote two SQLite files under ``~/.repowiki``. A plugin
  has no business writing to the user's home directory, so the paths are
  injected by the host at startup and land in the plugin's own data directory.
* **IO** — upstream walked the filesystem with ``os.walk`` and shelled out to
  ``git``. Enumeration now goes through ``ctx.workspace``, which applies the
  host's containment rules and its refusal to hand over credential files.

Reading file *contents* stays local. The host has already said which paths are
allowed; re-fetching a thousand files one RPC at a time would turn a scan into
a thousand round trips for no extra safety.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class LLMError(RuntimeError):
    """Raised when a model call fails. Carries the underlying exception.

    Same name and shape as upstream's so the analyzer's error handling — and
    the tests that pin it — carry over unchanged.
    """

    def __init__(self, message: str, *, cause: Exception | None = None):
        super().__init__(message)
        self.cause = cause


class HostUnavailableError(RuntimeError):
    """Raised when host-backed IO is attempted with no host attached."""


# --------------------------------------------------------------------------
# Host seam
# --------------------------------------------------------------------------


class HostBridge:
    """Indirection over ``cognia.ctx`` so the package is testable offline.

    Importing ``cognia`` at module scope would make every unit test require a
    running host. Instead the bridge resolves it lazily, and a test attaches a
    fake with :func:`set_host`.
    """

    async def agent_run(self, prompt: str, options: dict[str, Any]) -> dict[str, Any]:
        import cognia

        return await cognia.ctx.agent.run(prompt, options)

    async def workspace_acquire(self, spec: dict[str, Any]) -> dict[str, Any]:
        import cognia

        return await cognia.ctx.workspace.acquire(spec)

    async def workspace_walk(
        self, handle: dict[str, Any], options: dict[str, Any]
    ) -> dict[str, Any]:
        import cognia

        return await cognia.ctx.workspace.walk(handle, options)

    async def workspace_changed_since(self, handle: dict[str, Any], ref: str) -> list[str]:
        import cognia

        return await cognia.ctx.workspace.changedSince(handle, ref)

    async def workspace_release(self, handle: dict[str, Any]) -> bool:
        import cognia

        return await cognia.ctx.workspace.release(handle)


_host: HostBridge = HostBridge()


def set_host(bridge: HostBridge | None) -> HostBridge:
    """Swap the bridge. Passing ``None`` restores the real one."""
    global _host
    _host = bridge or HostBridge()
    return _host


def get_host() -> HostBridge:
    return _host


# --------------------------------------------------------------------------
# Storage paths
# --------------------------------------------------------------------------


@dataclass
class HostPaths:
    """Where this plugin is allowed to write.

    Upstream hardcoded ``Path.home() / ".repowiki"`` in four places. Nothing
    fills these in by default: a missing path is an error at the call site
    rather than a silent write into the user's home directory.
    """

    data_dir: Path | None = None

    @property
    def cache_db(self) -> Path:
        return self._require() / "cache.db"

    @property
    def index_db(self) -> Path:
        return self._require() / "indexes.db"

    @property
    def repos_dir(self) -> Path:
        return self._require() / "repos"

    def _require(self) -> Path:
        if self.data_dir is None:
            raise HostUnavailableError(
                "repowiki storage paths are not configured; the host injects them on startup"
            )
        return self.data_dir


PATHS = HostPaths()


def configure_paths(data_dir: str | Path | None) -> HostPaths:
    """Point the plugin's storage at the host-provided data directory."""
    PATHS.data_dir = Path(data_dir) if data_dir else None
    if PATHS.data_dir is not None:
        PATHS.data_dir.mkdir(parents=True, exist_ok=True)
    return PATHS


# --------------------------------------------------------------------------
# LLM
# --------------------------------------------------------------------------


@dataclass
class LLMClient:
    """Upstream's ``LLMClient`` surface, backed by ``ctx.agent.run``.

    The analyzer only ever calls :meth:`complete`; :meth:`stream` exists because
    upstream's chat path used it. Streaming is *not* faked into deltas — see
    that method's note.
    """

    model: str = ""
    api_key: str = ""
    api_base: str = ""
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_cost: float = 0.0
    #: Extra options folded into every run (e.g. ``characterId``).
    run_options: dict[str, Any] = field(default_factory=dict)

    async def complete(
        self,
        messages: list[dict],
        *,
        temperature: float = 0.3,
        max_tokens: int = 4096,
        response_format: dict | None = None,
    ) -> str:
        prompt, system = split_messages(messages)
        options: dict[str, Any] = {
            "temperature": temperature,
            **self.run_options,
        }
        if system:
            options["system"] = system
        if self.model:
            options["model"] = self.model
        if response_format:
            schema = _json_schema_of(response_format)
            if schema is not None:
                # The host validates and retries once on drift, which is
                # strictly better than upstream's repair prompt. The repair
                # prompt stays as the fallback for models with no structured
                # output — see `analyzer._analyze_module`.
                options["outputFormat"] = {"type": "json_schema", "schema": schema}

        try:
            result = await get_host().agent_run(prompt, options)
        except Exception as exc:  # noqa: BLE001 — normalized to LLMError below
            logger.error("agent run failed: %s", exc)
            raise LLMError(f"{type(exc).__name__}: {exc}", cause=exc) from exc

        if not isinstance(result, dict):
            raise LLMError(f"agent run returned {type(result).__name__}, expected an object")

        usage = result.get("usage") or {}
        self.total_input_tokens += int(usage.get("inputTokens") or 0)
        self.total_output_tokens += int(usage.get("outputTokens") or 0)

        obj = result.get("object")
        if obj is not None and response_format:
            # Structured output came back parsed; hand the analyzer the JSON
            # text it expects so `extract_json` stays the single parse site.
            return json.dumps(obj, ensure_ascii=False)
        return str(result.get("text") or "")

    async def stream(
        self,
        messages: list[dict],
        *,
        temperature: float = 0.3,
        max_tokens: int = 4096,
    ) -> AsyncGenerator[str, None]:
        """Yield the completion.

        One chunk, not many, and deliberately so: ``ctx.agent.runStreamed``
        returns a live handle object, and a handle cannot cross the plugin's
        stdio boundary — a Python plugin would receive its JSON husk. Faking
        deltas by splitting the finished text would make callers believe they
        were watching a model think. Progress that *is* real reaches the UI
        through ``cognia.progress`` instead.
        """
        yield await self.complete(messages, temperature=temperature, max_tokens=max_tokens)


def split_messages(messages: list[dict]) -> tuple[str, str]:
    """Fold a chat-completions message list into ``(prompt, system)``.

    Upstream builds OpenAI-style message lists; ``ctx.agent.run`` takes one
    prompt plus a system string. Non-system turns are joined with their role
    prefixed so a multi-turn prompt does not lose who said what.
    """
    system_parts: list[str] = []
    turns: list[str] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "user")
        content = message.get("content")
        if not isinstance(content, str) or not content:
            continue
        if role == "system":
            system_parts.append(content)
        elif role == "user" and not turns:
            turns.append(content)
        else:
            turns.append(f"{role}: {content}")
    return "\n\n".join(turns), "\n\n".join(system_parts)


def _json_schema_of(response_format: dict) -> dict | None:
    """Pull a JSON schema out of an OpenAI-style ``response_format``."""
    if response_format.get("type") == "json_schema":
        schema = response_format.get("json_schema")
        if isinstance(schema, dict):
            inner = schema.get("schema")
            return inner if isinstance(inner, dict) else schema
    if response_format.get("type") == "json_object":
        return {"type": "object"}
    return None


# --------------------------------------------------------------------------
# Workspace IO
# --------------------------------------------------------------------------


@dataclass
class WorkspaceHandle:
    """A checkout the host handed us, plus the paths it is willing to expose."""

    root: str
    origin: str
    ephemeral: bool = False
    remote: dict[str, Any] | None = None
    #: Repo-relative paths from the host's gitignore-aware walk.
    paths: list[str] = field(default_factory=list)
    truncated: bool = False
    skipped_sensitive: int = 0

    @property
    def root_path(self) -> Path:
        return Path(self.root)

    def as_spec(self) -> dict[str, Any]:
        spec: dict[str, Any] = {
            "root": self.root,
            "origin": self.origin,
            "ephemeral": self.ephemeral,
        }
        if self.remote:
            spec["remote"] = self.remote
        return spec


async def acquire_workspace(
    spec: dict[str, Any],
    *,
    max_files: int = 1000,
    max_file_size: int = 200 * 1024,
) -> WorkspaceHandle:
    """Obtain a checkout and the allow-list of files inside it.

    Two host calls, not one: ``acquire`` decides *whether* we may read this
    repository at all (clone guard rails, or "is this inside a folder the user
    opened"), and ``walk`` decides *which* files — honouring ``.gitignore`` and
    refusing credential files outright.
    """
    raw = await get_host().workspace_acquire(spec)
    if not isinstance(raw, dict) or not raw.get("root"):
        raise HostUnavailableError(f"workspace.acquire returned no checkout for {spec!r}")

    handle = WorkspaceHandle(
        root=str(raw["root"]),
        origin=str(raw.get("origin") or "local-path"),
        ephemeral=bool(raw.get("ephemeral")),
        remote=raw.get("remote") if isinstance(raw.get("remote"), dict) else None,
    )
    await refresh_paths(handle, max_files=max_files, max_file_size=max_file_size)
    return handle


async def refresh_paths(
    handle: WorkspaceHandle,
    *,
    max_files: int = 1000,
    max_file_size: int = 200 * 1024,
) -> WorkspaceHandle:
    """Re-run the host walk, replacing the handle's allow-list."""
    walk = await get_host().workspace_walk(
        handle.as_spec(), {"maxEntries": max_files, "maxFileSize": max_file_size}
    )
    if not isinstance(walk, dict):
        raise HostUnavailableError("workspace.walk returned no result")

    entries = walk.get("entries") or []
    paths: list[str] = []
    for entry in entries:
        if isinstance(entry, str):
            paths.append(entry)
        elif isinstance(entry, dict):
            value = entry.get("path") or entry.get("relPath")
            if isinstance(value, str):
                paths.append(value)
    handle.paths = paths
    handle.truncated = bool(walk.get("truncated"))
    handle.skipped_sensitive = int(walk.get("skippedSensitive") or 0)
    return handle


async def changed_since(handle: WorkspaceHandle, ref: str) -> set[str]:
    """Repo-relative paths that differ between ``ref`` and the checkout."""
    changed = await get_host().workspace_changed_since(handle.as_spec(), ref)
    if not changed:
        return set()
    return {str(path).replace("\\", "/") for path in changed if path}


async def release_workspace(handle: WorkspaceHandle) -> bool:
    """Drop the handle, deleting the checkout only when we cloned it."""
    return bool(await get_host().workspace_release(handle.as_spec()))
