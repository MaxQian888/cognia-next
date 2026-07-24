"""Typed data models for the Cognia Python plugin SDK.

These dataclasses mirror the shapes the Tauri Python host exchanges over its
NDJSON stdio protocol (`src-tauri/src/plugin_api/python/host.py` +
`protocol.rs`). They are the author-facing, type-checked surface — the host
serialises the same shapes as plain dicts at runtime.

Stdlib only, written for Python >= 3.9 (`from __future__ import annotations`
defers every annotation so newer typing syntax stays import-safe).
"""

from __future__ import annotations

import inspect
import json
import typing
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Mapping, Optional

# A tool function maps keyword args to a JSON-serialisable result (or an
# iterator of chunks for streaming tools).
ToolFn = Callable[..., Any]
# A hook receives one JSON payload and returns a (possibly transformed) one.
HookFn = Callable[[Any], Any]

# The JSON schema type tags the host understands, keyed by Python type. Mirrors
# host.py `_TYPE_MAP` exactly so inference here matches what the host infers.
PYTHON_TO_JSON_TYPE: Dict[type, str] = {
    str: "string",
    int: "number",
    float: "number",
    bool: "boolean",
    list: "array",
    dict: "object",
}


def json_type_for(annotation: Any) -> str:
    """Map a parameter annotation to the host's JSON type tag.

    Mirrors host.py `_json_type_for`: bare/empty → ``"any"``, a known concrete
    type → its tag, a parameterised generic (``list[int]``) → its origin's tag,
    everything else → ``"any"``.
    """
    if annotation is inspect.Parameter.empty or annotation is None:
        return "any"
    if annotation in PYTHON_TO_JSON_TYPE:
        return PYTHON_TO_JSON_TYPE[annotation]
    origin = getattr(annotation, "__origin__", None)
    if origin in PYTHON_TO_JSON_TYPE:
        return PYTHON_TO_JSON_TYPE[origin]
    return "any"


def infer_parameters(fn: ToolFn) -> Dict[str, Dict[str, Any]]:
    """Build a parameters dict from a callable's signature.

    Mirrors host.py `_infer_parameters`: ``*args``/``**kwargs`` are skipped, a
    parameter without a default is ``required: True``, and a JSON-serialisable
    default is echoed back under ``default``.
    """
    try:
        hints = _resolve_hints(fn)
    except Exception:  # pragma: no cover - mirrors host's defensive fallback
        hints = getattr(fn, "__annotations__", {}) or {}
    params: Dict[str, Dict[str, Any]] = {}
    try:
        signature = inspect.signature(fn)
    except (TypeError, ValueError):
        return params
    for param_name, param in signature.parameters.items():
        if param.kind in (param.VAR_POSITIONAL, param.VAR_KEYWORD):
            continue
        entry: Dict[str, Any] = {
            "type": json_type_for(hints.get(param_name, param.annotation))
        }
        if param.default is inspect.Parameter.empty:
            entry["required"] = True
        else:
            entry["required"] = False
            try:
                json.dumps(param.default)
                entry["default"] = param.default
            except (TypeError, ValueError):
                pass
        params[param_name] = entry
    return params


def _resolve_hints(fn: ToolFn) -> Dict[str, Any]:
    # `typing.get_type_hints` resolves string annotations (PEP 563 /
    # `from __future__ import annotations`) back to real types, so inference
    # works whether or not the plugin defers its annotations.
    try:
        return typing.get_type_hints(fn)
    except Exception:
        return getattr(fn, "__annotations__", {}) or {}


@dataclass(frozen=True)
class ToolParameter:
    """One typed tool parameter, mirroring the host's parameter entry shape."""

    type: str = "any"
    required: bool = False
    description: Optional[str] = None
    default: Any = None
    has_default: bool = False

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"type": self.type, "required": self.required}
        if self.description is not None:
            out["description"] = self.description
        if self.has_default:
            out["default"] = self.default
        return out

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "ToolParameter":
        has_default = "default" in raw
        return cls(
            type=str(raw.get("type", "any")),
            required=bool(raw.get("required", False)),
            description=raw.get("description"),
            default=raw.get("default") if has_default else None,
            has_default=has_default,
        )


@dataclass(frozen=True)
class ToolDefinition:
    """A tool's host-facing definition (``get_tools`` payload entry)."""

    name: str
    description: str = ""
    parameters: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
        }


@dataclass
class RegisteredTool:
    """A tool definition paired with its live callable."""

    definition: ToolDefinition
    fn: ToolFn


@dataclass(frozen=True)
class HookRegistration:
    """An event hook registration (event name + callable)."""

    event: str
    name: str
    fn: HookFn


@dataclass(frozen=True)
class ViewContainerDef:
    """A custom view container (B1), mirroring the host's
    ``PluginViewContainerDef``. Declared in ``manifest.viewsContainers``; the
    host renders a rail icon that swaps the middle column to the container's
    panel. ``location`` is ``"rail"`` (default) or ``"panel"``.
    """

    id: str
    title: str
    icon: Optional[str] = None
    location: Optional[str] = None
    order: Optional[int] = None
    when: Optional[str] = None
    hide_header: Optional[bool] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"id": self.id, "title": self.title}
        if self.icon is not None:
            out["icon"] = self.icon
        if self.location is not None:
            out["location"] = self.location
        if self.order is not None:
            out["order"] = self.order
        if self.when is not None:
            out["when"] = self.when
        if self.hide_header is not None:
            out["hideHeader"] = self.hide_header
        return out


@dataclass(frozen=True)
class TreeNode:
    """One node in a plugin tree view (B2), mirroring ``PluginTreeNode``."""

    id: str
    label: str
    icon: Optional[str] = None
    expandable: bool = False
    collapsed: bool = False
    command: Optional[str] = None
    context_value: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"id": self.id, "label": self.label}
        if self.icon is not None:
            out["icon"] = self.icon
        if self.expandable:
            out["expandable"] = True
        if self.collapsed:
            out["collapsed"] = True
        if self.command is not None:
            out["command"] = self.command
        if self.context_value is not None:
            out["contextValue"] = self.context_value
        return out


@dataclass(frozen=True)
class ViewDef:
    """A view contribution (B2), mirroring the host's ``PluginViewDef``.
    Declared in ``manifest.views``; ``type`` is ``"tree"`` or ``"react"``.
    Dynamic ``getChildren`` providers run host-side (JS); the Python SDK ships
    the manifest mirror so hybrid plugins can declare views statically.
    """

    id: str
    container_id: str
    type: str
    entry: str
    export: str
    title: Optional[str] = None
    when: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "containerId": self.container_id,
            "type": self.type,
            "entry": self.entry,
            "export": self.export,
        }
        if self.title is not None:
            out["title"] = self.title
        if self.when is not None:
            out["when"] = self.when
        return out


@dataclass(frozen=True)
class WebviewDef:
    """A sandboxed webview contribution (B3), mirroring ``PluginWebviewDef``.
    ``html`` is inline; or ``entry``+``export`` resolve an HTML string host-side.
    ``surface`` is ``"panel"`` (default) or ``"window"``.
    """

    id: str
    container_id: str
    html: Optional[str] = None
    entry: Optional[str] = None
    export: Optional[str] = None
    title: Optional[str] = None
    surface: Optional[str] = None
    when: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"id": self.id, "containerId": self.container_id}
        if self.html is not None:
            out["html"] = self.html
        if self.entry is not None:
            out["entry"] = self.entry
        if self.export is not None:
            out["export"] = self.export
        if self.title is not None:
            out["title"] = self.title
        if self.surface is not None:
            out["surface"] = self.surface
        if self.when is not None:
            out["when"] = self.when
        return out


@dataclass(frozen=True)
class AuthProviderDef:
    """A native auth/OAuth provider manifest entry (C1), mirroring
    ``PluginAuthProviderDef``. The live provider object is registered
    imperatively host-side via ``ctx.auth.register_provider``; this declarative
    ``{id, label}`` drives validation + the consent UI.
    """

    id: str
    label: str

    def to_dict(self) -> Dict[str, Any]:
        return {"id": self.id, "label": self.label}


@dataclass(frozen=True)
class WorkspaceBackendDef:
    """A lazy workspace-backend contribution (``manifest.workspaceBackends``)."""

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


@dataclass(frozen=True)
class MessageRendererDef:
    """A lazy message-part renderer contribution (``manifest.messageRenderers``)."""

    part_type: str
    entry: str
    export: str
    label: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "partType": self.part_type,
            "entry": self.entry,
            "export": self.export,
        }
        if self.label is not None:
            out["label"] = self.label
        return out


@dataclass(frozen=True)
class DensityPresetContribution:
    """A density preset contribution (``manifest.densityPresets``)."""

    name: str
    vars: Dict[str, str]

    def to_dict(self) -> Dict[str, Any]:
        return {"name": self.name, "vars": dict(self.vars)}


@dataclass(frozen=True)
class ChatMiddlewareDef:
    """A lazy chat middleware contribution (``manifest.chatMiddlewares``)."""

    id: str
    label: str
    entry: str
    export: str
    priority: Optional[int] = None
    timeout_ms: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "label": self.label,
            "entry": self.entry,
            "export": self.export,
        }
        if self.priority is not None:
            out["priority"] = self.priority
        if self.timeout_ms is not None:
            out["timeoutMs"] = self.timeout_ms
        return out


@dataclass(frozen=True)
class ModalMountDef:
    """A lazy modal mount contribution (``manifest.modalMounts``)."""

    id: str
    label: str
    entry: str
    export: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "entry": self.entry,
            "export": self.export,
        }


@dataclass(frozen=True)
class TerminalCompletionProviderDef:
    """A terminal completion provider contribution."""

    id: str
    label: str
    entry: str
    export: str
    priority: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "label": self.label,
            "entry": self.entry,
            "export": self.export,
        }
        if self.priority is not None:
            out["priority"] = self.priority
        return out


@dataclass(frozen=True)
class RoutingStrategyDef:
    """A lazy routing strategy contribution (``manifest.routingStrategies``)."""

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


@dataclass(frozen=True)
class CompactionStrategyDef:
    """A compaction-strategy contribution (``manifest.compactionStrategies``).

    Declarative only — mirrors the TS ``PluginCompactionStrategyDef``
    (``types/plugin/plugin-compaction-strategy.ts``). The strategy supplies the
    summary prompt + numeric knobs that ``resolveSendOptions`` threads into the
    sidecar; there is no executable entry point.
    """

    id: str
    label: Optional[str] = None
    summary_prompt: Optional[str] = None
    keep_recent: Optional[int] = None
    fraction: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"id": self.id}
        if self.label is not None:
            out["label"] = self.label
        if self.summary_prompt is not None:
            out["summaryPrompt"] = self.summary_prompt
        if self.keep_recent is not None:
            out["keepRecent"] = self.keep_recent
        if self.fraction is not None:
            out["fraction"] = self.fraction
        return out


@dataclass(frozen=True)
class DeploymentFilterDef:
    """A lazy deployment filter contribution (``manifest.deploymentFilters``)."""

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


@dataclass(frozen=True)
class ProtocolAdapterDef:
    """A protocol-adapter contribution (``manifest.protocolAdapters``)."""

    id: str
    label: str
    spec: Dict[str, Any]
    description: Optional[str] = None
    entry: Optional[str] = None
    export: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "label": self.label,
            "spec": dict(self.spec),
        }
        if self.description is not None:
            out["description"] = self.description
        if self.entry is not None:
            out["entry"] = self.entry
        if self.export is not None:
            out["export"] = self.export
        return out


@dataclass(frozen=True)
class ToolRouteDef:
    """Semantic tool-route examples (``manifest.toolRoutes``)."""

    tool_name: str
    utterances: List[str]
    threshold: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "toolName": self.tool_name,
            "utterances": list(self.utterances),
        }
        if self.threshold is not None:
            out["threshold"] = self.threshold
        return out


@dataclass(frozen=True)
class ContextProviderDef:
    """A lazy context-provider contribution (``manifest.contextProviders``)."""

    id: str
    entry: str
    export: str
    label: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "entry": self.entry,
            "export": self.export,
        }
        if self.label is not None:
            out["label"] = self.label
        return out


@dataclass(frozen=True)
class ContextPanelDef:
    """A renderer-side Context Workbench panel contribution.

    Backed either by a JS module (``entry`` + ``export``) or by a sandboxed
    webview (``webview`` naming an entry of the manifest's ``webviews[]``);
    exactly one of the two backings must be provided.
    """

    id: str
    resource_kinds: List[str]
    activity: str
    label_key: str
    label: str
    entry: Optional[str] = None
    export: Optional[str] = None
    webview: Optional[str] = None
    icon: Optional[str] = None
    order: Optional[int] = None
    required_capabilities: Optional[List[str]] = None
    preferred_mode: Optional[str] = None
    retention: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "resourceKinds": list(self.resource_kinds),
            "activity": self.activity,
            "labelKey": self.label_key,
            "label": self.label,
        }
        if self.entry is not None:
            out["entry"] = self.entry
        if self.export is not None:
            out["export"] = self.export
        if self.webview is not None:
            out["webview"] = self.webview
        if self.icon is not None:
            out["icon"] = self.icon
        if self.order is not None:
            out["order"] = self.order
        if self.required_capabilities is not None:
            out["requiredCapabilities"] = list(self.required_capabilities)
        if self.preferred_mode is not None:
            out["preferredMode"] = self.preferred_mode
        if self.retention is not None:
            out["retention"] = self.retention
        return out


@dataclass(frozen=True)
class SessionImporterDef:
    """A renderer-side session-source adapter factory contribution."""

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


def ensure_serializable(value: Any, context: str) -> Any:
    """Raise if ``value`` is not JSON-serialisable (mirrors host policy).

    The host rejects non-JSON results so a tool can never silently return a
    value the protocol cannot carry. Re-implemented here so standalone /
    test execution enforces the same contract.
    """
    try:
        json.dumps(value)
    except (TypeError, ValueError) as exc:
        raise TypeError(
            f"{context} returned a non-JSON-serializable value of type "
            f"{type(value).__name__}"
        ) from exc
    return value


class PluginHook(Enum):
    """Canonical plugin hook points the host dispatches. Values mirror the host
    registry `CANONICAL_HOOK_POINTS` in `lib/plugin/contracts/plugin-points.ts`
    exactly (a parity test asserts this enum equals that list). Generated /
    maintained in lockstep — add a hook here whenever one is added there."""

    ON_LOAD = "onLoad"
    ON_ENABLE = "onEnable"
    ON_DISABLE = "onDisable"
    ON_UNLOAD = "onUnload"
    ON_INSTALL = "onInstall"
    ON_UNINSTALL = "onUninstall"
    ON_UPDATE = "onUpdate"
    ON_SUSPEND = "onSuspend"
    ON_RESUME = "onResume"
    ON_CONFIG_CHANGE = "onConfigChange"
    ON_A2_UI_SURFACE_CREATE = "onA2UISurfaceCreate"
    ON_A2_UI_SURFACE_DESTROY = "onA2UISurfaceDestroy"
    ON_A2_UI_ACTION = "onA2UIAction"
    ON_A2_UI_DATA_CHANGE = "onA2UIDataChange"
    ON_AGENT_START = "onAgentStart"
    ON_AGENT_STEP = "onAgentStep"
    ON_AGENT_COMPLETE = "onAgentComplete"
    ON_AGENT_ERROR = "onAgentError"
    ON_MESSAGE_SEND = "onMessageSend"
    ON_MESSAGE_RECEIVE = "onMessageReceive"
    ON_MESSAGE_DELETE = "onMessageDelete"
    ON_MESSAGE_EDIT = "onMessageEdit"
    ON_SESSION_CREATE = "onSessionCreate"
    ON_SESSION_SWITCH = "onSessionSwitch"
    ON_SESSION_DELETE = "onSessionDelete"
    ON_SESSION_RENAME = "onSessionRename"
    ON_SESSION_CLEAR = "onSessionClear"
    ON_COMMAND = "onCommand"
    ON_CHAT_REGENERATE = "onChatRegenerate"
    ON_MODEL_SWITCH = "onModelSwitch"
    ON_CHAT_MODE_SWITCH = "onChatModeSwitch"
    ON_SYSTEM_PROMPT_CHANGE = "onSystemPromptChange"
    ON_SCHEDULED_TASK_START = "onScheduledTaskStart"
    ON_SCHEDULED_TASK_COMPLETE = "onScheduledTaskComplete"
    ON_SCHEDULED_TASK_ERROR = "onScheduledTaskError"
    ON_PROJECT_CREATE = "onProjectCreate"
    ON_PROJECT_UPDATE = "onProjectUpdate"
    ON_PROJECT_DELETE = "onProjectDelete"
    ON_PROJECT_SWITCH = "onProjectSwitch"
    ON_GOAL_CREATE = "onGoalCreate"
    ON_GOAL_UPDATE = "onGoalUpdate"
    ON_GOAL_PROGRESS = "onGoalProgress"
    ON_GOAL_COMPLETE = "onGoalComplete"
    ON_GOAL_DELETE = "onGoalDelete"
    ON_PET_INTERACT = "onPetInteract"
    ON_PET_LEVEL_UP = "onPetLevelUp"
    ON_PET_EVOLVED = "onPetEvolved"
    ON_PET_ACHIEVEMENT_UNLOCKED = "onPetAchievementUnlocked"
    ON_PET_UNWELL = "onPetUnwell"
    ON_SHARE_LINK_CREATE = "onShareLinkCreate"
    ON_SHARE_LINK_REVOKE = "onShareLinkRevoke"
    ON_KNOWLEDGE_FILE_ADD = "onKnowledgeFileAdd"
    ON_KNOWLEDGE_FILE_REMOVE = "onKnowledgeFileRemove"
    ON_SESSION_LINKED = "onSessionLinked"
    ON_SESSION_UNLINKED = "onSessionUnlinked"
    ON_CANVAS_CREATE = "onCanvasCreate"
    ON_CANVAS_UPDATE = "onCanvasUpdate"
    ON_CANVAS_DELETE = "onCanvasDelete"
    ON_CANVAS_SWITCH = "onCanvasSwitch"
    ON_CANVAS_CONTENT_CHANGE = "onCanvasContentChange"
    ON_CANVAS_VERSION_SAVE = "onCanvasVersionSave"
    ON_CANVAS_VERSION_RESTORE = "onCanvasVersionRestore"
    ON_CANVAS_SELECTION = "onCanvasSelection"
    ON_ARTIFACT_CREATE = "onArtifactCreate"
    ON_ARTIFACT_UPDATE = "onArtifactUpdate"
    ON_ARTIFACT_DELETE = "onArtifactDelete"
    ON_ARTIFACT_OPEN = "onArtifactOpen"
    ON_ARTIFACT_CLOSE = "onArtifactClose"
    ON_EXPORT_START = "onExportStart"
    ON_EXPORT_COMPLETE = "onExportComplete"
    ON_EXPORT_TRANSFORM = "onExportTransform"
    ON_PROJECT_EXPORT_START = "onProjectExportStart"
    ON_PROJECT_EXPORT_COMPLETE = "onProjectExportComplete"
    ON_BUILD_OPTIONS = "onBuildOptions"
    ON_STREAM_START = "onStreamStart"
    ON_STREAM_CHUNK = "onStreamChunk"
    ON_STREAM_END = "onStreamEnd"
    ON_CHAT_ERROR = "onChatError"
    ON_TOKEN_USAGE = "onTokenUsage"
    ON_USER_PROMPT_SUBMIT = "onUserPromptSubmit"
    ON_PRE_TOOL_USE = "onPreToolUse"
    ON_POST_TOOL_USE = "onPostToolUse"
    # DORMANT: not yet wired to a compaction trigger; registering is a silent no-op
    # (parity-only). See lib/plugin/messaging/hooks-system.ts dispatchPreCompact.
    ON_PRE_COMPACT = "onPreCompact"
    ON_POST_CHAT_RECEIVE = "onPostChatReceive"
    ON_DOCUMENTS_INDEXED = "onDocumentsIndexed"
    ON_VECTOR_SEARCH = "onVectorSearch"
    ON_RAG_CONTEXT_RETRIEVED = "onRAGContextRetrieved"
    ON_WORKFLOW_START = "onWorkflowStart"
    ON_WORKFLOW_STEP_COMPLETE = "onWorkflowStepComplete"
    ON_WORKFLOW_COMPLETE = "onWorkflowComplete"
    ON_WORKFLOW_ERROR = "onWorkflowError"
    ON_WORKFLOW_NODE_START = "onWorkflowNodeStart"
    ON_WORKFLOW_NODE_COMPLETE = "onWorkflowNodeComplete"
    ON_WORKFLOW_NODE_ERROR = "onWorkflowNodeError"
    ON_WORKFLOW_TRIGGER_FIRED = "onWorkflowTriggerFired"
    ON_SIDEBAR_TOGGLE = "onSidebarToggle"
    ON_PANEL_OPEN = "onPanelOpen"
    ON_PANEL_CLOSE = "onPanelClose"
    ON_SHORTCUT = "onShortcut"
    ON_CONTEXT_MENU_SHOW = "onContextMenuShow"
    ON_SCHEDULED_TASK_CREATE = "onScheduledTaskCreate"
    ON_SCHEDULED_TASK_UPDATE = "onScheduledTaskUpdate"
    ON_SCHEDULED_TASK_DELETE = "onScheduledTaskDelete"
    ON_SCHEDULED_TASK_PAUSE = "onScheduledTaskPause"
    ON_SCHEDULED_TASK_RESUME = "onScheduledTaskResume"
    ON_SCHEDULED_TASK_BEFORE_RUN = "onScheduledTaskBeforeRun"
    ON_EXTERNAL_AGENT_CONNECT = "onExternalAgentConnect"
    ON_EXTERNAL_AGENT_DISCONNECT = "onExternalAgentDisconnect"
    ON_EXTERNAL_AGENT_EXECUTION_START = "onExternalAgentExecutionStart"
    ON_EXTERNAL_AGENT_EXECUTION_COMPLETE = "onExternalAgentExecutionComplete"
    ON_EXTERNAL_AGENT_PERMISSION_REQUEST = "onExternalAgentPermissionRequest"
    ON_EXTERNAL_AGENT_TOOL_CALL = "onExternalAgentToolCall"
    ON_EXTERNAL_AGENT_ERROR = "onExternalAgentError"
    ON_CODE_EXECUTION_START = "onCodeExecutionStart"
    ON_CODE_EXECUTION_COMPLETE = "onCodeExecutionComplete"
    ON_CODE_EXECUTION_ERROR = "onCodeExecutionError"
    ON_MCP_SERVER_CONNECT = "onMCPServerConnect"
    ON_MCP_SERVER_DISCONNECT = "onMCPServerDisconnect"
    ON_MCP_TOOL_CALL = "onMCPToolCall"
    ON_MCP_TOOL_RESULT = "onMCPToolResult"
    ON_WORKFLOW_NODE_REGISTER = "onWorkflowNodeRegister"
    ON_WORKFLOW_NODE_UNREGISTER = "onWorkflowNodeUnregister"
    ON_WORKFLOW_TRIGGER_REGISTER = "onWorkflowTriggerRegister"
    ON_WORKFLOW_TRIGGER_UNREGISTER = "onWorkflowTriggerUnregister"
    ON_TEAM_START = "onTeamStart"
    ON_TEAM_PLAN_READY = "onTeamPlanReady"
    ON_TEAMMATE_CLAIM = "onTeammateClaim"
    ON_TEAMMATE_RELEASE = "onTeammateRelease"
    ON_TEAM_BUDGET_WARN = "onTeamBudgetWarn"
    ON_TEAM_COMPLETE = "onTeamComplete"
    ON_CONSENSUS_OPENED = "onConsensusOpened"
    ON_CONSENSUS_VOTED = "onConsensusVoted"
    ON_CONSENSUS_RESOLVED = "onConsensusResolved"
    ON_SHARED_MEMORY_WRITE = "onSharedMemoryWrite"
    ON_SHARED_MEMORY_DELETE = "onSharedMemoryDelete"
    ON_TEAM_DELEGATION_START = "onTeamDelegationStart"
    ON_TEAM_DELEGATION_COMPLETE = "onTeamDelegationComplete"
    ON_CONNECTOR_INBOUND = "onConnectorInbound"
    ON_CONNECTOR_OUTBOUND = "onConnectorOutbound"
