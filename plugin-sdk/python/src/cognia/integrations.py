"""Schema-v4 Marketplace Integration authoring helpers.

The Python SDK can author the same declarative Integration manifest block as
the TypeScript ``defineIntegration`` helper. Execution remains host-owned: the
desktop/headless runtime verifies ingress, resolves opaque credentials, runs
actions, and records audit.
"""

from __future__ import annotations

import re
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional

_AUTH_KINDS = frozenset({"oauth2", "api-key", "personal-access-token", "app"})
_ACTION_RISKS = frozenset({"read", "write", "destructive"})
_IDEMPOTENCY = frozenset({"required", "supported", "none"})


def _required(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    return value


def _validate_integration(definition: Mapping[str, Any]) -> None:
    _required(definition.get("id"), "integration id")
    _required(definition.get("label"), "integration label")
    if not isinstance(definition.get("resourceKinds"), list):
        raise ValueError("integration resourceKinds must be a list")
    for strategy in definition.get("authStrategies", []):
        _required(strategy.get("id"), "auth strategy id")
        _required(strategy.get("providerId"), "auth strategy providerId")
        if strategy.get("type") not in _AUTH_KINDS:
            raise ValueError(f"unknown integration auth type {strategy.get('type')!r}")
        request_auth = strategy.get("requestAuth")
        if request_auth is not None:
            if not isinstance(request_auth, Mapping):
                raise ValueError("integration requestAuth must be an object")
            auth_type = request_auth.get("type")
            valid_bearer = auth_type == "bearer"
            header_name = request_auth.get("name")
            valid_header = (
                auth_type == "header"
                and isinstance(header_name, str)
                and re.fullmatch(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+", header_name)
                is not None
                and (
                    request_auth.get("prefix") is None
                    or isinstance(request_auth.get("prefix"), str)
                )
            )
            if not valid_bearer and not valid_header:
                raise ValueError("integration requestAuth is invalid")
    for event_type in definition.get("eventTypes", []):
        _required(event_type.get("id"), "integration event type id")
        if not isinstance(event_type.get("resourceKinds"), list):
            raise ValueError("integration event resourceKinds must be a list")
    for action in definition.get("actions", []):
        _required(action.get("id"), "integration action id")
        _required(action.get("handler"), "integration action handler")
        if action.get("risk") not in _ACTION_RISKS:
            raise ValueError(f"unknown integration action risk {action.get('risk')!r}")
        if action.get("idempotency") not in _IDEMPOTENCY:
            raise ValueError(
                f"unknown integration action idempotency {action.get('idempotency')!r}"
            )
        if not isinstance(action.get("inputSchema"), Mapping):
            raise ValueError("integration action inputSchema must be an object")


@dataclass(frozen=True)
class Integration:
    """Validated declarative ``PluginIntegrationDef`` mirror."""

    id: str
    label: str
    auth_strategies: List[Dict[str, Any]]
    resource_kinds: List[str]
    event_types: List[Dict[str, Any]]
    actions: List[Dict[str, Any]]
    description: Optional[str] = None
    category: Optional[str] = None
    icon: Optional[str] = None
    inbox_projections: List[Dict[str, Any]] = field(default_factory=list)
    ingress: Optional[Dict[str, Any]] = None
    allowed_origins: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "id": self.id,
            "label": self.label,
            "authStrategies": deepcopy(self.auth_strategies),
            "resourceKinds": list(self.resource_kinds),
            "eventTypes": deepcopy(self.event_types),
            "actions": deepcopy(self.actions),
        }
        if self.description is not None:
            result["description"] = self.description
        if self.category is not None:
            result["category"] = self.category
        if self.icon is not None:
            result["icon"] = self.icon
        if self.inbox_projections:
            result["inboxProjections"] = deepcopy(self.inbox_projections)
        if self.ingress is not None:
            result["ingress"] = deepcopy(self.ingress)
        if self.allowed_origins:
            result["allowedOrigins"] = list(self.allowed_origins)
        return result


def define_integration(definition: Mapping[str, Any]) -> Integration:
    """Validate and return a schema-v4 Marketplace Integration definition."""

    _validate_integration(definition)
    return Integration(
        id=str(definition["id"]),
        label=str(definition["label"]),
        auth_strategies=deepcopy(list(definition.get("authStrategies", []))),
        resource_kinds=list(definition["resourceKinds"]),
        event_types=deepcopy(list(definition.get("eventTypes", []))),
        actions=deepcopy(list(definition.get("actions", []))),
        description=definition.get("description"),
        category=definition.get("category"),
        icon=definition.get("icon"),
        inbox_projections=deepcopy(list(definition.get("inboxProjections", []))),
        ingress=deepcopy(definition.get("ingress")),
        allowed_origins=list(definition.get("allowedOrigins", [])),
    )
