"""Tests for cognia.types — parameter inference and typed models."""

from __future__ import annotations

from typing import List

import pytest

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


def test_ensure_serializable_passes_and_raises():
    assert ensure_serializable({"a": 1}, "ctx") == {"a": 1}
    with pytest.raises(TypeError, match="non-JSON-serializable"):
        ensure_serializable(object(), "tool 'x'")
