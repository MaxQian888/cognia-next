"""Typed manifest mirrors for the agent / skills / command capability family.

Python author-facing helpers mirroring the TypeScript ``define-*`` helpers for
declarative manifest contributions an agent-oriented plugin ships:

* ``skill``                 → ``PluginSkillDef``            (manifest ``skills``)
* ``subagent``              → ``PluginSubagentDef``         (manifest ``subagents``)
* ``agent-team-template``   → ``PluginAgentTeamTemplateDef``(manifest ``agentTeamTemplates``)
* ``character-pack``        → ``PluginCharacterPackDef``    (manifest ``characterPacks``)
* ``native-anthropic-tool`` → ``PluginNativeAnthropicToolDef`` (manifest ``nativeAnthropicTools``)
* ``mcp-server-preset``     → ``PluginMcpServerPresetDef``  (manifest ``mcpServerPresets``)
* ``command``               → ``PluginManifestCommandDef``  (manifest ``commands``)
* ``quick-action``          → ``PluginQuickActionDef``      (manifest ``quickActions``)

Each helper builds a validated dataclass whose ``to_dict()`` emits the camelCase
shape the host reads from the manifest. Structured sub-objects (a skill
``source`` union, a template's ``teammates`` roster, a pack's ``characters``,
transport ``config``) are carried as plain dicts/lists — the same convention the
core ``types.py`` mirrors use for ``ProtocolAdapterDef.spec`` /
``A2UITemplate.template``.

Note: ``defineAgentTool`` and ``defineGuardrail`` on the TypeScript side carry
executable ``execute`` / ``run`` functions (renderer-side JS), so they have no
declarative manifest form and are intentionally NOT mirrored here — see the
``JS_RUNTIME_ONLY`` allowlist in ``tests/test_define_parity.py``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional

# Discriminated `source.kind` values for a plugin skill (PluginSkillSource).
_SKILL_SOURCE_KINDS = frozenset(
    {"local-folder", "anthropic-managed", "inline", "local-bundle", "archive"}
)
# Subagent reasoning-effort dial (PluginSubagentEffort).
_SUBAGENT_EFFORTS = frozenset({"low", "medium", "high", "xhigh", "max"})
# Agent-team template categories (PluginAgentTeamTemplateCategory).
_TEAM_TEMPLATE_CATEGORIES = frozenset(
    {
        "review",
        "research",
        "development",
        "debugging",
        "analysis",
        "general",
        "documentation",
        "security",
    }
)
# MCP transport kinds (McpTransport).
_MCP_TRANSPORTS = frozenset({"stdio", "http", "sse"})
# Agent runtime a preset targets.
_MCP_RUNTIMES = frozenset({"sdk", "ai-sdk", "both"})
# Character pack soft cap — mirrors PLUGIN_CHARACTER_PACK_SOFT_LIMIT (ADR-0030).
CHARACTER_PACK_SOFT_LIMIT = 50


def _require(value: str, label: str) -> None:
    if not value or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")


# -- skill ------------------------------------------------------------------


@dataclass(frozen=True)
class Skill:
    """A skill contribution (mirrors ``PluginSkillDef``)."""

    id: str
    name: str
    description: str
    source: Dict[str, Any]
    scope: Optional[str] = None
    attach_to_character_ids: List[str] = field(default_factory=list)
    allowed_tools: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "source": dict(self.source),
        }
        if self.scope is not None:
            out["scope"] = self.scope
        if self.attach_to_character_ids:
            out["attachToCharacterIds"] = list(self.attach_to_character_ids)
        if self.allowed_tools:
            out["allowedTools"] = list(self.allowed_tools)
        return out


def define_skill(
    id: str,
    name: str,
    description: str,
    source: Mapping[str, Any],
    *,
    scope: Optional[str] = None,
    attach_to_character_ids: Optional[List[str]] = None,
    allowed_tools: Optional[List[str]] = None,
) -> Skill:
    """Construct a validated ``Skill``.

    ``source`` is the discriminated union ``{kind, ...}``; ``kind`` must be one
    of ``local-folder`` / ``anthropic-managed`` / ``inline`` / ``local-bundle`` /
    ``archive``.
    """
    _require(id, "skill id")
    _require(name, "skill name")
    _require(description, "skill description")
    if not source or "kind" not in source:
        raise ValueError("skill source must be a mapping with a 'kind' field")
    kind = source["kind"]
    if kind not in _SKILL_SOURCE_KINDS:
        raise ValueError(
            f"unknown skill source kind {kind!r}; expected one of "
            f"{sorted(_SKILL_SOURCE_KINDS)}"
        )
    return Skill(
        id=id,
        name=name,
        description=description,
        source=dict(source),
        scope=scope,
        attach_to_character_ids=list(attach_to_character_ids or []),
        allowed_tools=list(allowed_tools or []),
    )


# -- subagent ---------------------------------------------------------------


@dataclass(frozen=True)
class Subagent:
    """A subagent contribution (mirrors ``PluginSubagentDef``)."""

    id: str
    name: str
    description: str
    prompt: str
    tools: List[str] = field(default_factory=list)
    disallowed_tools: List[str] = field(default_factory=list)
    model: Optional[str] = None
    provider: Optional[str] = None
    max_turns: Optional[int] = None
    effort: Optional[str] = None
    external_preset_id: Optional[str] = None
    allow_nesting: Optional[bool] = None
    max_depth: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "prompt": self.prompt,
        }
        if self.tools:
            out["tools"] = list(self.tools)
        if self.disallowed_tools:
            out["disallowedTools"] = list(self.disallowed_tools)
        if self.model is not None:
            out["model"] = self.model
        if self.provider is not None:
            out["provider"] = self.provider
        if self.max_turns is not None:
            out["maxTurns"] = self.max_turns
        if self.effort is not None:
            out["effort"] = self.effort
        if self.external_preset_id is not None:
            out["externalPresetId"] = self.external_preset_id
        if self.allow_nesting is not None:
            out["allowNesting"] = self.allow_nesting
        if self.max_depth is not None:
            out["maxDepth"] = self.max_depth
        return out


def define_subagent(
    id: str,
    name: str,
    description: str,
    prompt: str,
    *,
    tools: Optional[List[str]] = None,
    disallowed_tools: Optional[List[str]] = None,
    model: Optional[str] = None,
    provider: Optional[str] = None,
    max_turns: Optional[int] = None,
    effort: Optional[str] = None,
    external_preset_id: Optional[str] = None,
    allow_nesting: Optional[bool] = None,
    max_depth: Optional[int] = None,
) -> Subagent:
    """Construct a validated ``Subagent``. ``effort`` (if set) must be one of
    ``low`` / ``medium`` / ``high`` / ``xhigh`` / ``max``."""
    _require(id, "subagent id")
    _require(name, "subagent name")
    _require(description, "subagent description")
    _require(prompt, "subagent prompt")
    if effort is not None and effort not in _SUBAGENT_EFFORTS:
        raise ValueError(
            f"unknown effort {effort!r}; expected one of {sorted(_SUBAGENT_EFFORTS)}"
        )
    return Subagent(
        id=id,
        name=name,
        description=description,
        prompt=prompt,
        tools=list(tools or []),
        disallowed_tools=list(disallowed_tools or []),
        model=model,
        provider=provider,
        max_turns=max_turns,
        effort=effort,
        external_preset_id=external_preset_id,
        allow_nesting=allow_nesting,
        max_depth=max_depth,
    )


# -- agent-team-template ----------------------------------------------------


@dataclass(frozen=True)
class AgentTeamTemplate:
    """An agent-team template (mirrors ``PluginAgentTeamTemplateDef``)."""

    id: str
    name: str
    description: str
    category: str
    teammates: List[Dict[str, Any]]
    task_templates: List[Dict[str, Any]] = field(default_factory=list)
    config: Optional[Dict[str, Any]] = None
    icon: Optional[str] = None
    requires: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "category": self.category,
            "teammates": [dict(t) for t in self.teammates],
        }
        if self.task_templates:
            out["taskTemplates"] = [dict(t) for t in self.task_templates]
        if self.config is not None:
            out["config"] = dict(self.config)
        if self.icon is not None:
            out["icon"] = self.icon
        if self.requires is not None:
            out["requires"] = dict(self.requires)
        return out


def define_agent_team_template(
    id: str,
    name: str,
    description: str,
    category: str,
    teammates: List[Mapping[str, Any]],
    *,
    task_templates: Optional[List[Mapping[str, Any]]] = None,
    config: Optional[Mapping[str, Any]] = None,
    icon: Optional[str] = None,
    requires: Optional[Mapping[str, Any]] = None,
) -> AgentTeamTemplate:
    """Construct a validated ``AgentTeamTemplate``. ``category`` must be one of
    the eight known categories; ``teammates`` must be non-empty."""
    _require(id, "team template id")
    _require(name, "team template name")
    _require(description, "team template description")
    if category not in _TEAM_TEMPLATE_CATEGORIES:
        raise ValueError(
            f"unknown category {category!r}; expected one of "
            f"{sorted(_TEAM_TEMPLATE_CATEGORIES)}"
        )
    if not teammates:
        raise ValueError("team template must declare at least one teammate")
    return AgentTeamTemplate(
        id=id,
        name=name,
        description=description,
        category=category,
        teammates=[dict(t) for t in teammates],
        task_templates=[dict(t) for t in (task_templates or [])],
        config=dict(config) if config is not None else None,
        icon=icon,
        requires=dict(requires) if requires is not None else None,
    )


# -- character-pack ---------------------------------------------------------


@dataclass(frozen=True)
class CharacterPack:
    """A character-pack contribution (mirrors ``PluginCharacterPackDef``)."""

    id: str
    name: str
    version: str
    characters: List[Dict[str, Any]]
    description: Optional[str] = None
    requires: Optional[Dict[str, Any]] = None
    icon: Optional[Dict[str, Any]] = None
    tags: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "characters": [dict(c) for c in self.characters],
        }
        if self.description is not None:
            out["description"] = self.description
        if self.requires is not None:
            out["requires"] = dict(self.requires)
        if self.icon is not None:
            out["icon"] = dict(self.icon)
        if self.tags:
            out["tags"] = list(self.tags)
        return out


def define_character_pack(
    id: str,
    name: str,
    version: str,
    characters: List[Mapping[str, Any]],
    *,
    description: Optional[str] = None,
    requires: Optional[Mapping[str, Any]] = None,
    icon: Optional[Mapping[str, Any]] = None,
    tags: Optional[List[str]] = None,
) -> CharacterPack:
    """Construct a validated ``CharacterPack``.

    Mirrors ``defineCharacterPack``: at least one character, at most
    ``CHARACTER_PACK_SOFT_LIMIT`` (50), and unique ``localId`` per character.
    """
    _require(id, "character pack id")
    _require(name, "character pack name")
    _require(version, "character pack version")
    chars = [dict(c) for c in characters]
    if not chars:
        raise ValueError(f'character pack "{id}" must declare at least one character')
    if len(chars) > CHARACTER_PACK_SOFT_LIMIT:
        raise ValueError(
            f'character pack "{id}" declares {len(chars)} characters; the soft '
            f"limit is {CHARACTER_PACK_SOFT_LIMIT}. Split into multiple packs."
        )
    seen = set()
    for ch in chars:
        local_id = ch.get("localId")
        if local_id in seen:
            raise ValueError(
                f'character pack "{id}" has duplicate localId "{local_id}"'
            )
        seen.add(local_id)
    return CharacterPack(
        id=id,
        name=name,
        version=version,
        characters=chars,
        description=description,
        requires=dict(requires) if requires is not None else None,
        icon=dict(icon) if icon is not None else None,
        tags=list(tags or []),
    )


# -- native-anthropic-tool --------------------------------------------------


@dataclass(frozen=True)
class NativeAnthropicTool:
    """A native Anthropic tool def (mirrors ``PluginNativeAnthropicToolDef``)."""

    id: str
    name: str
    type: str
    execute_ipc: Dict[str, Any]
    beta_header: Optional[str] = None
    display_width_px: Optional[int] = None
    display_height_px: Optional[int] = None
    display_number: Optional[int] = None
    enable_zoom: Optional[bool] = None
    permission_policy: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "type": self.type,
            "executeIpc": dict(self.execute_ipc),
        }
        if self.beta_header is not None:
            out["betaHeader"] = self.beta_header
        if self.display_width_px is not None:
            out["displayWidthPx"] = self.display_width_px
        if self.display_height_px is not None:
            out["displayHeightPx"] = self.display_height_px
        if self.display_number is not None:
            out["displayNumber"] = self.display_number
        if self.enable_zoom is not None:
            out["enableZoom"] = self.enable_zoom
        if self.permission_policy is not None:
            out["permissionPolicy"] = self.permission_policy
        return out


def define_native_anthropic_tool(
    id: str,
    name: str,
    type: str,
    execute_ipc: Mapping[str, Any],
    *,
    beta_header: Optional[str] = None,
    display_width_px: Optional[int] = None,
    display_height_px: Optional[int] = None,
    display_number: Optional[int] = None,
    enable_zoom: Optional[bool] = None,
    permission_policy: Optional[str] = None,
) -> NativeAnthropicTool:
    """Construct a validated ``NativeAnthropicTool``. ``execute_ipc`` must carry
    an ``invoke`` command name."""
    _require(id, "native tool id")
    _require(name, "native tool name")
    _require(type, "native tool type")
    if not execute_ipc or "invoke" not in execute_ipc:
        raise ValueError("native tool execute_ipc must include an 'invoke' command")
    return NativeAnthropicTool(
        id=id,
        name=name,
        type=type,
        execute_ipc=dict(execute_ipc),
        beta_header=beta_header,
        display_width_px=display_width_px,
        display_height_px=display_height_px,
        display_number=display_number,
        enable_zoom=enable_zoom,
        permission_policy=permission_policy,
    )


# -- mcp-server-preset ------------------------------------------------------


@dataclass(frozen=True)
class McpServerPreset:
    """An MCP server preset (mirrors ``PluginMcpServerPresetDef``)."""

    id: str
    name: str
    transport: str
    config: Dict[str, Any]
    description: Optional[str] = None
    icon: Optional[str] = None
    fields: List[Dict[str, Any]] = field(default_factory=list)
    runtime: Optional[str] = None
    docs_url: Optional[str] = None
    tags: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "transport": self.transport,
            "config": dict(self.config),
        }
        if self.description is not None:
            out["description"] = self.description
        if self.icon is not None:
            out["icon"] = self.icon
        if self.fields:
            out["fields"] = [dict(f) for f in self.fields]
        if self.runtime is not None:
            out["runtime"] = self.runtime
        if self.docs_url is not None:
            out["docsUrl"] = self.docs_url
        if self.tags:
            out["tags"] = list(self.tags)
        return out


def define_mcp_server_preset(
    id: str,
    name: str,
    transport: str,
    config: Mapping[str, Any],
    *,
    description: Optional[str] = None,
    icon: Optional[str] = None,
    fields: Optional[List[Mapping[str, Any]]] = None,
    runtime: Optional[str] = None,
    docs_url: Optional[str] = None,
    tags: Optional[List[str]] = None,
) -> McpServerPreset:
    """Construct a validated ``McpServerPreset``. ``transport`` must be one of
    ``stdio`` / ``http`` / ``sse``; ``runtime`` (if set) one of
    ``sdk`` / ``ai-sdk`` / ``both``."""
    _require(id, "mcp preset id")
    _require(name, "mcp preset name")
    if transport not in _MCP_TRANSPORTS:
        raise ValueError(
            f"unknown transport {transport!r}; expected one of "
            f"{sorted(_MCP_TRANSPORTS)}"
        )
    if runtime is not None and runtime not in _MCP_RUNTIMES:
        raise ValueError(
            f"unknown runtime {runtime!r}; expected one of {sorted(_MCP_RUNTIMES)}"
        )
    return McpServerPreset(
        id=id,
        name=name,
        transport=transport,
        config=dict(config),
        description=description,
        icon=icon,
        fields=[dict(f) for f in (fields or [])],
        runtime=runtime,
        docs_url=docs_url,
        tags=list(tags or []),
    )


# -- command ----------------------------------------------------------------


@dataclass(frozen=True)
class Command:
    """A manifest command contribution (mirrors ``PluginManifestCommandDef``)."""

    id: str
    name: str
    description: Optional[str] = None
    icon: Optional[str] = None
    aliases: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"id": self.id, "name": self.name}
        if self.description is not None:
            out["description"] = self.description
        if self.icon is not None:
            out["icon"] = self.icon
        if self.aliases:
            out["aliases"] = list(self.aliases)
        return out


def define_command(
    id: str,
    name: str,
    *,
    description: Optional[str] = None,
    icon: Optional[str] = None,
    aliases: Optional[List[str]] = None,
) -> Command:
    """Construct a validated ``Command``."""
    _require(id, "command id")
    _require(name, "command name")
    return Command(
        id=id,
        name=name,
        description=description,
        icon=icon,
        aliases=list(aliases or []),
    )


# -- quick-action -----------------------------------------------------------


@dataclass(frozen=True)
class QuickAction:
    """A quick-action contribution (mirrors ``PluginQuickActionDef``)."""

    id: str
    title: str
    label_key: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    category: Optional[str] = None
    when: Optional[str] = None
    accelerator: Optional[str] = None
    command: Optional[str] = None
    slash: Optional[str] = None
    surfaces: List[str] = field(default_factory=list)
    selection: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"id": self.id, "title": self.title}
        if self.label_key is not None:
            out["labelKey"] = self.label_key
        if self.description is not None:
            out["description"] = self.description
        if self.icon is not None:
            out["icon"] = self.icon
        if self.category is not None:
            out["category"] = self.category
        if self.when is not None:
            out["when"] = self.when
        if self.accelerator is not None:
            out["accelerator"] = self.accelerator
        if self.command is not None:
            out["command"] = self.command
        if self.slash is not None:
            out["slash"] = self.slash
        if self.surfaces:
            out["surfaces"] = list(self.surfaces)
        if self.selection is not None:
            out["selection"] = dict(self.selection)
        return out


def define_quick_action(
    id: str,
    title: str,
    *,
    description: Optional[str] = None,
    label_key: Optional[str] = None,
    icon: Optional[str] = None,
    category: Optional[str] = None,
    when: Optional[str] = None,
    accelerator: Optional[str] = None,
    command: Optional[str] = None,
    slash: Optional[str] = None,
    surfaces: Optional[List[str]] = None,
    selection: Optional[Dict[str, Any]] = None,
) -> QuickAction:
    """Construct a validated ``QuickAction``. A quick action must name a
    dispatch target — exactly one of ``command`` or ``slash`` is required."""
    _require(id, "quick action id")
    _require(title, "quick action title")
    if not command and not slash:
        raise ValueError(
            "quick action must name a dispatch target (command or slash)"
        )
    resolved_surfaces = list(surfaces or [])
    allowed_surfaces = {"palette", "composer", "tray", "selection"}
    if any(surface not in allowed_surfaces for surface in resolved_surfaces):
        raise ValueError("quick action contains an unsupported surface")
    if "selection" in resolved_surfaces and selection is None:
        raise ValueError("selection surface requires a selection contract")
    if selection is not None and "selection" not in resolved_surfaces:
        raise ValueError("selection contract requires the selection surface")
    if selection is not None:
        if selection.get("input") not in {"metadata", "text"}:
            raise ValueError("selection contract input must be metadata or text")
        if selection.get("output") not in {
            "none",
            "preview",
            "copy",
            "replace",
            "status",
        }:
            raise ValueError("selection contract output is invalid")
        max_chars = selection.get("maxChars")
        if max_chars is not None and (
            not isinstance(max_chars, int) or isinstance(max_chars, bool) or max_chars <= 0
        ):
            raise ValueError("selection contract maxChars must be a positive integer")
    return QuickAction(
        id=id,
        title=title,
        label_key=label_key,
        description=description,
        icon=icon,
        category=category,
        when=when,
        accelerator=accelerator,
        command=command,
        slash=slash,
        surfaces=resolved_surfaces,
        selection=dict(selection) if selection is not None else None,
    )
