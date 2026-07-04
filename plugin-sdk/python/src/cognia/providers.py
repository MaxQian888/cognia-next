"""Typed manifest mirrors for the provider / language-server capability family.

Python author-facing helpers mirroring the TypeScript ``define-*`` helpers for
declarative provider contributions a plugin ships:

* ``ai-provider``   → ``PluginAiProviderDef``  (manifest ``aiProviders``)
* ``ocr-provider``  → ``PluginOcrProviderDef``  (manifest ``ocrProviders``)
* ``lsp-server``    → ``PluginLspServerDef`` / ``LspServerConfig`` (manifest ``lspServers``)
* ``cli-tool``      → ``PluginCliToolDef``      (manifest ``cliTools``)
* ``connector``     → ``PluginConnectorDef``    (manifest ``connectors``)

Each helper builds a validated dataclass whose ``to_dict()`` emits the camelCase
shape the host reads from the manifest. Structured sub-objects (a CLI tool's
``binary``/``argv``/``cwd`` spec, an LSP ``initializationOptions``/``install``
block, a connector's ``configSchema``) are carried as plain dicts/lists.

Note: the balance-adapter / limits-source / im-rate-source / shared-memory-adapter
capabilities are runtime objects that carry executable fetch/read/write methods
(renderer-side JS), so they have no declarative manifest form and are NOT mirrored
here — see the ``JS_RUNTIME_ONLY`` allowlist in ``tests/test_define_parity.py``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional

# ai-provider discriminator (PluginLlmProviderDef | PluginEmbeddingProviderDef).
_AI_PROVIDER_KINDS = frozenset({"llm", "embedding"})
# CLI-tool stdout parse modes (PluginCliOutputParse).
_CLI_OUTPUT_PARSE = frozenset({"text", "json", "lines"})


def _require(value: str, label: str) -> None:
    if not value or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")


# -- ai-provider ------------------------------------------------------------


@dataclass(frozen=True)
class AiProvider:
    """An AI provider contribution (mirrors ``PluginAiProviderDef``).

    The TS type is a discriminated union: ``kind="llm"`` carries optional
    ``models``; ``kind="embedding"`` carries required ``dimensions``.
    """

    id: str
    label: str
    entry: str
    export: str
    kind: str
    description: Optional[str] = None
    models: List[str] = field(default_factory=list)
    dimensions: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "label": self.label,
            "entry": self.entry,
            "export": self.export,
            "kind": self.kind,
        }
        if self.description is not None:
            out["description"] = self.description
        if self.kind == "llm":
            if self.models:
                out["models"] = list(self.models)
        elif self.kind == "embedding":
            out["dimensions"] = self.dimensions
        return out


def define_ai_provider(
    id: str,
    label: str,
    entry: str,
    export: str,
    kind: str,
    *,
    description: Optional[str] = None,
    models: Optional[List[str]] = None,
    dimensions: Optional[int] = None,
) -> AiProvider:
    """Construct a validated ``AiProvider``. ``kind`` must be ``"llm"`` or
    ``"embedding"``; an embedding provider requires ``dimensions``."""
    _require(id, "ai provider id")
    _require(label, "ai provider label")
    _require(entry, "ai provider entry")
    _require(export, "ai provider export")
    if kind not in _AI_PROVIDER_KINDS:
        raise ValueError(
            f"unknown ai provider kind {kind!r}; expected one of "
            f"{sorted(_AI_PROVIDER_KINDS)}"
        )
    if kind == "embedding" and dimensions is None:
        raise ValueError("an embedding ai provider requires 'dimensions'")
    return AiProvider(
        id=id,
        label=label,
        entry=entry,
        export=export,
        kind=kind,
        description=description,
        models=list(models or []),
        dimensions=dimensions,
    )


# -- ocr-provider -----------------------------------------------------------


@dataclass(frozen=True)
class OcrProvider:
    """An OCR provider contribution (mirrors ``PluginOcrProviderDef``)."""

    id: str
    label: str
    entry: str
    export: str
    description: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "label": self.label,
            "entry": self.entry,
            "export": self.export,
        }
        if self.description is not None:
            out["description"] = self.description
        return out


def define_ocr_provider(
    id: str,
    label: str,
    entry: str,
    export: str,
    *,
    description: Optional[str] = None,
) -> OcrProvider:
    """Construct a validated ``OcrProvider``."""
    _require(id, "ocr provider id")
    _require(label, "ocr provider label")
    _require(entry, "ocr provider entry")
    _require(export, "ocr provider export")
    return OcrProvider(
        id=id, label=label, entry=entry, export=export, description=description
    )


# -- lsp-server -------------------------------------------------------------


@dataclass(frozen=True)
class LspServer:
    """A language-server contribution (mirrors ``PluginLspServerDef`` /
    ``LspServerConfig``)."""

    id: str
    name: str
    languages: List[str]
    command: str
    extensions: List[str] = field(default_factory=list)
    filenames: List[str] = field(default_factory=list)
    args: List[str] = field(default_factory=list)
    env: Dict[str, str] = field(default_factory=dict)
    root_markers: List[str] = field(default_factory=list)
    exclude_root_markers: List[str] = field(default_factory=list)
    transport: Optional[str] = None
    initialization_options: Optional[Dict[str, Any]] = None
    settings: Optional[Dict[str, Any]] = None
    workspace_folder_required: Optional[bool] = None
    enabled: Optional[bool] = None
    install: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "languages": list(self.languages),
            "command": self.command,
        }
        if self.extensions:
            out["extensions"] = list(self.extensions)
        if self.filenames:
            out["filenames"] = list(self.filenames)
        if self.args:
            out["args"] = list(self.args)
        if self.env:
            out["env"] = dict(self.env)
        if self.root_markers:
            out["rootMarkers"] = list(self.root_markers)
        if self.exclude_root_markers:
            out["excludeRootMarkers"] = list(self.exclude_root_markers)
        if self.transport is not None:
            out["transport"] = self.transport
        if self.initialization_options is not None:
            out["initializationOptions"] = dict(self.initialization_options)
        if self.settings is not None:
            out["settings"] = dict(self.settings)
        if self.workspace_folder_required is not None:
            out["workspaceFolderRequired"] = self.workspace_folder_required
        if self.enabled is not None:
            out["enabled"] = self.enabled
        if self.install is not None:
            out["install"] = dict(self.install)
        return out


def define_lsp_server(
    id: str,
    name: str,
    languages: List[str],
    command: str,
    *,
    extensions: Optional[List[str]] = None,
    filenames: Optional[List[str]] = None,
    args: Optional[List[str]] = None,
    env: Optional[Dict[str, str]] = None,
    root_markers: Optional[List[str]] = None,
    exclude_root_markers: Optional[List[str]] = None,
    transport: Optional[str] = None,
    initialization_options: Optional[Mapping[str, Any]] = None,
    settings: Optional[Mapping[str, Any]] = None,
    workspace_folder_required: Optional[bool] = None,
    enabled: Optional[bool] = None,
    install: Optional[Mapping[str, Any]] = None,
) -> LspServer:
    """Construct a validated ``LspServer``. ``id``, ``name``, ``languages`` and
    ``command`` are required."""
    _require(id, "lsp server id")
    _require(name, "lsp server name")
    _require(command, "lsp server command")
    if not languages:
        raise ValueError("lsp server must declare at least one language")
    return LspServer(
        id=id,
        name=name,
        languages=list(languages),
        command=command,
        extensions=list(extensions or []),
        filenames=list(filenames or []),
        args=list(args or []),
        env=dict(env or {}),
        root_markers=list(root_markers or []),
        exclude_root_markers=list(exclude_root_markers or []),
        transport=transport,
        initialization_options=(
            dict(initialization_options) if initialization_options is not None else None
        ),
        settings=dict(settings) if settings is not None else None,
        workspace_folder_required=workspace_folder_required,
        enabled=enabled,
        install=dict(install) if install is not None else None,
    )


# -- cli-tool ---------------------------------------------------------------


@dataclass(frozen=True)
class CliTool:
    """A CLI-backed tool contribution (mirrors ``PluginCliToolDef``)."""

    name: str
    description: str
    parameters: Dict[str, Any]
    binary: Dict[str, Any]
    argv: List[Any]
    stdin: Optional[Dict[str, Any]] = None
    cwd: Optional[Dict[str, Any]] = None
    env: Dict[str, str] = field(default_factory=dict)
    timeout_ms: Optional[int] = None
    output_parse: Optional[str] = None
    success_exit_codes: List[int] = field(default_factory=list)
    max_output_bytes: Optional[int] = None
    version_arg: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "name": self.name,
            "description": self.description,
            "parameters": dict(self.parameters),
            "binary": dict(self.binary),
            "argv": list(self.argv),
        }
        if self.stdin is not None:
            out["stdin"] = dict(self.stdin)
        if self.cwd is not None:
            out["cwd"] = dict(self.cwd)
        if self.env:
            out["env"] = dict(self.env)
        if self.timeout_ms is not None:
            out["timeoutMs"] = self.timeout_ms
        if self.output_parse is not None:
            out["outputParse"] = self.output_parse
        if self.success_exit_codes:
            out["successExitCodes"] = list(self.success_exit_codes)
        if self.max_output_bytes is not None:
            out["maxOutputBytes"] = self.max_output_bytes
        if self.version_arg is not None:
            out["versionArg"] = self.version_arg
        return out


def define_cli_tool(
    name: str,
    description: str,
    parameters: Mapping[str, Any],
    binary: Mapping[str, Any],
    argv: List[Any],
    *,
    stdin: Optional[Mapping[str, Any]] = None,
    cwd: Optional[Mapping[str, Any]] = None,
    env: Optional[Dict[str, str]] = None,
    timeout_ms: Optional[int] = None,
    output_parse: Optional[str] = None,
    success_exit_codes: Optional[List[int]] = None,
    max_output_bytes: Optional[int] = None,
    version_arg: Optional[str] = None,
) -> CliTool:
    """Construct a validated ``CliTool``. ``output_parse`` (if set) must be one
    of ``text`` / ``json`` / ``lines``."""
    _require(name, "cli tool name")
    _require(description, "cli tool description")
    if output_parse is not None and output_parse not in _CLI_OUTPUT_PARSE:
        raise ValueError(
            f"unknown output_parse {output_parse!r}; expected one of "
            f"{sorted(_CLI_OUTPUT_PARSE)}"
        )
    return CliTool(
        name=name,
        description=description,
        parameters=dict(parameters),
        binary=dict(binary),
        argv=list(argv),
        stdin=dict(stdin) if stdin is not None else None,
        cwd=dict(cwd) if cwd is not None else None,
        env=dict(env or {}),
        timeout_ms=timeout_ms,
        output_parse=output_parse,
        success_exit_codes=list(success_exit_codes or []),
        max_output_bytes=max_output_bytes,
        version_arg=version_arg,
    )


# -- connector --------------------------------------------------------------


@dataclass(frozen=True)
class Connector:
    """A platform-connector contribution (mirrors ``PluginConnectorDef``)."""

    type: str
    factory: str
    config_schema: Dict[str, Any]
    transport_modes: List[str]
    default_trigger: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "type": self.type,
            "factory": self.factory,
            "configSchema": dict(self.config_schema),
            "transportModes": list(self.transport_modes),
        }
        if self.default_trigger is not None:
            out["defaultTrigger"] = dict(self.default_trigger)
        return out


def define_connector(
    type: str,
    factory: str,
    config_schema: Mapping[str, Any],
    transport_modes: List[str],
    *,
    default_trigger: Optional[Mapping[str, Any]] = None,
) -> Connector:
    """Construct a validated ``Connector``. ``type``, ``factory`` and at least
    one transport mode are required."""
    _require(type, "connector type")
    _require(factory, "connector factory")
    if not transport_modes:
        raise ValueError("connector must declare at least one transport mode")
    return Connector(
        type=type,
        factory=factory,
        config_schema=dict(config_schema),
        transport_modes=list(transport_modes),
        default_trigger=(
            dict(default_trigger) if default_trigger is not None else None
        ),
    )
