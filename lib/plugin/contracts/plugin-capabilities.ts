import type { PluginCapability } from "@/types/plugin"
import type { PluginPointGovernanceMode } from "./plugin-points"

export type PluginCapabilitySupport = "supported" | "partial" | "experimental" | "blocked"

export interface PluginCapabilityContract {
  id: PluginCapability
  support: PluginCapabilitySupport
  manifestFields: readonly string[]
  runtimeBinding: string
  hostBindings: readonly string[]
  typescriptSdk: readonly string[]
  pythonSdk: readonly string[]
  builtinContributionPaths?: readonly string[]
  docs: string
  requiredTests: readonly string[]
}

export type PluginContractProofStatus = "verified" | "missing_proof" | "not_applicable"

export interface PluginCapabilityProofAudit {
  id: PluginCapability
  support: PluginCapabilitySupport
  runtimeBinding: string
  hostBindings: readonly string[]
  typescriptSdk: readonly string[]
  pythonSdk: readonly string[]
  builtinContributionPaths: readonly string[]
  docs: string
  requiredTests: readonly string[]
  missingFields: Array<
    | "runtimeBinding"
    | "hostBindings"
    | "typescriptSdk"
    | "pythonSdk"
    | "builtinContributionPaths"
    | "docs"
    | "requiredTests"
  >
  proofStatus: PluginContractProofStatus
}

export interface PluginCapabilityDiagnostic {
  code:
    | "plugin.capability.unknown"
    | "plugin.capability.partial"
    | "plugin.capability.experimental"
    | "plugin.capability.blocked"
  severity: "warning" | "error"
  capability: string
  message: string
  hint?: string
  contract?: PluginCapabilityContract
}

export interface PluginCapabilityValidationOutcome {
  allowed: boolean
  diagnostics: PluginCapabilityDiagnostic[]
}

export const PLUGIN_CAPABILITY_CONTRACTS: readonly PluginCapabilityContract[] = [
  {
    id: "tools",
    support: "supported",
    manifestFields: ["tools"],
    runtimeBinding: "context.agent.registerTool + PluginRegistry tools",
    hostBindings: ["lib/plugin/core/registry.ts", "lib/plugin/bridge/tools-bridge.ts"],
    typescriptSdk: [
      "plugin-sdk/typescript/src/helpers/tool.ts",
      "plugin-sdk/typescript/src/tools/types.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/plugin.py", "plugin-sdk/python/src/cognia/types.py"],
    builtinContributionPaths: [
      "plugins/ai-tools/src/index.ts",
      "plugins/clipboard-tools/src/index.ts",
      "plugins/docker-tools/src/index.ts",
      "plugins/git-tools/src/index.ts",
      "plugins/notification-tools/src/index.ts",
      "plugins/shell-tools/src/index.ts",
      "plugins/time-tools/src/index.ts",
      "plugins/web-tools/src/index.ts",
      "plugins/workspace-tools/src/index.ts",
    ],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: [
      "lib/plugin/core/manager.test.ts",
      "lib/plugin/package/marketplace-install-descriptor.test.ts",
    ],
  },
  {
    id: "components",
    support: "supported",
    manifestFields: ["a2uiComponents"],
    runtimeBinding: "context.a2ui.registerComponent + Plugin A2UI bridge",
    hostBindings: ["lib/plugin/bridge/a2ui-bridge.ts", "lib/plugin/core/registry.ts"],
    typescriptSdk: [
      "plugin-sdk/typescript/src/a2ui/types.ts",
      "plugin-sdk/typescript/src/context/extended.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/a2ui.py", "plugin-sdk/python/src/cognia/context.py"],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: ["stores/plugin/plugin-store.test.ts"],
  },
  {
    id: "modes",
    support: "supported",
    manifestFields: ["modes"],
    runtimeBinding: "PluginRegistry modes",
    hostBindings: ["lib/plugin/core/registry.ts", "lib/plugin/bridge/agent-integration.ts"],
    typescriptSdk: [
      "plugin-sdk/typescript/src/modes/index.ts",
      "plugin-sdk/typescript/src/modes/types.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/modes.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: ["lib/plugin/core/manager.test.ts"],
  },
  {
    // Plugin-first Computer Use plan (M1·T4). Unblocked from the previous
    // support: "blocked" — host runtime binding lives in
    // `lib/plugin/registries/skill-registry.ts` (M1·T3). Plugins declare
    // skills via `manifest.skills`; the plugin manager registers each into
    // the overlay on enable and unregisters on disable. Consumed by
    // `build-options.ts` (local-folder / inline skills render into
    // `appendSystemPrompt`; anthropic-managed skills become
    // `container.skill_id` on the sidecar request — M4).
    id: "skills",
    support: "supported",
    manifestFields: ["skills"],
    runtimeBinding:
      "context.agent.registerSkill + skill-registry overlay + container.skill_id passthrough",
    hostBindings: [
      "lib/plugin/registries/skill-registry.ts",
      "lib/claude/build-options.ts",
      "sidecar/dispatch/anthropic.mjs",
    ],
    typescriptSdk: [
      "plugin-sdk/typescript/src/api/skill.ts",
      "plugin-sdk/typescript/src/context/extended.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    builtinContributionPaths: ["plugins/anthropic-skills/src/index.ts"],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: ["lib/plugin/registries/skill-registry.test.ts"],
  },
  {
    id: "media",
    support: "supported",
    manifestFields: ["capabilities"],
    runtimeBinding: "context.media + AI-backed media helpers",
    hostBindings: ["lib/plugin/api/media-api.ts", "lib/plugin/core/context.ts"],
    typescriptSdk: [
      "plugin-sdk/typescript/src/context/extended.ts",
      "plugin-sdk/typescript/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: ["lib/plugin/api/media-api.test.ts"],
  },
  {
    id: "canvas",
    support: "supported",
    manifestFields: ["capabilities"],
    runtimeBinding: "context.canvas + active editor selection bridge",
    hostBindings: ["lib/plugin/api/canvas-api.ts", "lib/plugin/core/context.ts"],
    typescriptSdk: [
      "plugin-sdk/typescript/src/context/extended.ts",
      "plugin-sdk/typescript/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: ["lib/plugin/api/canvas-api.test.ts"],
  },
  {
    id: "ai-provider",
    support: "supported",
    manifestFields: ["capabilities"],
    runtimeBinding: "context.ai + built-in provider fallback",
    hostBindings: ["lib/plugin/api/ai-provider-api.ts", "lib/plugin/core/context.ts"],
    typescriptSdk: [
      "plugin-sdk/typescript/src/context/extended.ts",
      "plugin-sdk/typescript/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: ["lib/plugin/api/ai-provider-api.test.ts"],
  },
  {
    id: "themes",
    support: "partial",
    manifestFields: [],
    runtimeBinding: "Theme API surface exists without full extension lifecycle parity",
    hostBindings: ["lib/plugin/api/theme-api.ts"],
    typescriptSdk: [
      "plugin-sdk/typescript/src/api/ui.ts",
      "plugin-sdk/typescript/src/context/extended.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: ["lib/plugin/core/validation.test.ts"],
  },
  {
    id: "commands",
    support: "supported",
    manifestFields: ["commands"],
    runtimeBinding: "PluginRegistry commands + slash command registry",
    hostBindings: ["lib/plugin/core/manager.ts", "lib/chat/slash-command-registry.ts"],
    typescriptSdk: [
      "plugin-sdk/typescript/src/commands/index.ts",
      "plugin-sdk/typescript/src/commands/types.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/plugin.py", "plugin-sdk/python/src/cognia/types.py"],
    builtinContributionPaths: [
      "plugins/ai-tools/src/commands/index.ts",
      "plugins/clipboard-tools/src/index.ts",
      "plugins/docker-tools/src/index.ts",
      "plugins/git-tools/src/index.ts",
      "plugins/notification-tools/src/index.ts",
      "plugins/shell-tools/src/index.ts",
      "plugins/time-tools/src/index.ts",
      "plugins/web-tools/src/index.ts",
      "plugins/workspace-tools/src/index.ts",
    ],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: ["lib/plugin/core/manager.test.ts"],
  },
  {
    id: "hooks",
    support: "supported",
    manifestFields: [],
    runtimeBinding: "PluginLifecycleHooks + hooks-system",
    hostBindings: ["lib/plugin/messaging/hooks-system.ts", "lib/plugin/contracts/plugin-points.ts"],
    typescriptSdk: [
      "plugin-sdk/typescript/src/hooks/base.ts",
      "plugin-sdk/typescript/src/hooks/extended.ts",
    ],
    pythonSdk: [
      "plugin-sdk/python/src/cognia/decorators.py",
      "plugin-sdk/python/src/cognia/types.py",
    ],
    builtinContributionPaths: [
      "plugins/ai-tools/src/index.ts",
      "plugins/clipboard-tools/src/index.ts",
      "plugins/docker-tools/src/index.ts",
      "plugins/git-tools/src/index.ts",
      "plugins/notification-tools/src/index.ts",
      "plugins/shell-tools/src/index.ts",
      "plugins/time-tools/src/index.ts",
      "plugins/web-tools/src/index.ts",
      "plugins/workspace-tools/src/index.ts",
    ],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: ["lib/plugin/core/manager.test.ts"],
  },
  {
    id: "processors",
    support: "experimental",
    manifestFields: [],
    runtimeBinding: "No stable processor pipeline contract yet",
    hostBindings: ["lib/plugin/contracts/plugin-capabilities.ts"],
    typescriptSdk: ["plugin-sdk/typescript/cli/commands/capability-contract.ts"],
    pythonSdk: ["plugin-sdk/python/src/cognia/capability_contract.py"],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: ["lib/plugin/core/validation.test.ts"],
  },
  {
    id: "providers",
    support: "experimental",
    manifestFields: [],
    runtimeBinding: "Provider extension integration is not production-ready",
    hostBindings: ["lib/plugin/api/ai-provider-api.ts"],
    typescriptSdk: [
      "plugin-sdk/typescript/src/api/index.ts",
      "plugin-sdk/typescript/src/context/extended.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: ["lib/plugin/core/validation.test.ts"],
  },
  {
    id: "exporters",
    support: "partial",
    manifestFields: [],
    runtimeBinding: "Export API exists without full package/runtime parity",
    hostBindings: ["lib/plugin/api/export-api.ts"],
    typescriptSdk: [
      "plugin-sdk/typescript/src/context/extended.ts",
      "plugin-sdk/typescript/src/api/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: ["lib/plugin/core/validation.test.ts"],
  },
  {
    id: "importers",
    support: "partial",
    manifestFields: [],
    runtimeBinding: "Import API exists without full package/runtime parity",
    hostBindings: ["lib/plugin/core/manager.ts", "lib/plugin/package/marketplace.ts"],
    typescriptSdk: [
      "plugin-sdk/typescript/src/context/extended.ts",
      "plugin-sdk/typescript/src/api/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: ["lib/plugin/core/validation.test.ts"],
  },
  {
    id: "a2ui",
    support: "supported",
    manifestFields: ["a2uiComponents", "a2uiTemplates"],
    runtimeBinding: "Plugin A2UI bridge",
    hostBindings: ["lib/plugin/bridge/a2ui-bridge.ts", "lib/plugin/core/manager.ts"],
    typescriptSdk: [
      "plugin-sdk/typescript/src/a2ui/index.ts",
      "plugin-sdk/typescript/src/context/extended.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/a2ui.py", "plugin-sdk/python/src/cognia/context.py"],
    docs: "docs/features/plugin-development.md#a2ui-integration",
    requiredTests: ["stores/plugin/plugin-store.test.ts"],
  },
  {
    id: "python",
    support: "supported",
    manifestFields: ["pythonMain", "pythonDependencies"],
    runtimeBinding: "PyO3/Tauri python runtime",
    hostBindings: ["src-tauri/src/commands/extensions/plugin.rs", "lib/plugin/core/manager.ts"],
    typescriptSdk: ["plugin-sdk/typescript/src/context/base.ts"],
    pythonSdk: [
      "plugin-sdk/python/src/cognia/runtime.py",
      "plugin-sdk/python/src/cognia/plugin.py",
    ],
    docs: "docs/features/plugin-development.md#plugin-types",
    requiredTests: ["lib/plugin/core/manager.test.ts"],
  },
  {
    id: "scheduler",
    support: "supported",
    manifestFields: ["scheduledTasks"],
    runtimeBinding: "Plugin scheduler executor",
    hostBindings: [
      "lib/plugin/scheduler/scheduler-plugin-executor.ts",
      "lib/plugin/core/manager.ts",
    ],
    typescriptSdk: [
      "plugin-sdk/typescript/src/api/scheduler.ts",
      "plugin-sdk/typescript/src/context/extended.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: ["plugin-sdk/typescript/src/manifest/types.test.ts"],
  },
  {
    // cognia-next-specific extension. Plugins declaring this capability
    // contribute external-agent presets (Claude Code, Codex, Gemini CLI,
    // Cursor, Windsurf, …) that flow into the existing
    // `EXTERNAL_AGENT_PRESETS` registry via the §A-3 runtime overlay. The
    // plugin's manifest carries an `externalAgentPresets` array; the plugin
    // manager calls `presets.registerPreset(id, config, {pluginId})` on
    // enable and `unregisterPresetsByPlugin(pluginId)` on disable.
    id: "external-agent-preset",
    support: "supported",
    manifestFields: ["externalAgentPresets"],
    runtimeBinding: "context.agent.registerExternalAgentPreset + presets.registerPreset overlay",
    hostBindings: [
      "lib/ai/agent/external/presets.ts",
      "lib/plugin/bridge/agent-integration.ts",
      "components/agent/external-agent-manager.tsx",
    ],
    typescriptSdk: [
      "plugin-sdk/typescript/src/api/external-agent-preset.ts",
      "plugin-sdk/typescript/src/context/extended.ts",
    ],
    pythonSdk: [
      // Python plugins can declare external-agent presets through the same
      // manifest schema; the SDK helper is a thin pass-through to the Tauri
      // command that mirrors the contribution into the runtime overlay.
      "plugin-sdk/python/src/cognia_next/external_agent_presets.py",
    ],
    builtinContributionPaths: [
      "plugins/claude-code-agent/src/index.ts",
      "plugins/codex-agent/src/index.ts",
      "plugins/gemini-cli-agent/src/index.ts",
      "plugins/cursor-agent/src/index.ts",
      "plugins/windsurf-agent/src/index.ts",
    ],
    docs: "docs/content/docs/plugins/external-agents.mdx",
    requiredTests: ["lib/ai/agent/external/presets.test.ts"],
  },
  {
    // Plugin-first Computer Use plan (M1·T4). Plugins declaring this
    // capability contribute MCP server presets (Playwright MCP, Stagehand
    // MCP, E2B sandbox, …) that flow into the dynamic overlay at
    // `lib/plugin/registries/mcp-server-preset-registry.ts`. The plugin's
    // manifest carries an `mcpServerPresets` array; the plugin manager
    // calls `registerMcpServerPreset(id, def, {pluginId})` on enable and
    // `unregisterMcpServerPresetsByPlugin(pluginId)` on disable.
    // Downstream consumers (M3 `lib/claude/mcp-presets.ts`) merge the
    // overlay with the static MCP_PRESETS table.
    id: "mcp-server-preset",
    support: "supported",
    manifestFields: ["mcpServerPresets"],
    runtimeBinding: "context.agent.registerMcpServerPreset + mcp-server-preset-registry overlay",
    hostBindings: [
      "lib/plugin/registries/mcp-server-preset-registry.ts",
      "lib/plugin/bridge/agent-integration.ts",
      "lib/claude/mcp-presets.ts",
    ],
    typescriptSdk: [
      "plugin-sdk/typescript/src/api/mcp-server-preset.ts",
      "plugin-sdk/typescript/src/context/extended.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    builtinContributionPaths: [
      "plugins/playwright-mcp/src/index.ts",
      "plugins/stagehand-mcp/src/index.ts",
      "plugins/e2b-sandbox/src/index.ts",
    ],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: ["lib/plugin/registries/mcp-server-preset-registry.test.ts"],
  },
  {
    // Plugin-first Computer Use plan (M1·T4). Plugins declaring this
    // capability contribute Anthropic native tool definitions
    // (computer_20251124, bash_20250124, text_editor_20250728) along with
    // their Tauri-command execution handlers. The plugin's manifest carries
    // a `nativeAnthropicTools` array; the plugin manager calls
    // `registerNativeAnthropicTool(id, def, {pluginId})` on enable.
    // `build-options.ts:resolveSendOptions` pulls enabled tools per
    // character, computes required `anthropic-beta` headers via
    // `computeAnthropicBetaHeaders()`, and the sidecar dispatches via
    // `native-tool-loop.mjs` (M5).
    id: "native-anthropic-tool",
    support: "supported",
    manifestFields: ["nativeAnthropicTools"],
    runtimeBinding:
      "context.agent.registerNativeAnthropicTool + native-anthropic-tool-registry overlay + sidecar tools[] passthrough",
    hostBindings: [
      "lib/plugin/registries/native-anthropic-tool-registry.ts",
      "lib/claude/build-options.ts",
      "lib/claude/computer-use-tools.ts",
      "sidecar/dispatch/anthropic.mjs",
      "plugins/computer-use/rust/src/commands.rs",
      "plugins/computer-use/rust/src/translator.rs",
      "src-tauri/src/automation/commands.rs",
    ],
    typescriptSdk: [
      "plugin-sdk/typescript/src/api/native-anthropic-tool.ts",
      "plugin-sdk/typescript/src/context/extended.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    builtinContributionPaths: ["plugins/computer-use/src/index.ts"],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: [
      "lib/plugin/registries/native-anthropic-tool-registry.test.ts",
      "plugin-sdk/typescript/src/api/native-anthropic-tool.test.ts",
      "plugin-sdk/typescript/src/context/extended.test.ts",
    ],
  },
  {
    // Phase B of the VS Code LSP reuse work (~/.claude/plans/
    // vscode-lsp-mighty-robin.md). A plugin declaring this capability
    // ships one or more `lspServers[]` entries — each entry produces a
    // `CogniaLspClient` that the host spawns on plugin enable and tears
    // down on disable. Every spawn is gated by `lsp-binary-policy`.
    // Diagnostics + provider responses route through the existing
    // `monaco-bridge` + `lsp-protocol-adapter` pipeline.
    id: "lsp-server",
    // Host runtime is fully wired (lsp-registry + monaco bridge + sidecar
    // client are all live), but the SDK packages don't yet ship a
    // `defineLspServer()` helper — plugin authors declare LSP servers
    // through `manifest.lspServers[]` only. Downgrade to `experimental`
    // until the SDK gains a typed helper; the host contract is unaffected.
    support: "experimental",
    manifestFields: ["lspServers"],
    runtimeBinding: "lib/plugin/lsp/lsp-registry registerPluginLspServers / unregisterByOwner",
    hostBindings: [
      "lib/plugin/lsp/lsp-registry.ts",
      "lib/plugin/vscode-shim/lsp-binary-policy.ts",
      "lib/plugin/vscode-shim/lsp-workspace-manager.ts",
      "lib/plugin/vscode-shim/lsp-protocol-adapter.ts",
      "lib/plugin/vscode-shim/monaco-bridge.ts",
      "sidecar/vscode-ext-host/src/lsp-client.ts",
    ],
    typescriptSdk: [],
    pythonSdk: [],
    builtinContributionPaths: ["plugins/test-lsp-contribution/src/index.ts"],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: [
      "lib/plugin/lsp/lsp-registry.test.ts",
      "sidecar/vscode-ext-host/tests/lsp-client.test.mjs",
    ],
  },
  {
    // ADR-0030. Plugins declaring this capability contribute character
    // packs — bundles of ready-to-use personas (system prompt + model
    // defaults + skill / mcp / native-tool wiring) that flow into the
    // dynamic overlay at
    // `lib/plugin/registries/character-pack-registry.ts`. The plugin's
    // manifest carries a `characterPacks` array; the plugin manager
    // calls `registerCharacterPack(id, def, { pluginId })` on enable
    // and `unregisterCharacterPacksByPlugin(pluginId)` on disable.
    // `lib/db/characters.ts:listCharacters` unions Dexie rows with
    // `listAllPackCharacters()` so a single source feeds every picker
    // UI; `resolveCharacterById` resolves overlay synthetic ids
    // (`cognia-pack:<plugin>:<pack>:<local>`) for the build-options
    // pipeline.
    id: "character-pack",
    support: "supported",
    manifestFields: ["characterPacks"],
    runtimeBinding:
      "registerCharacterPack + character-pack-registry overlay + listCharacters union",
    hostBindings: [
      "lib/plugin/registries/character-pack-registry.ts",
      "lib/db/characters.ts",
      "lib/claude/build-options.ts",
      "components/settings/characters-section.tsx",
    ],
    typescriptSdk: [
      "plugin-sdk/typescript/src/api/character-pack.ts",
      "lib/plugin/sdk/define-character-pack.ts",
    ],
    pythonSdk: [
      // Python plugins declare character packs through the same manifest
      // schema; the existing context bridge serialises the shape into the
      // host without a dedicated helper, matching how `skills` are wired.
      "plugin-sdk/python/src/cognia/context.py",
      "plugin-sdk/python/src/cognia/types.py",
    ],
    builtinContributionPaths: ["plugins/cognia-character-seeds/src/index.ts"],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: [
      "lib/plugin/registries/character-pack-registry.test.ts",
      "lib/plugin/contracts/capability-bridge-map.test.ts",
      "lib/plugin/character-pack/validate-requires.test.ts",
    ],
  },
  {
    // ADR-0032. Plugins declaring this capability contribute Claude SDK
    // subagents callable by agent teams + the workflow editor. The manifest
    // carries a `subagents` array; the plugin manager registers each into
    // `subagent-registry` on enable and drops them on disable. Runtime
    // resolution unions them with the host's built-in dispatchers, namespaced
    // `<pluginId>:<id>`.
    id: "subagent",
    support: "supported",
    manifestFields: ["subagents"],
    runtimeBinding: "registerSubagent + subagent-registry overlay + resolveAllSubagents union",
    hostBindings: [
      "lib/plugin/registries/subagent-registry.ts",
      "lib/claude/agents/subagents/index.ts",
    ],
    typescriptSdk: ["lib/plugin/sdk/define-subagent.ts"],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    builtinContributionPaths: [
      "plugins/agent-team-examples/src/index.ts",
      "plugins/computer-use/src/index.ts",
    ],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: [
      "lib/plugin/registries/subagent-registry.test.ts",
      "lib/plugin/contracts/capability-bridge-map.test.ts",
    ],
  },
  {
    // ADR-0032. Plugins declaring this capability contribute complete agent
    // team blueprints (roster + tasks + config + requires) surfaced in the
    // team picker. The manifest carries an `agentTeamTemplates` array.
    id: "agent-team-template",
    support: "supported",
    manifestFields: ["agentTeamTemplates"],
    runtimeBinding:
      "registerAgentTeamTemplate + agent-team-template-registry overlay + validateTemplateRequires",
    hostBindings: [
      "lib/plugin/registries/agent-team-template-registry.ts",
      "components/settings/agent/agent-team-templates-section.tsx",
    ],
    typescriptSdk: ["lib/plugin/sdk/define-agent-team-template.ts"],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    builtinContributionPaths: [
      "plugins/agent-team-examples/src/index.ts",
      "plugins/computer-use/src/index.ts",
    ],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: [
      "lib/plugin/registries/agent-team-template-registry.test.ts",
      "lib/plugin/contracts/capability-bridge-map.test.ts",
    ],
  },
  {
    // ADR-0032 follow-up. Plugins declaring this capability contribute a
    // bidirectional backing store for agent-team shared memory. The manifest
    // carries a `sharedMemoryAdapters` array; a team opts into one via
    // `team.config.sharedMemoryAdapterId`. The orchestrator mirrors writes and
    // pulls remote changes (local-version-wins).
    id: "shared-memory-adapter",
    support: "supported",
    manifestFields: ["sharedMemoryAdapters"],
    runtimeBinding:
      "registerSharedMemoryAdapter + shared-memory-adapter-registry overlay + syncSharedMemoryFromAdapter",
    hostBindings: [
      "lib/plugin/registries/shared-memory-adapter-registry.ts",
      "lib/ai/agent/team/shared-memory-orchestrator.ts",
    ],
    typescriptSdk: ["types/plugin/plugin-shared-memory-adapter.ts"],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    builtinContributionPaths: ["plugins/agent-team-examples/src/demo-adapter.ts"],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: [
      "lib/plugin/registries/shared-memory-adapter-registry.test.ts",
      "lib/plugin/contracts/capability-bridge-map.test.ts",
    ],
  },
  {
    // ADR-0017/0032. Plugins declaring this capability contribute complete
    // visual-workflow blueprints (nodes + edges + settings + requires) surfaced
    // in the editor's Settings tab → "Plugins & capabilities". The manifest
    // carries a `workflowTemplates` array.
    id: "workflow-template",
    support: "supported",
    manifestFields: ["workflowTemplates"],
    runtimeBinding:
      "registerWorkflowTemplate + workflow-template-registry overlay + validateWorkflowTemplateRequires",
    hostBindings: [
      "lib/plugin/registries/workflow-template-registry.ts",
      "lib/workflow/templates/project-plugin-workflow-template.ts",
      "components/workflow/editor/right-sidebar/settings/plugin-capabilities-section.tsx",
    ],
    typescriptSdk: ["lib/plugin/sdk/define-workflow-template.ts"],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: [
      "lib/plugin/registries/workflow-template-registry.test.ts",
      "lib/plugin/contracts/capability-bridge-map.test.ts",
    ],
  },
  {
    // Platform Connector adapters (ADR-0009). Runtime-wired through the
    // connectors bridge + ConnectorBus, but without a dedicated SDK package
    // surface yet — hence `partial` rather than `supported`.
    id: "connectors",
    support: "partial",
    manifestFields: ["connectors"],
    runtimeBinding:
      "Connector adapter factories registered via the connectors bridge into ConnectorBus",
    hostBindings: ["lib/plugin/bridge/connectors-bridge.ts", "lib/plugin/core/manager.ts"],
    typescriptSdk: [
      "plugin-sdk/typescript/src/context/extended.ts",
      "plugin-sdk/typescript/src/api/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: ["lib/plugin/bridge/connectors-bridge.test.ts"],
  },
  {
    // Custom Visual-Workflow node executors (ADR-0017). Wired through the
    // workflow integration bridge into the editor catalog; no full SDK
    // package parity yet.
    id: "workflow",
    support: "partial",
    manifestFields: ["workflows"],
    runtimeBinding:
      "Plugin node executors registered into the workflow catalog via the workflow integration bridge",
    hostBindings: ["lib/plugin/bridge/workflow-integration.ts"],
    typescriptSdk: [
      "plugin-sdk/typescript/src/context/extended.ts",
      "plugin-sdk/typescript/src/api/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: ["lib/plugin/bridge/workflow-integration.test.ts"],
  },
  {
    // Custom Visual-Workflow trigger sources (ADR-0017). Same bridge as
    // `workflow`; partial for the same reason.
    id: "workflow-trigger",
    support: "partial",
    manifestFields: ["workflows"],
    runtimeBinding:
      "Plugin trigger sources registered into the workflow catalog via the workflow integration bridge",
    hostBindings: ["lib/plugin/bridge/workflow-integration.ts"],
    typescriptSdk: [
      "plugin-sdk/typescript/src/context/extended.ts",
      "plugin-sdk/typescript/src/api/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/features/plugin-development.md#capabilities",
    requiredTests: ["lib/plugin/bridge/workflow-integration.test.ts"],
  },
] as const

export const CANONICAL_PLUGIN_CAPABILITIES = PLUGIN_CAPABILITY_CONTRACTS.map(
  (entry) => entry.id
) as readonly PluginCapability[]

const capabilityContractMap = new Map(PLUGIN_CAPABILITY_CONTRACTS.map((entry) => [entry.id, entry]))

export function getPluginCapabilityContract(
  capability: PluginCapability | string
): PluginCapabilityContract | undefined {
  return capabilityContractMap.get(capability as PluginCapability)
}

export function validatePluginCapabilities(
  capabilities: readonly string[],
  options: { governanceMode?: PluginPointGovernanceMode } = {}
): PluginCapabilityValidationOutcome {
  const governanceMode = options.governanceMode || "warn"
  const diagnostics: PluginCapabilityDiagnostic[] = []

  for (const capability of capabilities) {
    const contract = getPluginCapabilityContract(capability)
    if (!contract) {
      diagnostics.push({
        code: "plugin.capability.unknown",
        severity: "error",
        capability,
        message: `Unknown capability "${capability}".`,
      })
      continue
    }

    if (contract.support === "supported") {
      continue
    }

    if (contract.support === "blocked") {
      diagnostics.push({
        code: "plugin.capability.blocked",
        severity: governanceMode === "block" ? "error" : "warning",
        capability,
        message: `Capability "${capability}" is blocked by the current host contract.`,
        hint: `Remove "${capability}" from the manifest or wait until the host exposes a supported runtime binding.`,
        contract,
      })
      continue
    }

    diagnostics.push({
      code:
        contract.support === "partial"
          ? "plugin.capability.partial"
          : "plugin.capability.experimental",
      severity: "warning",
      capability,
      message: `Capability "${capability}" is only ${contract.support}ly supported by the current host contract.`,
      hint: `Use "${capability}" with caution until host/runtime parity is completed.`,
      contract,
    })
  }

  return {
    allowed: diagnostics.every((entry) => entry.severity !== "error"),
    diagnostics,
  }
}

export function auditPluginCapabilityContracts(): PluginCapabilityProofAudit[] {
  return PLUGIN_CAPABILITY_CONTRACTS.map((contract) => {
    const missingFields: Array<
      | "runtimeBinding"
      | "hostBindings"
      | "typescriptSdk"
      | "pythonSdk"
      | "builtinContributionPaths"
      | "docs"
      | "requiredTests"
    > = []
    const requiresProof = contract.support === "supported"
    const requiresBuiltinProof =
      contract.id === "tools" || contract.id === "commands" || contract.id === "hooks"

    if (requiresProof && !contract.runtimeBinding.trim()) {
      missingFields.push("runtimeBinding")
    }

    if (
      requiresProof &&
      (!contract.hostBindings.length || contract.hostBindings.some((entry) => !entry.trim()))
    ) {
      missingFields.push("hostBindings")
    }

    if (
      requiresProof &&
      (!contract.typescriptSdk.length || contract.typescriptSdk.some((entry) => !entry.trim()))
    ) {
      missingFields.push("typescriptSdk")
    }

    if (
      requiresProof &&
      (!contract.pythonSdk.length || contract.pythonSdk.some((entry) => !entry.trim()))
    ) {
      missingFields.push("pythonSdk")
    }

    if (
      requiresProof &&
      requiresBuiltinProof &&
      (!contract.builtinContributionPaths ||
        contract.builtinContributionPaths.length === 0 ||
        contract.builtinContributionPaths.some((entry) => !entry.trim()))
    ) {
      missingFields.push("builtinContributionPaths")
    }

    if (requiresProof && !contract.docs.trim()) {
      missingFields.push("docs")
    }

    if (
      requiresProof &&
      (!contract.requiredTests.length || contract.requiredTests.some((entry) => !entry.trim()))
    ) {
      missingFields.push("requiredTests")
    }

    return {
      id: contract.id,
      support: contract.support,
      runtimeBinding: contract.runtimeBinding,
      hostBindings: contract.hostBindings,
      typescriptSdk: contract.typescriptSdk,
      pythonSdk: contract.pythonSdk,
      builtinContributionPaths: contract.builtinContributionPaths || [],
      docs: contract.docs,
      requiredTests: contract.requiredTests,
      missingFields,
      proofStatus: !requiresProof
        ? "not_applicable"
        : missingFields.length === 0
          ? "verified"
          : "missing_proof",
    }
  })
}
