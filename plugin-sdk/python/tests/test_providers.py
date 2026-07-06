"""Tests for cognia.providers manifest mirrors."""

from __future__ import annotations

import pytest

from cognia import (
    define_ai_provider,
    define_cli_tool,
    define_connector,
    define_lsp_server,
    define_ocr_provider,
)


# -- ai-provider ------------------------------------------------------------


def test_ai_provider_llm_and_embedding():
    llm = define_ai_provider("gpt", "GPT", "e.js", "make", "llm", models=["a", "b"])
    d = llm.to_dict()
    assert d["kind"] == "llm" and d["models"] == ["a", "b"]
    assert "dimensions" not in d
    emb = define_ai_provider("emb", "Emb", "e.js", "make", "embedding", dimensions=768, description="x")
    ed = emb.to_dict()
    assert ed["kind"] == "embedding" and ed["dimensions"] == 768 and ed["description"] == "x"


def test_ai_provider_llm_without_models():
    d = define_ai_provider("gpt", "GPT", "e.js", "make", "llm").to_dict()
    assert "models" not in d


def test_ai_provider_validations():
    with pytest.raises(ValueError, match="kind"):
        define_ai_provider("i", "l", "e", "x", "psychic")
    with pytest.raises(ValueError, match="dimensions"):
        define_ai_provider("i", "l", "e", "x", "embedding")
    with pytest.raises(ValueError):
        define_ai_provider("", "l", "e", "x", "llm")


# -- ocr-provider -----------------------------------------------------------


def test_ocr_provider_minimal_and_full():
    o = define_ocr_provider("tess", "Tesseract", "e.js", "make")
    assert o.to_dict() == {"id": "tess", "label": "Tesseract", "entry": "e.js", "export": "make"}
    full = define_ocr_provider("tess", "Tesseract", "e.js", "make", description="d")
    assert full.to_dict()["description"] == "d"


def test_ocr_provider_requires_export():
    with pytest.raises(ValueError):
        define_ocr_provider("i", "l", "e", "")


# -- lsp-server -------------------------------------------------------------


def test_lsp_server_minimal_and_full():
    s = define_lsp_server("ts", "TypeScript", ["typescript"], "typescript-language-server")
    d = s.to_dict()
    assert d == {
        "id": "ts",
        "name": "TypeScript",
        "languages": ["typescript"],
        "command": "typescript-language-server",
    }
    full = define_lsp_server(
        "ts",
        "TS",
        ["typescript"],
        "cmd",
        extensions=[".ts"],
        filenames=["tsconfig.json"],
        args=["--stdio"],
        env={"NODE_ENV": "production"},
        root_markers=["package.json"],
        exclude_root_markers=["deno.json"],
        transport="stdio",
        initialization_options={"hostInfo": "cognia"},
        settings={"typescript": {}},
        workspace_folder_required=True,
        enabled=False,
        install={"npmPackage": "typescript-language-server"},
    )
    fd = full.to_dict()
    assert fd["extensions"] == [".ts"] and fd["filenames"] == ["tsconfig.json"]
    assert fd["args"] == ["--stdio"] and fd["env"] == {"NODE_ENV": "production"}
    assert fd["rootMarkers"] == ["package.json"]
    assert fd["excludeRootMarkers"] == ["deno.json"]
    assert fd["transport"] == "stdio"
    assert fd["initializationOptions"] == {"hostInfo": "cognia"}
    assert fd["settings"] == {"typescript": {}}
    assert fd["workspaceFolderRequired"] is True and fd["enabled"] is False
    assert fd["install"] == {"npmPackage": "typescript-language-server"}


def test_lsp_server_requires_languages_and_command():
    with pytest.raises(ValueError, match="language"):
        define_lsp_server("i", "n", [], "cmd")
    with pytest.raises(ValueError, match="command"):
        define_lsp_server("i", "n", ["x"], "")


# -- cli-tool ---------------------------------------------------------------


def test_cli_tool_minimal_and_full():
    t = define_cli_tool(
        "ripgrep",
        "Search",
        {"type": "object"},
        {"kind": "requires", "program": "rg"},
        [{"kind": "param", "name": "pattern"}],
    )
    d = t.to_dict()
    assert d["name"] == "ripgrep" and d["binary"]["program"] == "rg"
    assert d["argv"] == [{"kind": "param", "name": "pattern"}]
    full = define_cli_tool(
        "rg",
        "Search",
        {"type": "object"},
        {"kind": "requires", "program": "rg"},
        ["--json"],
        stdin={"param": "text"},
        cwd={"kind": "workspace"},
        env={"RG_CONFIG": "x"},
        timeout_ms=5000,
        output_parse="lines",
        success_exit_codes=[0, 1],
        max_output_bytes=1024,
        version_arg="--version",
    )
    fd = full.to_dict()
    assert fd["stdin"] == {"param": "text"} and fd["cwd"] == {"kind": "workspace"}
    assert fd["env"] == {"RG_CONFIG": "x"} and fd["timeoutMs"] == 5000
    assert fd["outputParse"] == "lines" and fd["successExitCodes"] == [0, 1]
    assert fd["maxOutputBytes"] == 1024 and fd["versionArg"] == "--version"


def test_cli_tool_rejects_bad_output_parse():
    with pytest.raises(ValueError, match="output_parse"):
        define_cli_tool("n", "d", {}, {}, [], output_parse="binary")


# -- connector --------------------------------------------------------------


def test_connector_minimal_and_full():
    c = define_connector("telegram", "createTelegram", {"type": "object"}, ["polling"])
    assert c.to_dict() == {
        "type": "telegram",
        "factory": "createTelegram",
        "configSchema": {"type": "object"},
        "transportModes": ["polling"],
    }
    full = define_connector(
        "discord",
        "createDiscord",
        {"type": "object"},
        ["gateway"],
        default_trigger={"mode": "mention"},
    )
    assert full.to_dict()["defaultTrigger"] == {"mode": "mention"}


def test_connector_requires_transport_modes():
    with pytest.raises(ValueError, match="transport mode"):
        define_connector("t", "f", {}, [])
