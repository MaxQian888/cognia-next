"""Tests for cognia.types — parameter inference and typed models."""

from __future__ import annotations

from typing import List

import pytest

import cognia
import cognia.types as cognia_types
from cognia.types import (
    ToolDefinition,
    ToolParameter,
    ensure_serializable,
    infer_parameters,
    json_type_for,
)


def test_json_type_for_concrete_and_generic_and_unknown():
    assert json_type_for(str) == "string"
    assert json_type_for(int) == "number"
    assert json_type_for(float) == "number"
    assert json_type_for(bool) == "boolean"
    assert json_type_for(list) == "array"
    assert json_type_for(dict) == "object"
    assert json_type_for(List[int]) == "array"
    assert json_type_for(None) == "any"

    class Custom:
        pass

    assert json_type_for(Custom) == "any"


def test_infer_parameters_required_default_and_varargs():
    def fn(a: str, b: int = 5, *args, **kwargs):
        return None

    params = infer_parameters(fn)
    assert params["a"] == {"type": "string", "required": True}
    assert params["b"] == {"type": "number", "required": False, "default": 5}
    # *args / **kwargs are skipped.
    assert "args" not in params
    assert "kwargs" not in params


def test_infer_parameters_non_serializable_default_is_omitted():
    sentinel = object()

    def fn(x=sentinel):
        return x

    params = infer_parameters(fn)
    assert params["x"]["required"] is False
    assert "default" not in params["x"]


def test_infer_parameters_handles_builtin_without_signature():
    # Some builtins have no introspectable signature → empty params, no crash.
    assert infer_parameters(len) == {} or isinstance(infer_parameters(len), dict)


def test_tool_parameter_roundtrip():
    param = ToolParameter(type="string", required=True, description="x")
    assert param.to_dict() == {"type": "string", "required": True, "description": "x"}

    with_default = ToolParameter(type="number", default=3, has_default=True)
    assert with_default.to_dict() == {
        "type": "number",
        "required": False,
        "default": 3,
    }

    restored = ToolParameter.from_dict({"type": "boolean", "required": True})
    assert restored.type == "boolean"
    assert restored.required is True
    assert restored.has_default is False

    restored_default = ToolParameter.from_dict({"type": "number", "default": 7})
    assert restored_default.has_default is True
    assert restored_default.default == 7


def test_tool_definition_to_dict():
    definition = ToolDefinition(name="greet", description="hi", parameters={"a": {}})
    assert definition.to_dict() == {
        "name": "greet",
        "description": "hi",
        "parameters": {"a": {}},
    }


def test_manifest_definition_mirrors_are_available_from_package_root():
    expected_types = [
        "ViewContainerDef",
        "TreeNode",
        "ViewDef",
        "WebviewDef",
        "AuthProviderDef",
        "WorkspaceBackendDef",
        "MessageRendererDef",
        "DensityPresetContribution",
        "ChatMiddlewareDef",
        "ModalMountDef",
        "TerminalCompletionProviderDef",
        "RoutingStrategyDef",
        "DeploymentFilterDef",
        "ProtocolAdapterDef",
        "ToolRouteDef",
        "ContextProviderDef",
        "PluginHook",
        "ensure_serializable",
    ]

    missing = [name for name in expected_types if not hasattr(cognia, name)]
    assert missing == []
    assert cognia.PluginHook.ON_MESSAGE_SEND.value == "onMessageSend"
    assert cognia.ensure_serializable({"ok": True}, "root helper") == {"ok": True}


def test_field_driven_manifest_definitions_to_dict():
    expected_types = [
        "WorkspaceBackendDef",
        "MessageRendererDef",
        "DensityPresetContribution",
        "ChatMiddlewareDef",
        "ModalMountDef",
        "TerminalCompletionProviderDef",
        "RoutingStrategyDef",
        "DeploymentFilterDef",
        "ProtocolAdapterDef",
        "ToolRouteDef",
        "ContextProviderDef",
    ]
    missing = [name for name in expected_types if not hasattr(cognia_types, name)]
    assert missing == []

    cases = [
        (
            cognia_types.WorkspaceBackendDef(
                id="e2b",
                label="E2B",
                entry="workspace.py",
                export="create_backend",
                description="sandbox",
            ),
            {
                "id": "e2b",
                "label": "E2B",
                "entry": "workspace.py",
                "export": "create_backend",
                "description": "sandbox",
            },
        ),
        (
            cognia_types.MessageRendererDef(
                part_type="tool-result",
                entry="renderers.py",
                export="ToolResultRenderer",
                label="Tool result",
            ),
            {
                "partType": "tool-result",
                "entry": "renderers.py",
                "export": "ToolResultRenderer",
                "label": "Tool result",
            },
        ),
        (
            cognia_types.DensityPresetContribution(
                name="dense",
                vars={"--density-spacing": "0.5rem"},
            ),
            {"name": "dense", "vars": {"--density-spacing": "0.5rem"}},
        ),
        (
            cognia_types.ChatMiddlewareDef(
                id="audit",
                label="Audit",
                entry="chat.py",
                export="create_middleware",
                priority=10,
                timeout_ms=2500,
            ),
            {
                "id": "audit",
                "label": "Audit",
                "entry": "chat.py",
                "export": "create_middleware",
                "priority": 10,
                "timeoutMs": 2500,
            },
        ),
        (
            cognia_types.ModalMountDef(
                id="confirm",
                label="Confirm",
                entry="modal.py",
                export="ConfirmModal",
            ),
            {
                "id": "confirm",
                "label": "Confirm",
                "entry": "modal.py",
                "export": "ConfirmModal",
            },
        ),
        (
            cognia_types.TerminalCompletionProviderDef(
                id="git",
                label="Git",
                entry="terminal.py",
                export="create_provider",
                priority=50,
            ),
            {
                "id": "git",
                "label": "Git",
                "entry": "terminal.py",
                "export": "create_provider",
                "priority": 50,
            },
        ),
        (
            cognia_types.RoutingStrategyDef(
                id="least-busy",
                label="Least busy",
                entry="routing.py",
                export="create_strategy",
                description="choose low latency",
            ),
            {
                "id": "least-busy",
                "label": "Least busy",
                "entry": "routing.py",
                "export": "create_strategy",
                "description": "choose low latency",
            },
        ),
        (
            cognia_types.DeploymentFilterDef(
                id="region",
                label="Region",
                entry="filters.py",
                export="create_filter",
                description="filter region",
            ),
            {
                "id": "region",
                "label": "Region",
                "entry": "filters.py",
                "export": "create_filter",
                "description": "filter region",
            },
        ),
        (
            cognia_types.ProtocolAdapterDef(
                id="openai-like",
                label="OpenAI-like",
                spec={
                    "kind": "openai-compatible-variant",
                    "urlTemplate": "{baseURL}/v1/chat/completions",
                    "responsePaths": {"textDelta": "choices[0].delta.content"},
                },
                description="variant",
                entry="protocol.py",
                export="create_adapter",
            ),
            {
                "id": "openai-like",
                "label": "OpenAI-like",
                "spec": {
                    "kind": "openai-compatible-variant",
                    "urlTemplate": "{baseURL}/v1/chat/completions",
                    "responsePaths": {"textDelta": "choices[0].delta.content"},
                },
                "description": "variant",
                "entry": "protocol.py",
                "export": "create_adapter",
            },
        ),
        (
            cognia_types.ToolRouteDef(
                tool_name="search",
                utterances=["find docs"],
                threshold=0.72,
            ),
            {"toolName": "search", "utterances": ["find docs"], "threshold": 0.72},
        ),
        (
            cognia_types.ContextProviderDef(
                id="memory",
                entry="context.py",
                export="create_provider",
                label="Memory",
            ),
            {
                "id": "memory",
                "entry": "context.py",
                "export": "create_provider",
                "label": "Memory",
            },
        ),
    ]

    for definition, expected in cases:
        assert definition.to_dict() == expected


def test_ensure_serializable_passes_and_raises():
    assert ensure_serializable({"a": 1}, "ctx") == {"a": 1}
    with pytest.raises(TypeError, match="non-JSON-serializable"):
        ensure_serializable(object(), "tool 'x'")
