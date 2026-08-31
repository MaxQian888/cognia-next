"""Tests for cognia.agent manifest mirrors."""

from __future__ import annotations

import pytest

from cognia import (
    CHARACTER_PACK_SOFT_LIMIT,
    define_agent_team_template,
    define_character_pack,
    define_command,
    define_mcp_server_preset,
    define_native_anthropic_tool,
    define_quick_action,
    define_skill,
    define_subagent,
)


# -- skill ------------------------------------------------------------------


def test_skill_minimal_and_full():
    s = define_skill("code-review", "Code Review", "Reviews code", {"kind": "inline", "markdown": "# x"})
    assert s.to_dict() == {
        "id": "code-review",
        "name": "Code Review",
        "description": "Reviews code",
        "source": {"kind": "inline", "markdown": "# x"},
    }
    full = define_skill(
        "s",
        "S",
        "d",
        {"kind": "local-folder", "path": "./s"},
        scope="team",
        attach_to_character_ids=["c1"],
        allowed_tools=["Read"],
    )
    assert full.to_dict()["scope"] == "team"
    assert full.to_dict()["attachToCharacterIds"] == ["c1"]
    assert full.to_dict()["allowedTools"] == ["Read"]


@pytest.mark.parametrize(
    "kwargs",
    [
        {"id": "", "name": "n", "description": "d", "source": {"kind": "inline"}},
        {"id": "i", "name": "", "description": "d", "source": {"kind": "inline"}},
        {"id": "i", "name": "n", "description": "", "source": {"kind": "inline"}},
    ],
)
def test_skill_requires_core_fields(kwargs):
    with pytest.raises(ValueError):
        define_skill(**kwargs)


def test_skill_rejects_bad_source():
    with pytest.raises(ValueError, match="source"):
        define_skill("i", "n", "d", {})
    with pytest.raises(ValueError, match="kind"):
        define_skill("i", "n", "d", {"kind": "carrier-pigeon"})


# -- subagent ---------------------------------------------------------------


def test_subagent_minimal_and_full():
    s = define_subagent("rev", "Reviewer", "Reviews", "You are a reviewer")
    assert s.to_dict() == {
        "id": "rev",
        "name": "Reviewer",
        "description": "Reviews",
        "prompt": "You are a reviewer",
    }
    full = define_subagent(
        "rev",
        "Reviewer",
        "Reviews",
        "prompt",
        tools=["Read"],
        disallowed_tools=["Bash"],
        model="sonnet",
        provider="anthropic",
        max_turns=5,
        effort="high",
        external_preset_id="claude-code",
        allow_nesting=False,
        max_depth=2,
    )
    d = full.to_dict()
    assert d["tools"] == ["Read"] and d["disallowedTools"] == ["Bash"]
    assert d["model"] == "sonnet" and d["provider"] == "anthropic"
    assert d["maxTurns"] == 5 and d["effort"] == "high"
    assert d["externalPresetId"] == "claude-code"
    assert d["allowNesting"] is False and d["maxDepth"] == 2


def test_subagent_rejects_bad_effort():
    with pytest.raises(ValueError, match="effort"):
        define_subagent("i", "n", "d", "p", effort="ultra")


def test_subagent_requires_prompt():
    with pytest.raises(ValueError):
        define_subagent("i", "n", "d", "")


# -- agent-team-template ----------------------------------------------------


def test_agent_team_template_minimal_and_full():
    t = define_agent_team_template("t", "T", "d", "review", [{"name": "a", "description": "b"}])
    d = t.to_dict()
    assert d["category"] == "review"
    assert d["teammates"] == [{"name": "a", "description": "b"}]
    assert "taskTemplates" not in d
    full = define_agent_team_template(
        "t",
        "T",
        "d",
        "research",
        [{"name": "a", "description": "b"}],
        task_templates=[{"title": "x", "description": "y", "priority": "high"}],
        config={"maxConcurrency": 2},
        icon="Users",
        requires={"skillIds": ["p:s"]},
    )
    fd = full.to_dict()
    assert fd["taskTemplates"][0]["title"] == "x"
    assert fd["config"] == {"maxConcurrency": 2}
    assert fd["icon"] == "Users" and fd["requires"] == {"skillIds": ["p:s"]}


def test_agent_team_template_rejects_bad_category_and_empty_teammates():
    with pytest.raises(ValueError, match="category"):
        define_agent_team_template("t", "T", "d", "nonsense", [{"name": "a", "description": "b"}])
    with pytest.raises(ValueError, match="teammate"):
        define_agent_team_template("t", "T", "d", "review", [])


# -- character-pack ---------------------------------------------------------


def test_character_pack_minimal_and_full():
    p = define_character_pack("wp", "Workplace", "1.0.0", [{"localId": "alice", "name": "Alice"}])
    d = p.to_dict()
    assert d["version"] == "1.0.0"
    assert d["characters"][0]["localId"] == "alice"
    full = define_character_pack(
        "wp",
        "Workplace",
        "1.0.0",
        [{"localId": "a", "name": "A"}],
        description="desc",
        requires={"skills": ["s"]},
        icon={"emoji": "🧑", "color": "#fff"},
        tags=["office"],
    )
    fd = full.to_dict()
    assert fd["description"] == "desc" and fd["requires"] == {"skills": ["s"]}
    assert fd["icon"]["emoji"] == "🧑" and fd["tags"] == ["office"]


def test_character_pack_validations():
    with pytest.raises(ValueError, match="at least one"):
        define_character_pack("wp", "W", "1.0.0", [])
    with pytest.raises(ValueError, match="duplicate"):
        define_character_pack(
            "wp", "W", "1.0.0", [{"localId": "a"}, {"localId": "a"}]
        )
    too_many = [{"localId": f"c{i}"} for i in range(CHARACTER_PACK_SOFT_LIMIT + 1)]
    with pytest.raises(ValueError, match="soft"):
        define_character_pack("wp", "W", "1.0.0", too_many)


# -- native-anthropic-tool --------------------------------------------------


def test_native_tool_minimal_and_full():
    t = define_native_anthropic_tool("computer", "computer", "computer_20251124", {"invoke": "cmd"})
    assert t.to_dict() == {
        "id": "computer",
        "name": "computer",
        "type": "computer_20251124",
        "executeIpc": {"invoke": "cmd"},
    }
    full = define_native_anthropic_tool(
        "computer",
        "computer",
        "computer_20251124",
        {"invoke": "cmd"},
        beta_header="computer-use-2025",
        display_width_px=1280,
        display_height_px=800,
        display_number=1,
        enable_zoom=True,
        permission_policy="session-allow",
    )
    d = full.to_dict()
    assert d["betaHeader"] == "computer-use-2025"
    assert d["displayWidthPx"] == 1280 and d["displayHeightPx"] == 800
    assert d["displayNumber"] == 1 and d["enableZoom"] is True
    assert d["permissionPolicy"] == "session-allow"


def test_native_tool_requires_invoke():
    with pytest.raises(ValueError, match="invoke"):
        define_native_anthropic_tool("i", "n", "computer_20251124", {})


# -- mcp-server-preset ------------------------------------------------------


def test_mcp_preset_minimal_and_full():
    m = define_mcp_server_preset("pw", "Playwright", "stdio", {"command": "npx"})
    assert m.to_dict() == {
        "id": "pw",
        "name": "Playwright",
        "transport": "stdio",
        "config": {"command": "npx"},
    }
    full = define_mcp_server_preset(
        "pw",
        "Playwright",
        "http",
        {"url": "http://x"},
        description="d",
        icon="🎭",
        fields=[{"key": "URL"}],
        runtime="both",
        docs_url="http://docs",
        tags=["web"],
    )
    d = full.to_dict()
    assert d["description"] == "d" and d["icon"] == "🎭"
    assert d["fields"] == [{"key": "URL"}] and d["runtime"] == "both"
    assert d["docsUrl"] == "http://docs" and d["tags"] == ["web"]


def test_mcp_preset_rejects_bad_transport_and_runtime():
    with pytest.raises(ValueError, match="transport"):
        define_mcp_server_preset("i", "n", "carrier", {})
    with pytest.raises(ValueError, match="runtime"):
        define_mcp_server_preset("i", "n", "stdio", {}, runtime="quantum")


# -- command ----------------------------------------------------------------


def test_command_minimal_and_full():
    c = define_command("do", "Do")
    assert c.to_dict() == {"id": "do", "name": "Do"}
    full = define_command("do", "Do", description="d", icon="Play", aliases=["/do"])
    d = full.to_dict()
    assert d["description"] == "d" and d["icon"] == "Play" and d["aliases"] == ["/do"]


def test_command_requires_core():
    with pytest.raises(ValueError):
        define_command("", "n")


# -- quick-action -----------------------------------------------------------


def test_quick_action_command_and_slash():
    a = define_quick_action("qa", "Quick", command="my.command")
    assert a.to_dict() == {"id": "qa", "title": "Quick", "command": "my.command"}
    b = define_quick_action(
        "qa",
        "Quick",
        description="d",
        icon="Zap",
        category="plugins",
        when="chat",
        accelerator="Ctrl+K",
        slash="/quick",
        surfaces=["palette", "tray"],
    )
    d = b.to_dict()
    assert d["slash"] == "/quick" and d["surfaces"] == ["palette", "tray"]
    assert d["when"] == "chat" and d["accelerator"] == "Ctrl+K"


def test_quick_action_requires_dispatch_target():
    with pytest.raises(ValueError, match="dispatch target"):
        define_quick_action("qa", "Quick")


def test_quick_action_selection_surface_requires_a_valid_selection_contract():
    action = define_quick_action(
        "rewrite",
        "Rewrite",
        command="rewrite.command",
        surfaces=["selection"],
        selection={
            "input": "text",
            "output": "preview",
            "origins": ["accessibility"],
            "contentTypes": ["code"],
            "maxChars": 4000,
        },
    )
    assert action.to_dict()["selection"]["input"] == "text"
    with pytest.raises(ValueError, match="selection contract"):
        define_quick_action(
            "broken", "Broken", command="broken", surfaces=["selection"]
        )
    with pytest.raises(ValueError, match="selection surface"):
        define_quick_action(
            "hidden",
            "Hidden",
            command="hidden",
            selection={"input": "metadata", "output": "status"},
        )
