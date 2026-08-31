"""Parity: every TS ``define-*`` helper is accounted for on the Python side.

The TypeScript SDK (``packages/plugin-sdk/src/define/define-*.ts``) is the source
of truth for author-facing contribution helpers. Each one must either have a
Python mirror (a ``define_*`` helper or a typed ``*Def`` dataclass in the
``cognia`` package) or be explicitly listed in ``JS_RUNTIME_ONLY`` with a reason.

An unaccounted-for slug fails the test — so a future TS ``define-*`` forces a
deliberate Python decision (mirror it, or allowlist it) instead of drifting
silently. Skips when the repo TS ``define/`` dir is not reachable (standalone
SDK checkout).
"""

from __future__ import annotations

from pathlib import Path

import pytest

import cognia

_DEFINE_REL = Path("packages/plugin-sdk/src/define")

# TS define-* slugs whose contribution is a runtime JS object carrying an
# executable function (execute / run / start / export / handle / onClick /
# fetch-read-write methods). These have NO declarative manifest form a pure /
# hybrid Python plugin can construct, so they are intentionally not mirrored.
JS_RUNTIME_ONLY: dict[str, str] = {
    "plugin": "carries JavaScript activate/deactivate callbacks in a PluginDefinition",
    "plugin-tool": "carries a JavaScript execute() callback for ctx.agent.registerTool()",
    "extension": "loads a React component from extensions[].entry",
    "tool-renderer": "loads a React component from toolRenderers[].entry",
    "agent-tool": "carries an execute() function (ctx.agent.run tool)",
    "guardrail": "carries a run() tripwire function",
    "workflow-node": "carries an execute() node function",
    "workflow-trigger": "carries a start() subscription function",
    "exporter": "carries an export() transform function",
    "importer": "carries an import() transform function",
    "chat-importer": "carries detect() and async parse() functions for the host chat-import pipeline",
    "uri-handler": "carries a handle() deep-link function",
    "tray-item": "carries an onClick() function (PluginTrayItemInput)",
    "balance-adapter": "runtime adapter object with fetch methods",
    "limits-source": "runtime adapter object with fetch methods",
    "im-rate-source": "runtime adapter object with fetch methods",
    "shared-memory-adapter": "runtime object with write/read/listChanges methods",
}

# TS define-* slug → the Python symbol name that mirrors it (a define_* helper
# or a typed *Def dataclass exported from `cognia`).
PYTHON_MIRRORS: dict[str, str] = {
    # a2ui / modes / tool (core)
    "a2ui-component": "define_component",
    "a2ui-template": "define_template",
    "mode": "define_mode",
    "tool": "tool",
    # typed manifest dataclasses already living in cognia.types
    "auth-provider": "AuthProviderDef",
    "chat-middleware": "ChatMiddlewareDef",
    "compaction-strategy": "CompactionStrategyDef",
    "context-provider": "ContextProviderDef",
    "context-panel": "ContextPanelDef",
    "density-preset": "DensityPresetContribution",
    "deployment-filter": "DeploymentFilterDef",
    "message-renderer": "MessageRendererDef",
    "modal-mount": "ModalMountDef",
    "protocol-adapter": "ProtocolAdapterDef",
    "routing-strategy": "RoutingStrategyDef",
    "terminal-completion": "TerminalCompletionProviderDef",
    "tool-route": "ToolRouteDef",
    "view": "ViewDef",
    "view-container": "ViewContainerDef",
    "webview": "WebviewDef",
    "workspace-backend": "WorkspaceBackendDef",
    "session-importer": "SessionImporterDef",
    # external-agent (merged into cognia)
    "external-agent-preset": "define_external_agent_preset",
    "external-agent-adapter": "define_external_agent_adapter",
    # agent / skills / command family
    "skill": "define_skill",
    "subagent": "define_subagent",
    "agent-team-template": "define_agent_team_template",
    "character-pack": "define_character_pack",
    "native-anthropic-tool": "define_native_anthropic_tool",
    "mcp-server-preset": "define_mcp_server_preset",
    "command": "define_command",
    "quick-action": "define_quick_action",
    # provider / language-server family
    "ai-provider": "define_ai_provider",
    "ocr-provider": "define_ocr_provider",
    "lsp-server": "define_lsp_server",
    "cli-tool": "define_cli_tool",
    "connector": "define_connector",
    "integration": "define_integration",
    # workflow / scheduler / configuration family
    "workflow-template": "define_workflow_template",
    "scheduled-task": "define_scheduled_task",
    "configuration": "define_configuration",
    # appearance family
    "theme": "define_theme",
    "theme-pack": "define_theme_pack",
    "font-contribution": "define_font_contribution",
    "wallpaper": "define_wallpaper",
    # desktop-pet family
    "pet-item": "define_pet_item",
    "pet-achievement": "define_pet_achievement",
}


def _repo_root() -> Path | None:
    for parent in Path(__file__).resolve().parents:
        if (parent / _DEFINE_REL).is_dir():
            return parent
    return None


def _ts_define_slugs(define_dir: Path) -> set[str]:
    slugs = set()
    for path in define_dir.glob("define-*.ts"):
        if path.name.endswith(".test.ts"):
            continue
        slugs.add(path.stem[len("define-") :])
    return slugs


def test_every_ts_define_is_mirrored_or_allowlisted():
    root = _repo_root()
    if root is None:
        pytest.skip("repo define/ dir not reachable from the SDK directory")
    slugs = _ts_define_slugs(root / _DEFINE_REL)
    assert slugs, "no define-*.ts files discovered"

    accounted = set(PYTHON_MIRRORS) | set(JS_RUNTIME_ONLY)
    unaccounted = sorted(slugs - accounted)
    assert not unaccounted, (
        "TS define-* helpers with no Python mirror and no JS_RUNTIME_ONLY entry: "
        f"{unaccounted}. Add a cognia mirror or allowlist them with a reason."
    )

    # Guard against a stale mapping drifting away from the TS source.
    stale = sorted(accounted - slugs)
    assert not stale, f"mapping references define-* that no longer exist in TS: {stale}"

    # A mirrored slug's Python symbol must actually be importable from cognia.
    for slug, symbol in PYTHON_MIRRORS.items():
        assert hasattr(cognia, symbol), f"cognia.{symbol} (for {slug}) is not exported"


def test_mirror_and_allowlist_are_disjoint():
    overlap = set(PYTHON_MIRRORS) & set(JS_RUNTIME_ONLY)
    assert not overlap, f"slug in both PYTHON_MIRRORS and JS_RUNTIME_ONLY: {sorted(overlap)}"
