"""Tests for cognia.external_agent (presets)."""

from __future__ import annotations

import pytest

import cognia
from cognia import (
    ExternalAgentPreset,
    define_external_agent_preset,
    register_external_agent_preset,
)


def test_define_preset_minimal_to_dict():
    preset = define_external_agent_preset("codex", "Codex", "codex")
    assert preset == ExternalAgentPreset(id="codex", name="Codex", command="codex")
    assert preset.to_dict() == {
        "id": "codex",
        "name": "Codex",
        "command": "codex",
        "transport": "stdio",
    }


def test_define_preset_full_to_dict():
    preset = define_external_agent_preset(
        "claude-code",
        "Claude Code",
        "claude",
        args=["--acp"],
        env={"KEY": "v"},
        transport="acp",
        description="Anthropic CLI",
        cwd="/work",
    )
    assert preset.to_dict() == {
        "id": "claude-code",
        "name": "Claude Code",
        "command": "claude",
        "transport": "acp",
        "args": ["--acp"],
        "env": {"KEY": "v"},
        "description": "Anthropic CLI",
        "cwd": "/work",
    }


@pytest.mark.parametrize(
    "args",
    [
        ("", "name", "cmd"),
        ("id", "", "cmd"),
        ("id", "name", ""),
    ],
)
def test_define_preset_requires_core_fields(args):
    with pytest.raises(ValueError):
        define_external_agent_preset(*args)


def test_define_preset_rejects_unknown_transport():
    with pytest.raises(ValueError, match="transport"):
        define_external_agent_preset("id", "name", "cmd", transport="carrier-pigeon")


def test_register_records_on_explicit_runtime():
    rt = cognia.Runtime()
    preset = define_external_agent_preset("codex", "Codex", "codex")
    payload = register_external_agent_preset(preset, runtime=rt)
    assert payload == preset.to_dict()
    assert rt.get_external_agent_presets() == [preset.to_dict()]


def test_register_defaults_to_active_runtime():
    preset = define_external_agent_preset("cursor", "Cursor", "cursor")
    register_external_agent_preset(preset)
    assert cognia.get_active_runtime().get_external_agent_presets() == [preset.to_dict()]
