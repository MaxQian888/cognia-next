"""Tests for cognia.modes."""

from __future__ import annotations

import pytest

from cognia import Mode, define_mode


def test_define_mode_minimal():
    mode = define_mode("focus", "Focus")
    assert mode == Mode(id="focus", name="Focus")
    assert mode.to_dict() == {"id": "focus", "name": "Focus"}


def test_define_mode_full_to_dict_camelcase():
    mode = define_mode(
        "deep",
        "Deep Work",
        description="No distractions",
        system_prompt="Be terse.",
        icon="brain",
        tools=["web_search"],
    )
    assert mode.to_dict() == {
        "id": "deep",
        "name": "Deep Work",
        "description": "No distractions",
        "systemPrompt": "Be terse.",
        "icon": "brain",
        "tools": ["web_search"],
    }


@pytest.mark.parametrize("bad", ["", "   "])
def test_define_mode_requires_id_and_name(bad):
    with pytest.raises(ValueError, match="id"):
        define_mode(bad, "ok")
    with pytest.raises(ValueError, match="name"):
        define_mode("ok", bad)
