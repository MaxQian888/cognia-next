"""Typed manifest mirrors for the workflow / scheduler / configuration family.

Python author-facing helpers mirroring the TypeScript ``define-*`` helpers for
declarative contributions in this family:

* ``workflow-template`` → ``PluginWorkflowTemplateDef`` (manifest ``workflowTemplates``)
* ``scheduled-task``    → ``PluginScheduledTaskDef``    (manifest ``scheduledTasks``)
* ``configuration``     → ``PluginConfigSchema``        (manifest ``configSchema``)

Each helper builds a validated dataclass whose ``to_dict()`` emits the camelCase
shape the host reads from the manifest. A workflow template's ``nodes``/``edges``
graph and a scheduled task's ``trigger``/``retry`` blocks are carried as plain
dicts/lists.

Note: ``workflow-node`` / ``workflow-trigger`` / ``exporter`` / ``importer`` /
``uri-handler`` / ``tray-item`` all carry executable functions on the TypeScript
side (``execute`` / ``start`` / ``export`` / ``handle`` / ``onClick``), so they
have no declarative manifest form and are NOT mirrored here — see the
``JS_RUNTIME_ONLY`` allowlist in ``tests/test_define_parity.py``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional

# Workflow-template complexity dial.
_TEMPLATE_COMPLEXITY = frozenset({"starter", "intermediate", "advanced"})


def _require(value: str, label: str) -> None:
    if not value or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")


# -- workflow-template ------------------------------------------------------


@dataclass(frozen=True)
class WorkflowTemplate:
    """A workflow template contribution (mirrors ``PluginWorkflowTemplateDef``)."""

    id: str
    name: str
    description: str
    category: str
    nodes: List[Dict[str, Any]]
    edges: List[Dict[str, Any]]
    icon: Optional[str] = None
    complexity: Optional[str] = None
    settings: Optional[Dict[str, Any]] = None
    requires: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "category": self.category,
            "nodes": [dict(n) for n in self.nodes],
            "edges": [dict(e) for e in self.edges],
        }
        if self.icon is not None:
            out["icon"] = self.icon
        if self.complexity is not None:
            out["complexity"] = self.complexity
        if self.settings is not None:
            out["settings"] = dict(self.settings)
        if self.requires is not None:
            out["requires"] = dict(self.requires)
        return out


def define_workflow_template(
    id: str,
    name: str,
    description: str,
    category: str,
    nodes: List[Mapping[str, Any]],
    edges: List[Mapping[str, Any]],
    *,
    icon: Optional[str] = None,
    complexity: Optional[str] = None,
    settings: Optional[Mapping[str, Any]] = None,
    requires: Optional[Mapping[str, Any]] = None,
) -> WorkflowTemplate:
    """Construct a validated ``WorkflowTemplate``. ``complexity`` (if set) must
    be ``starter`` / ``intermediate`` / ``advanced``."""
    _require(id, "workflow template id")
    _require(name, "workflow template name")
    _require(description, "workflow template description")
    _require(category, "workflow template category")
    if complexity is not None and complexity not in _TEMPLATE_COMPLEXITY:
        raise ValueError(
            f"unknown complexity {complexity!r}; expected one of "
            f"{sorted(_TEMPLATE_COMPLEXITY)}"
        )
    return WorkflowTemplate(
        id=id,
        name=name,
        description=description,
        category=category,
        nodes=[dict(n) for n in nodes],
        edges=[dict(e) for e in edges],
        icon=icon,
        complexity=complexity,
        settings=dict(settings) if settings is not None else None,
        requires=dict(requires) if requires is not None else None,
    )


# -- scheduled-task ---------------------------------------------------------


@dataclass(frozen=True)
class ScheduledTask:
    """A scheduled-task contribution (mirrors ``PluginScheduledTaskDef``).

    Keyed by ``name`` (no ``id``). ``handler`` names the module-level handler
    function; ``trigger`` is the trigger configuration block.
    """

    name: str
    handler: str
    trigger: Dict[str, Any]
    description: Optional[str] = None
    default_enabled: Optional[bool] = None
    retry: Optional[Dict[str, Any]] = None
    timeout: Optional[int] = None
    tags: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "name": self.name,
            "handler": self.handler,
            "trigger": dict(self.trigger),
        }
        if self.description is not None:
            out["description"] = self.description
        if self.default_enabled is not None:
            out["defaultEnabled"] = self.default_enabled
        if self.retry is not None:
            out["retry"] = dict(self.retry)
        if self.timeout is not None:
            out["timeout"] = self.timeout
        if self.tags:
            out["tags"] = list(self.tags)
        return out


def define_scheduled_task(
    name: str,
    handler: str,
    trigger: Mapping[str, Any],
    *,
    description: Optional[str] = None,
    default_enabled: Optional[bool] = None,
    retry: Optional[Mapping[str, Any]] = None,
    timeout: Optional[int] = None,
    tags: Optional[List[str]] = None,
) -> ScheduledTask:
    """Construct a validated ``ScheduledTask``. ``name``, ``handler`` and
    ``trigger`` are required."""
    _require(name, "scheduled task name")
    _require(handler, "scheduled task handler")
    if not trigger:
        raise ValueError("scheduled task trigger must be a non-empty mapping")
    return ScheduledTask(
        name=name,
        handler=handler,
        trigger=dict(trigger),
        description=description,
        default_enabled=default_enabled,
        retry=dict(retry) if retry is not None else None,
        timeout=timeout,
        tags=list(tags or []),
    )


# -- configuration ----------------------------------------------------------


@dataclass(frozen=True)
class ConfigSchema:
    """A plugin configuration schema (mirrors ``PluginConfigSchema``).

    Always a JSON-Schema ``object``: ``properties`` maps field name → property
    descriptor; ``required`` lists mandatory field names.
    """

    properties: Dict[str, Any]
    required: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"type": "object", "properties": dict(self.properties)}
        if self.required:
            out["required"] = list(self.required)
        return out


def define_configuration(
    properties: Mapping[str, Any],
    *,
    required: Optional[List[str]] = None,
) -> ConfigSchema:
    """Construct a validated ``ConfigSchema`` (``type: "object"``).

    ``required`` names must all appear in ``properties``.
    """
    if not isinstance(properties, Mapping):
        raise ValueError("configuration properties must be a mapping")
    req = list(required or [])
    unknown = [name for name in req if name not in properties]
    if unknown:
        raise ValueError(
            f"required config fields not present in properties: {unknown}"
        )
    return ConfigSchema(properties=dict(properties), required=req)
