"""Tests for cognia.external_agent (adapters)."""

from __future__ import annotations

import pytest

import cognia
from cognia import (
    ExternalAgentAdapter,
    define_external_agent_adapter,
    register_external_agent_adapter,
)


def test_define_adapter_minimal_to_dict():
    adapter = define_external_agent_adapter(
        "demo-echo", "Demo Echo Protocol", "src/demo.js", "createDemoEchoAdapter"
    )
    assert adapter == ExternalAgentAdapter(
        id="demo-echo",
        label="Demo Echo Protocol",
        entry="src/demo.js",
        export="createDemoEchoAdapter",
    )
    assert adapter.to_dict() == {
        "id": "demo-echo",
        "label": "Demo Echo Protocol",
        "entry": "src/demo.js",
        "export": "createDemoEchoAdapter",
    }


def test_define_adapter_full_to_dict():
    adapter = define_external_agent_adapter(
        "demo-echo",
        "Demo Echo Protocol",
        "src/demo.js",
        "createDemoEchoAdapter",
        description="An echo protocol.",
    )
    assert adapter.to_dict() == {
        "id": "demo-echo",
        "label": "Demo Echo Protocol",
        "entry": "src/demo.js",
        "export": "createDemoEchoAdapter",
        "description": "An echo protocol.",
    }


@pytest.mark.parametrize(
    "args",
    [
        ("", "label", "entry", "export"),
        ("id", "", "entry", "export"),
        ("id", "label", "", "export"),
        ("id", "label", "entry", ""),
    ],
)
def test_define_adapter_requires_core_fields(args):
    with pytest.raises(ValueError):
        define_external_agent_adapter(*args)


def test_register_records_on_explicit_runtime():
    rt = cognia.Runtime()
    adapter = define_external_agent_adapter(
        "demo-echo", "Demo Echo Protocol", "src/demo.js", "createDemoEchoAdapter"
    )
    payload = register_external_agent_adapter(adapter, runtime=rt)
    assert payload == adapter.to_dict()
    assert rt.get_external_agent_adapters() == [adapter.to_dict()]


def test_register_defaults_to_active_runtime():
    cognia.reset_active_runtime()
    adapter = define_external_agent_adapter(
        "demo-echo", "Demo Echo Protocol", "src/demo.js", "createDemoEchoAdapter"
    )
    register_external_agent_adapter(adapter)
    assert cognia.get_active_runtime().get_external_agent_adapters() == [adapter.to_dict()]
