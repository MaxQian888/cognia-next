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
      "packages/plugin-sdk/src/manifest/index.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/plugin.py", "plugin-sdk/python/src/cognia/types.py"],
    builtinContributionPaths: [
      "plugins/clipboard-tools/src/index.ts",
      "plugins/web-tools/src/index.ts",
      "plugins/workspace-tools/src/index.ts",
    ],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
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
      "packages/plugin-sdk/src/manifest/index.ts",
      "packages/plugin-sdk/src/context/extended.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/a2ui.py", "plugin-sdk/python/src/cognia/context.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: ["stores/plugin-runtime/plugin-store.test.ts"],
  },
  {
    id: "modes",
    support: "supported",
    manifestFields: ["modes"],
    runtimeBinding: "PluginRegistry modes",
    hostBindings: ["lib/plugin/core/registry.ts", "lib/plugin/bridge/agent-integration.ts"],
    typescriptSdk: [
      "packages/plugin-sdk/src/manifest/index.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/modes.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
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
      "packages/plugin-sdk/src/api/skill.ts",
      "packages/plugin-sdk/src/context/extended.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    builtinContributionPaths: ["plugins/anthropic-skills/src/index.ts"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: ["lib/plugin/registries/skill-registry.test.ts"],
  },
  {
    id: "media",
    support: "supported",
    // API-only (gated by the capability tag itself, like `tray`): listing
    // "capabilities" here made the validator's field cross-check treat the
    // manifest's own capabilities array as a contribution field and emit a
    // bogus field_undeclared warning on every manifest.
    manifestFields: [],
    runtimeBinding: "context.media + AI-backed media helpers",
    hostBindings: ["lib/plugin/api/media-api.ts", "lib/plugin/core/context.ts"],
    typescriptSdk: [
      "packages/plugin-sdk/src/context/extended.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: ["lib/plugin/api/media-api.test.ts"],
  },
  {
    id: "canvas",
    support: "supported",
    // API-only — see the `media` contract note.
    manifestFields: [],
    runtimeBinding: "context.canvas + active editor selection bridge",
    hostBindings: ["lib/plugin/api/canvas-api.ts", "lib/plugin/core/context.ts"],
    typescriptSdk: [
      "packages/plugin-sdk/src/context/extended.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: ["lib/plugin/api/canvas-api.test.ts"],
  },
  {
    id: "ai-provider",
    support: "supported",
    // API-only — see the `media` contract note.
    manifestFields: [],
    runtimeBinding: "context.ai + built-in provider fallback",
    hostBindings: ["lib/plugin/api/ai-provider-api.ts", "lib/plugin/core/context.ts"],
    typescriptSdk: [
      "packages/plugin-sdk/src/context/extended.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: ["lib/plugin/api/ai-provider-api.test.ts"],
  },
  {
    id: "themes",
    // Promoted partial→supported: the declarative `manifest.themes[]` is wired
    // through the themes bridge into the theme registry, and a typed
    // `defineTheme()` SDK helper now ships. manifestFields stays [] so the
    // validator's field cross-check doesn't flag module-manifest-authored
    // themes (clipboard-history, cognia-appearance-demo) as field_missing.
    support: "supported",
    manifestFields: [],
    runtimeBinding: "Declarative manifest.themes wired via themes bridge + ctx.theme API",
    hostBindings: ["lib/plugin/api/theme-api.ts", "lib/plugin/bridge/themes-bridge.ts"],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-theme.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "packages/plugin-sdk/src/define/define-theme.test.ts",
      "lib/plugin/core/validation.test.ts",
    ],
  },
  {
    id: "commands",
    support: "supported",
    manifestFields: ["commands"],
    runtimeBinding: "PluginRegistry commands + slash command registry",
    hostBindings: ["lib/plugin/core/manager.ts", "lib/chat/slash-command-registry.ts"],
    typescriptSdk: [
      "packages/plugin-sdk/src/manifest/index.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/plugin.py", "plugin-sdk/python/src/cognia/types.py"],
    builtinContributionPaths: [
      "plugins/clipboard-tools/src/index.ts",
      "plugins/web-tools/src/index.ts",
      "plugins/workspace-tools/src/index.ts",
    ],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: ["lib/plugin/core/manager.test.ts"],
  },
  {
    id: "hooks",
    support: "supported",
    manifestFields: [],
    runtimeBinding: "PluginLifecycleHooks + hooks-system",
    hostBindings: ["lib/plugin/messaging/hooks-system.ts", "lib/plugin/contracts/plugin-points.ts"],
    typescriptSdk: ["packages/plugin-sdk/src/hooks/index.ts", "packages/plugin-sdk/src/index.ts"],
    pythonSdk: [
      "plugin-sdk/python/src/cognia/decorators.py",
      "plugin-sdk/python/src/cognia/types.py",
    ],
    builtinContributionPaths: [
      "plugins/clipboard-tools/src/index.ts",
      "plugins/web-tools/src/index.ts",
      "plugins/workspace-tools/src/index.ts",
    ],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: ["lib/plugin/core/manager.test.ts"],
  },
  {
    id: "processors",
    support: "experimental",
    manifestFields: [],
    runtimeBinding: "No stable processor pipeline contract yet",
    hostBindings: ["lib/plugin/contracts/plugin-capabilities.ts"],
    // Experimental: no typed SDK helper ships for the processor pipeline yet
    // (the host contract is unstable). The Python capability-contract helper
    // is the only author-facing surface.
    typescriptSdk: [],
    pythonSdk: ["plugin-sdk/python/src/cognia/capability_contract.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: ["lib/plugin/core/validation.test.ts"],
  },
  {
    id: "providers",
    support: "experimental",
    manifestFields: [],
    runtimeBinding: "Provider extension integration is not production-ready",
    hostBindings: ["lib/plugin/api/ai-provider-api.ts"],
    typescriptSdk: [
      "packages/plugin-sdk/src/index.ts",
      "packages/plugin-sdk/src/context/extended.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: ["lib/plugin/core/validation.test.ts"],
  },
  {
    id: "exporters",
    // Promoted partial→supported: `ctx.export.registerExporter` is wired and a
    // typed `defineExporter()` SDK helper now ships for the `CustomExporter`
    // shape. API-only (no manifest field), like `media`/`canvas`.
    support: "supported",
    manifestFields: [],
    runtimeBinding: "ctx.export.registerExporter + CustomExporter registry",
    hostBindings: ["lib/plugin/api/export-api.ts"],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-exporter.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "packages/plugin-sdk/src/define/define-exporter.test.ts",
      "lib/plugin/core/validation.test.ts",
    ],
  },
  {
    // Promoted partial→supported: a content-import contribution type now
    // exists (`CustomImporter`), `ctx.import.registerImporter` is wired
    // (symmetric to `ctx.export`), and a typed `defineImporter()` SDK helper
    // ships. API-only (no manifest field), like `exporters`/`media`/`canvas`.
    id: "importers",
    support: "supported",
    manifestFields: [],
    runtimeBinding: "ctx.import.registerImporter + CustomImporter registry",
    hostBindings: ["lib/plugin/api/import-api.ts"],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-importer.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "lib/plugin/api/import-api.test.ts",
      "packages/plugin-sdk/src/define/define-importer.test.ts",
    ],
  },
  {
    // Declarative configuration (VS Code `contributes.configuration` parity).
    // Field-driven (no required capability tag): a plugin ships `configSchema`
    // and the host auto-renders the settings form + seeds defaults + exposes
    // `ctx.configuration.get/update/onChange`. `defineConfiguration()` ships the
    // typed authoring helper. manifestFields: [] keeps it from emitting an
    // `undeclared` warning on every existing plugin that already uses configSchema.
    id: "configuration",
    support: "supported",
    manifestFields: [],
    runtimeBinding:
      "ctx.configuration.get/update/onChange + schema-driven settings form + default seeding",
    hostBindings: [
      "lib/plugin/api/config-api.ts",
      "lib/plugin/core/config-defaults.ts",
      "components/plugins/detail/plugin-config-form.tsx",
    ],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-configuration.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: [
      "plugin-sdk/python/src/cognia/context.py",
      "plugin-sdk/python/src/cognia/runtime.py",
    ],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "lib/plugin/api/config-api.test.ts",
      "lib/plugin/core/config-defaults.test.ts",
      "packages/plugin-sdk/src/define/define-configuration.test.ts",
    ],
  },
  {
    id: "a2ui",
    support: "supported",
    manifestFields: ["a2uiComponents", "a2uiTemplates"],
    runtimeBinding: "Plugin A2UI bridge",
    hostBindings: ["lib/plugin/bridge/a2ui-bridge.ts", "lib/plugin/core/manager.ts"],
    typescriptSdk: [
      "packages/plugin-sdk/src/manifest/index.ts",
      "packages/plugin-sdk/src/context/extended.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/a2ui.py", "plugin-sdk/python/src/cognia/context.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#a2ui-integration",
    requiredTests: ["stores/plugin-runtime/plugin-store.test.ts"],
  },
  {
    id: "python",
    support: "supported",
    manifestFields: ["pythonMain", "pythonDependencies"],
    runtimeBinding: "PyO3/Tauri python runtime",
    hostBindings: ["src-tauri/src/plugin_api/python/commands.rs", "lib/plugin/core/manager.ts"],
    typescriptSdk: ["packages/plugin-sdk/src/context/index.ts"],
    pythonSdk: [
      "plugin-sdk/python/src/cognia/runtime.py",
      "plugin-sdk/python/src/cognia/plugin.py",
    ],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#plugin-types",
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
      "packages/plugin-sdk/src/index.ts",
      "packages/plugin-sdk/src/context/extended.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: ["packages/plugin-sdk/src/manifest/index.test.ts"],
  },
  {
    id: "workspace-backend",
    support: "supported",
    manifestFields: ["workspaceBackends"],
    runtimeBinding:
      "manifest.workspaceBackends → workspace-backend bridge → workspace backend registry",
    hostBindings: [
      "lib/plugin/bridge/workspace-backend-bridge.ts",
      "lib/plugin/contracts/module-bridge-map.ts",
      "lib/github/workspace-backend-registry.ts",
    ],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-workspace-backend.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "packages/plugin-sdk/src/define/define-workspace-backend.test.ts",
      "lib/plugin/bridge/workspace-backend-bridge.test.ts",
    ],
  },
  {
    id: "message-renderer",
    support: "supported",
    manifestFields: ["messageRenderers"],
    runtimeBinding:
      "manifest.messageRenderers → message-renderer bridge → message-part renderer registry",
    hostBindings: [
      "lib/plugin/bridge/message-renderer-bridge.ts",
      "lib/plugin/contracts/module-bridge-map.ts",
      "lib/plugin/api/message-part-renderers.ts",
    ],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-message-renderer.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "packages/plugin-sdk/src/define/define-message-renderer.test.ts",
      "lib/plugin/bridge/message-renderer-bridge.test.ts",
    ],
  },
  {
    id: "density-preset",
    support: "supported",
    manifestFields: ["densityPresets"],
    runtimeBinding:
      "manifest.densityPresets → density-preset module bridge → density-preset registry",
    hostBindings: [
      "lib/appearance/density-preset-registry.ts",
      "lib/plugin/contracts/module-bridge-map.ts",
    ],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-density-preset.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "packages/plugin-sdk/src/define/define-density-preset.test.ts",
      "lib/appearance/density-preset-registry.test.ts",
    ],
  },
  {
    id: "chat-middleware",
    support: "supported",
    manifestFields: ["chatMiddlewares"],
    runtimeBinding:
      "manifest.chatMiddlewares → chat-middleware bridge → guarded chat middleware registry",
    hostBindings: [
      "lib/plugin/bridge/chat-middleware-bridge.ts",
      "lib/plugin/contracts/module-bridge-map.ts",
      "lib/claude/chat-middleware/registry.ts",
    ],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-chat-middleware.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "packages/plugin-sdk/src/define/define-chat-middleware.test.ts",
      "lib/plugin/bridge/chat-middleware-bridge.test.ts",
    ],
  },
  {
    id: "modal-mount",
    support: "supported",
    manifestFields: ["modalMounts"],
    runtimeBinding: "manifest.modalMounts → modal-mount bridge → plugin modal store",
    hostBindings: [
      "lib/plugin/bridge/modal-mount-bridge.ts",
      "lib/plugin/contracts/module-bridge-map.ts",
      "stores/plugin-runtime/plugin-modal-store.ts",
    ],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-modal-mount.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "packages/plugin-sdk/src/define/define-modal-mount.test.ts",
      "lib/plugin/bridge/modal-mount-bridge.test.ts",
    ],
  },
  {
    id: "terminal-completion",
    support: "supported",
    manifestFields: ["terminalCompletionProviders"],
    runtimeBinding:
      "manifest.terminalCompletionProviders → terminal-completion bridge → terminal completion registry",
    hostBindings: [
      "lib/plugin/bridge/terminal-completion-bridge.ts",
      "lib/plugin/contracts/module-bridge-map.ts",
      "lib/terminal/completion/registry.ts",
    ],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-terminal-completion.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "packages/plugin-sdk/src/define/define-terminal-completion.test.ts",
      "lib/plugin/bridge/terminal-completion-bridge.test.ts",
    ],
  },
  {
    id: "routing-strategy",
    support: "supported",
    manifestFields: ["routingStrategies"],
    runtimeBinding:
      "manifest.routingStrategies → routing-strategies bridge → provider routing strategy registry",
    hostBindings: [
      "lib/plugin/bridge/routing-strategies-bridge.ts",
      "lib/plugin/contracts/module-bridge-map.ts",
      "packages/provider-routing/src/strategy-registry.ts",
    ],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-routing-strategy.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "packages/plugin-sdk/src/define/define-routing-strategy.test.ts",
      "lib/plugin/bridge/routing-strategies-bridge.test.ts",
    ],
  },
  {
    id: "deployment-filter",
    support: "supported",
    manifestFields: ["deploymentFilters"],
    runtimeBinding:
      "manifest.deploymentFilters → deployment-filters bridge → provider deployment filter registry",
    hostBindings: [
      "lib/plugin/bridge/deployment-filters-bridge.ts",
      "lib/plugin/contracts/module-bridge-map.ts",
      "packages/provider-routing/src/filter-registry.ts",
    ],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-deployment-filter.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "packages/plugin-sdk/src/define/define-deployment-filter.test.ts",
      "lib/plugin/bridge/deployment-filters-bridge.test.ts",
    ],
  },
  {
    id: "protocol-adapter",
    support: "supported",
    manifestFields: ["protocolAdapters"],
    runtimeBinding:
      "manifest.protocolAdapters → protocol-adapters bridge → provider protocol adapter registry",
    hostBindings: [
      "lib/plugin/bridge/protocol-adapters-bridge.ts",
      "lib/plugin/contracts/module-bridge-map.ts",
      "packages/provider-core/src/providers/protocol-adapter-registry.ts",
    ],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-protocol-adapter.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "packages/plugin-sdk/src/define/define-protocol-adapter.test.ts",
      "lib/plugin/bridge/protocol-adapters-bridge.test.ts",
    ],
  },
  {
    id: "tool-route",
    support: "supported",
    manifestFields: ["toolRoutes"],
    runtimeBinding: "manifest.toolRoutes → tool-routes bridge → Dexie toolRoutes rows",
    hostBindings: [
      "lib/plugin/bridge/tool-routes-bridge.ts",
      "lib/plugin/contracts/module-bridge-map.ts",
      "lib/db/tool-routes.ts",
    ],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-tool-route.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "packages/plugin-sdk/src/define/define-tool-route.test.ts",
      "lib/plugin/bridge/tool-routes-bridge.test.ts",
    ],
  },
  {
    id: "context-provider",
    support: "supported",
    manifestFields: ["contextProviders"],
    runtimeBinding:
      "manifest.contextProviders → context-providers bridge → agent context-provider registry",
    hostBindings: [
      "lib/plugin/bridge/context-providers-bridge.ts",
      "lib/plugin/contracts/module-bridge-map.ts",
      "lib/plugin/registries/context-provider-registry.ts",
    ],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-context-provider.ts",
      "packages/plugin-sdk/src/api/context-provider.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "packages/plugin-sdk/src/define/define-context-provider.test.ts",
      "lib/plugin/bridge/context-providers-bridge.test.ts",
    ],
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
      "components/agent/external-agent/manager.tsx",
    ],
    typescriptSdk: [
      "packages/plugin-sdk/src/index.ts",
      "packages/plugin-sdk/src/context/extended.ts",
    ],
    pythonSdk: [
      // Python plugins can declare external-agent presets through the same
      // manifest schema; the SDK helper is a thin pass-through to the Tauri
      // command that mirrors the contribution into the runtime overlay.
      "plugin-sdk/python/src/cognia_next/external_agent_presets.py",
    ],
    builtinContributionPaths: ["plugins/external-agent-preset-example/src/index.ts"],
    docs: "docs/content/docs/en/chat/external-agents/index.mdx",
    requiredTests: ["lib/ai/agent/external/presets.test.ts"],
  },
  {
    // cognia-next-specific extension. Plugins declaring this capability
    // contribute external-agent PROTOCOL ADAPTERS — a `() => ProtocolAdapter`
    // factory lazy-imported on enable and registered into the external-agent
    // `protocolAdapterRegistry` under `${pluginId}:${id}` via the
    // external-agent-adapters module bridge. Where `external-agent-preset`
    // contributes a configuration over one of the four built-in protocols,
    // this contributes the protocol behaviour itself, so a plugin can ship a
    // genuinely new, dynamically-loadable external agent (adapter + preset).
    id: "external-agent-adapter",
    support: "supported",
    manifestFields: ["externalAgentAdapters"],
    runtimeBinding:
      "context.agent.registerExternalAgentAdapter + external-agent-adapters-bridge → protocolAdapterRegistry",
    hostBindings: [
      "lib/ai/agent/external/protocol-adapter.ts",
      "lib/plugin/bridge/external-agent-adapters-bridge.ts",
      "lib/plugin/contracts/module-bridge-map.ts",
    ],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-external-agent-adapter.ts",
      "packages/plugin-sdk/src/manifest/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia_next/external_agent_adapters.py"],
    builtinContributionPaths: ["plugins/external-agent-adapter-example/src/index.ts"],
    docs: "docs/content/docs/en/chat/external-agents/integration.mdx",
    requiredTests: [
      "lib/plugin/bridge/external-agent-adapters-bridge.test.ts",
      "lib/ai/agent/external/protocol-adapter.test.ts",
    ],
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
      "packages/plugin-sdk/src/api/mcp-server-preset.ts",
      "packages/plugin-sdk/src/context/extended.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    builtinContributionPaths: [
      "plugins/playwright-mcp/src/index.ts",
      "plugins/stagehand-mcp/src/index.ts",
      "plugins/e2b-sandbox/src/index.ts",
    ],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
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
      "packages/plugin-sdk/src/api/native-anthropic-tool.ts",
      "packages/plugin-sdk/src/context/extended.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    builtinContributionPaths: ["plugins/computer-use/src/index.ts"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "lib/plugin/registries/native-anthropic-tool-registry.test.ts",
      "packages/plugin-sdk/src/api/native-anthropic-tool.test.ts",
      "packages/plugin-sdk/src/context/extended.test.ts",
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
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
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
      "packages/plugin-sdk/src/api/character-pack.ts",
      "packages/plugin-sdk/src/define/define-character-pack.ts",
    ],
    pythonSdk: [
      // Python plugins declare character packs through the same manifest
      // schema; the existing context bridge serialises the shape into the
      // host without a dedicated helper, matching how `skills` are wired.
      "plugin-sdk/python/src/cognia/context.py",
      "plugin-sdk/python/src/cognia/types.py",
    ],
    builtinContributionPaths: ["plugins/cognia-character-seeds/src/index.ts"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
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
    typescriptSdk: ["packages/plugin-sdk/src/define/define-subagent.ts"],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    builtinContributionPaths: [
      "plugins/agent-team-examples/src/index.ts",
      "plugins/computer-use/src/index.ts",
    ],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
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
    typescriptSdk: ["packages/plugin-sdk/src/define/define-agent-team-template.ts"],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    builtinContributionPaths: [
      "plugins/agent-team-examples/src/index.ts",
      "plugins/computer-use/src/index.ts",
    ],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
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
    typescriptSdk: ["packages/plugin-sdk/src/define/define-shared-memory-adapter.ts"],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    builtinContributionPaths: ["plugins/agent-team-examples/src/demo-adapter.ts"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "lib/plugin/registries/shared-memory-adapter-registry.test.ts",
      "lib/plugin/contracts/capability-bridge-map.test.ts",
    ],
  },
  {
    // ADR-0025 follow-up. Plugins declaring this capability contribute a
    // subscription balance adapter — a pure authed-GET descriptor + parser that
    // resolves "how much credit / quota is left" for a provider account. The
    // manifest carries a `balanceAdapters` array; `findBalanceAdapter` lists
    // overlay adapters before the built-in set so a plugin can extend/override.
    id: "balance-adapter",
    // Host runtime is fully wired (overlay registry + dispatch + findBalanceAdapter
    // composition) and the `defineBalanceAdapter()` TS SDK helper ships
    // (packages/plugin-sdk/src/define/define-balance-adapter.ts, exported from
    // packages/plugin-sdk/src/index.ts).
    support: "supported",
    manifestFields: ["balanceAdapters"],
    runtimeBinding:
      "OVERLAY_REGISTRY_CAPABILITIES['balance-adapter'] → registerBalanceAdapter + balance-adapter-registry overlay → findBalanceAdapter",
    hostBindings: [
      "lib/plugin/registries/balance-adapter-registry.ts",
      "lib/subscription/balance/registry.ts",
    ],
    typescriptSdk: ["packages/plugin-sdk/src/define/define-balance-adapter.ts"],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "lib/plugin/registries/balance-adapter-registry.test.ts",
      "lib/plugin/contracts/capability-bridge-map.test.ts",
    ],
  },
  {
    // ADR-0025 follow-up. Plugins declaring this capability contribute a unified
    // subscription limits/usage source — `matches` + an injected-authed-GET
    // `fetch` that returns normalized `ProviderLimits` (utilization windows
    // and/or credit meters). The manifest carries a `limitsSources` array;
    // `resolveLimitsSources` lists overlay sources before the built-in set so a
    // plugin can extend/override (Anthropic windows, Codex windows, balances).
    id: "limits-source",
    // Host runtime is fully wired (overlay registry + dispatch + resolveLimitsSources
    // composition) and the `defineLimitsSource()` TS SDK helper ships
    // (packages/plugin-sdk/src/define/define-limits-source.ts, exported from
    // packages/plugin-sdk/src/index.ts).
    support: "supported",
    manifestFields: ["limitsSources"],
    runtimeBinding:
      "OVERLAY_REGISTRY_CAPABILITIES['limits-source'] → registerLimitsSource + limits-source-registry overlay → resolveLimitsSources",
    hostBindings: [
      "lib/plugin/registries/limits-source-registry.ts",
      "lib/subscription/limits/registry.ts",
    ],
    typescriptSdk: ["packages/plugin-sdk/src/define/define-limits-source.ts"],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "lib/plugin/registries/limits-source-registry.test.ts",
      "lib/plugin/contracts/capability-bridge-map.test.ts",
    ],
  },
  {
    // Per-conversation IM send gate (plugin⇄IM extensibility). The manifest
    // carries an `imRateSources` array; the connector runtime's ai-run branch
    // calls `evaluateImRate`, which lists the plugin overlay and returns the
    // first block decision (advisory/additive — only further restricts the
    // built-in connector policy). Distinct from `limits-source` (provider
    // credit) — IM-scoped `evaluate → {allow}` shape.
    id: "im-rate-source",
    // Host runtime fully wired (overlay registry + dispatch + evaluateImRate) and
    // the `defineImRateSource()` TS SDK helper ships
    // (packages/plugin-sdk/src/define/define-im-rate-source.ts, exported from
    // packages/plugin-sdk/src/index.ts).
    support: "supported",
    manifestFields: ["imRateSources"],
    runtimeBinding:
      "OVERLAY_REGISTRY_CAPABILITIES['im-rate-source'] → registerImRateSource + im-rate-source-registry overlay → evaluateImRate (connector runtime ai-run branch)",
    hostBindings: [
      "lib/plugin/registries/im-rate-source-registry.ts",
      "lib/connectors/im-rate/registry.ts",
    ],
    typescriptSdk: ["packages/plugin-sdk/src/define/define-im-rate-source.ts"],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "lib/plugin/registries/im-rate-source-registry.test.ts",
      "lib/connectors/im-rate/registry.test.ts",
      "lib/plugin/contracts/capability-bridge-map.test.ts",
    ],
  },
  {
    // Context-compression maturation. Plugins declaring this capability
    // contribute a conversation-compaction strategy — a declarative summary
    // prompt + threshold knobs (keepRecent / fraction). The manifest carries a
    // `compactionStrategies` array; `resolveSendOptions` resolves the active
    // strategy id (from compaction settings) before the built-in default and
    // threads its config into `SendOptions.compaction` for the sidecar.
    id: "compaction-strategy",
    // Host runtime fully wired (overlay registry + dispatch + resolveSendOptions
    // composition) and the `defineCompactionStrategy()` TS SDK helper ships
    // (packages/plugin-sdk/src/define/define-compaction-strategy.ts, exported from
    // packages/plugin-sdk/src/index.ts).
    support: "supported",
    manifestFields: ["compactionStrategies"],
    runtimeBinding:
      "OVERLAY_REGISTRY_CAPABILITIES['compaction-strategy'] → registerCompactionStrategy + compaction-strategy-registry overlay → resolveSendOptions",
    hostBindings: [
      "lib/plugin/registries/compaction-strategy-registry.ts",
      "lib/claude/build-options.ts",
    ],
    typescriptSdk: ["packages/plugin-sdk/src/define/define-compaction-strategy.ts"],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "lib/plugin/registries/compaction-strategy-registry.test.ts",
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
    typescriptSdk: ["packages/plugin-sdk/src/define/define-workflow-template.ts"],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "lib/plugin/registries/workflow-template-registry.test.ts",
      "lib/plugin/contracts/capability-bridge-map.test.ts",
    ],
  },
  {
    // Platform Connector adapters (ADR-0009). Runtime-wired through the
    // connectors bridge + ConnectorBus, but without a dedicated SDK package
    // surface yet — hence `partial` rather than `supported`.
    // Promoted partial→supported: connector adapter factories are wired through
    // the connectors bridge into ConnectorBus, and a typed `defineConnector()`
    // SDK helper now ships for the `PluginConnectorDef` shape.
    id: "connectors",
    support: "supported",
    manifestFields: ["connectors"],
    runtimeBinding:
      "Connector adapter factories registered via the connectors bridge into ConnectorBus",
    hostBindings: ["lib/plugin/bridge/connectors-bridge.ts", "lib/plugin/core/manager.ts"],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-connector.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "packages/plugin-sdk/src/define/define-connector.test.ts",
      "lib/plugin/bridge/connectors-bridge.test.ts",
    ],
  },
  {
    // Custom Visual-Workflow node executors (ADR-0017). Wired through the
    // workflow integration bridge into the editor catalog; no full SDK
    // package parity yet.
    // Promoted partial→supported: plugin node executors register into the
    // workflow catalog via the workflow integration bridge, and a typed
    // `defineWorkflowNode()` SDK helper now ships for the `PluginNodeDef` shape.
    id: "workflow",
    support: "supported",
    manifestFields: ["workflows"],
    runtimeBinding:
      "Plugin node executors registered into the workflow catalog via the workflow integration bridge",
    hostBindings: ["lib/plugin/bridge/workflow-integration.ts"],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-workflow-node.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "packages/plugin-sdk/src/define/define-workflow-node.test.ts",
      "lib/plugin/bridge/workflow-integration.test.ts",
    ],
  },
  {
    // Custom Visual-Workflow trigger sources (ADR-0017). Same bridge as
    // `workflow`; partial for the same reason.
    // Promoted partial→supported: plugin trigger sources register into the
    // workflow catalog via the same bridge, and a typed
    // `defineWorkflowTrigger()` SDK helper now ships for `PluginTriggerDef`.
    id: "workflow-trigger",
    support: "supported",
    manifestFields: ["workflows"],
    runtimeBinding:
      "Plugin trigger sources registered into the workflow catalog via the workflow integration bridge",
    hostBindings: ["lib/plugin/bridge/workflow-integration.ts"],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-workflow-trigger.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "packages/plugin-sdk/src/define/define-workflow-trigger.test.ts",
      "lib/plugin/bridge/workflow-integration.test.ts",
    ],
  },
  {
    // Theme packs (ADR-0029). Applyable bundles registered via the themes
    // bridge into the theme-pack registry. Wired at plugin enable; no
    // dedicated SDK helper yet — hence `partial`.
    // Promoted partial→supported: theme packs register via the themes bridge
    // into the theme-pack registry, and a typed `defineThemePack()` SDK helper
    // now ships for the `PluginThemePackContribution` shape.
    id: "theme-pack",
    support: "supported",
    manifestFields: ["themePacks"],
    runtimeBinding:
      "Theme packs registered via the themes bridge (registerPluginThemePacks) into the theme-pack registry",
    hostBindings: ["lib/plugin/bridge/themes-bridge.ts", "lib/theme/theme-pack-registry.ts"],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-theme-pack.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "packages/plugin-sdk/src/define/define-theme-pack.test.ts",
      "lib/theme/theme-pack-registry.test.ts",
    ],
  },
  {
    // Plugin-bundled font families (ADR-0029). Applied via the font bridge
    // (@font-face injection) into the cross-source font registry on enable.
    // Promoted partial→supported: font families apply via the font bridge into
    // the font registry, and a typed `defineFontContribution()` SDK helper now
    // ships for the `PluginFontContribution` shape.
    id: "fonts",
    support: "supported",
    manifestFields: ["fonts"],
    runtimeBinding:
      "Font families applied via the font bridge (applyPluginFonts) into the font registry",
    hostBindings: ["lib/plugin/bridge/font-bridge.ts", "lib/appearance/font-registry.ts"],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-font-contribution.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "packages/plugin-sdk/src/define/define-font-contribution.test.ts",
      "lib/plugin/bridge/font-bridge.test.ts",
    ],
  },
  {
    // Plugin-bundled wallpapers (ADR-0029). Registered via the wallpaper
    // bridge so the picker surfaces them alongside built-in/user wallpapers.
    // Promoted partial→supported: wallpapers register via the wallpaper bridge,
    // and a typed `defineWallpaper()` SDK helper now ships for the
    // `PluginWallpaperContribution` shape.
    id: "wallpapers",
    support: "supported",
    manifestFields: ["wallpapers"],
    runtimeBinding: "Wallpapers registered via the wallpaper bridge (applyPluginWallpapers)",
    hostBindings: ["lib/plugin/bridge/wallpaper-bridge.ts"],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-wallpaper.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "packages/plugin-sdk/src/define/define-wallpaper.test.ts",
      "lib/plugin/bridge/wallpaper-bridge.test.ts",
    ],
  },
  {
    // Quick actions surfaced in the command palette ("Plugin actions"
    // group), the chat composer's quick-actions dropdown, and the tray
    // "All Commands ▶ Plugins" bucket. Declarative via
    // `manifest.quickActions[]` (overlay-registry dispatch through
    // `capability-bridge-map.ts`) or imperative via
    // `ctx.quickActions.register`. Every action mirrors a command into
    // `lib/plugin/commands/registry.ts`, so dispatch reuses
    // `executeCommand` on every surface.
    id: "quick-action",
    support: "supported",
    manifestFields: ["quickActions"],
    runtimeBinding:
      "ctx.quickActions.register + quick-action-registry overlay + command-registry mirror",
    hostBindings: [
      "lib/plugin/registries/quick-action-registry.ts",
      "lib/plugin/api/quick-actions-api.ts",
      "lib/plugin/commands/registry.ts",
      "components/desktop/command-palette.tsx",
      "components/chat/composer/plugin-quick-actions-menu.tsx",
      "lib/tray/all-commands.ts",
    ],
    typescriptSdk: [
      "packages/plugin-sdk/src/context/extended.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "lib/plugin/registries/quick-action-registry.test.ts",
      "lib/plugin/contracts/capability-bridge-map.test.ts",
    ],
  },
  {
    // Declarative CLI wrapper tools (`manifest.cliTools[]`): each entry
    // wraps an external binary as an agent tool with zero plugin code —
    // JSON-schema params, injection-proof argv token templates, output
    // parsing, and exit-code policy. Execution is gated by the DANGEROUS
    // `cli:execute` permission (confirm tier), binaries resolve through
    // `requires.binaries`/detect_binary or the plugin-dir trust policy,
    // and every invocation is audited. Registered tools flow through the
    // standard registry so both the in-process and sidecar dispatch paths
    // pick them up unchanged.
    id: "cli-tools",
    // Host runtime is fully wired (validation + exec pipeline + registry
    // dispatch), but the capability is manifest-declarative only — the SDK
    // packages ship no `defineCliTool()` helper yet. Same posture as
    // `lsp-server`: experimental until a typed SDK helper exists; the host
    // contract is unaffected.
    support: "experimental",
    manifestFields: ["cliTools"],
    runtimeBinding:
      "manager.registerPluginContributions cliTools → registry.registerTool(executeCliTool)",
    hostBindings: [
      "lib/plugin/cli-tools/execute-cli-tool.ts",
      "lib/plugin/cli-tools/cli-binary-policy.ts",
      "lib/plugin/cli-tools/binary-status.ts",
      "src-tauri/src/plugin_api/cli_exec.rs",
    ],
    typescriptSdk: [],
    pythonSdk: [],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "lib/plugin/cli-tools/execute-cli-tool.test.ts",
      "lib/plugin/cli-tools/cli-binary-policy.test.ts",
    ],
  },
  {
    // Promoted experimental→supported: the two pending items are now covered.
    // Declarative surface — a tray entry that is visible before activation and
    // dispatched by command/slash — is delivered via a `quickActions` manifest
    // entry with the `"tray"` surface. SDK helper — `defineTrayItem()` ships for
    // the imperative `ctx.tray.register` shape (`PluginTrayItemInput`).
    id: "tray",
    support: "supported",
    manifestFields: [],
    runtimeBinding:
      "ctx.tray.register (PluginTrayItemInput) + declarative quickActions surface 'tray'",
    hostBindings: ["lib/plugin/api/tray-api.ts", "lib/tray/registry.ts"],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-tray-item.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py", "plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "lib/tray/registry.test.ts",
      "packages/plugin-sdk/src/define/define-tray-item.test.ts",
    ],
  },
  {
    // Computer Use automation. Gates `ctx.automation` (screenshot/click/type/…)
    // — a capability TAG (no manifest contribution field); the real surface is
    // the imperative `ctx.automation.*` API backed by the Rust automation
    // subsystem (ADR-0020). Experimental pending a typed SDK helper; the host
    // contract is fully wired. Without this entry the manifest validator
    // rejected `capabilities: ["automation"]` as unknown.
    id: "automation",
    support: "experimental",
    manifestFields: [],
    runtimeBinding: "ctx.automation.* → automation-api → src-tauri automation subsystem",
    hostBindings: [
      "lib/plugin/api/automation-api.ts",
      "lib/automation",
      "src-tauri/src/automation",
    ],
    typescriptSdk: [],
    pythonSdk: [],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "lib/plugin/api/automation-api.test.ts",
      "lib/automation/anthropic-action-mapper.test.ts",
    ],
  },
  {
    // Companion device pairing + remote-control grants. Gates `ctx.companion`
    // — a capability TAG (no manifest field); backed by the companion API +
    // the Rust companion_api subsystem. Experimental pending a typed SDK
    // helper. Without this entry the validator rejected
    // `capabilities: ["companion"]` as unknown.
    id: "companion",
    support: "experimental",
    manifestFields: [],
    runtimeBinding: "ctx.companion.* → companion-api → src-tauri companion_api subsystem",
    hostBindings: [
      "lib/plugin/api/companion-api.ts",
      "lib/companion",
      "src-tauri/src/companion_api",
    ],
    typescriptSdk: [],
    pythonSdk: [],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "lib/plugin/api/companion-api.test.ts",
      "lib/companion/desktop-message-source.test.ts",
    ],
  },
  {
    // Custom view containers (B1) — a plugin contributes a rail icon → its own
    // middle-column panel hosting its views. Declarative `manifest.viewsContainers`
    // registered through the `view-container` overlay capability on enable and
    // bulk-removed on disable. The rail (`guild-rail`) renders a button per
    // container; selecting one swaps to `plugin-view-container-panel`.
    id: "view-container",
    support: "supported",
    manifestFields: ["viewsContainers"],
    runtimeBinding:
      "manifest.viewsContainers → view-container overlay capability → guild-rail button + plugin-view-container-panel",
    hostBindings: [
      "lib/plugin/registries/view-container-registry.ts",
      "components/shell/plugin-view-container-panel.tsx",
      "lib/plugin/contracts/capability-bridge-map.ts",
    ],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-view-container.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "lib/plugin/registries/view-container-registry.test.ts",
      "components/shell/plugin-view-container-panel.test.tsx",
    ],
  },
  {
    // Tree data providers + custom React views (B2) — `manifest.views[]`
    // dynamic-imported by the view-bridge on enable and rendered into the
    // owning view container's panel. `type: "tree"` resolves a TreeDataProvider;
    // `type: "react"` resolves a panel component.
    id: "tree-view",
    support: "supported",
    manifestFields: ["views"],
    runtimeBinding:
      "manifest.views → view-bridge (MODULE_BRIDGE) → tree-view-registry → plugin-view-container-panel renders PluginTreeViewHost / PluginCustomViewHost",
    hostBindings: [
      "lib/plugin/bridge/view-bridge.ts",
      "lib/plugin/registries/tree-view-registry.ts",
      "components/plugins/plugin-tree-view-host.tsx",
      "components/plugins/plugin-custom-view-host.tsx",
      "lib/plugin/contracts/module-bridge-map.ts",
    ],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-view.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "lib/plugin/bridge/view-bridge.test.ts",
      "lib/plugin/registries/tree-view-registry.test.ts",
      "components/plugins/plugin-tree-view-host.test.tsx",
    ],
  },
  {
    // Sandboxed webview panels (B3) — `manifest.webviews[]` + the imperative
    // `ctx.webview.create`. HTML renders in an iframe sandbox="allow-scripts"
    // (no allow-same-origin) with a CSP derived from networkAccess.allowedDomains;
    // host↔iframe messaging flows over postMessage through the webview registry.
    id: "webview",
    support: "supported",
    manifestFields: ["webviews"],
    runtimeBinding:
      "manifest.webviews → plugin-webview-bridge (MODULE_BRIDGE) + ctx.webview.create → webview-registry → plugin-view-container-panel renders PluginWebviewHost (sandboxed iframe + CSP)",
    hostBindings: [
      "lib/plugin/bridge/plugin-webview-bridge.ts",
      "lib/plugin/registries/webview-registry.ts",
      "lib/plugin/security/webview-csp.ts",
      "lib/plugin/api/webview-api.ts",
      "components/plugins/plugin-webview-host.tsx",
    ],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-webview.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "lib/plugin/bridge/plugin-webview-bridge.test.ts",
      "lib/plugin/security/webview-csp.test.ts",
      "components/plugins/plugin-webview-host.test.tsx",
    ],
  },
  {
    // Native auth/OAuth provider (C1). `ctx.auth.registerProvider` (auth:provide)
    // + `ctx.auth.getSession`/`getSessions` (auth:consume), backed by the
    // promoted auth-provider registry with secrets-persisted sessions and a
    // reusable PKCE flow. The declarative `authProviders[]` is metadata for
    // validation + the consent UI.
    id: "auth-provider",
    support: "supported",
    manifestFields: ["authProviders"],
    runtimeBinding:
      "ctx.auth.registerProvider + auth-provider-registry (native backing) + auth-secrets-adapter (secrets-persisted) + auth-pkce-flow",
    hostBindings: [
      "lib/plugin/api/auth-api.ts",
      "lib/plugin/auth/auth-provider-registry.ts",
      "lib/plugin/auth/auth-secrets-adapter.ts",
      "lib/plugin/auth/auth-pkce-flow.ts",
      "lib/plugin/core/context.ts",
    ],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-auth-provider.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/types.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "lib/plugin/api/auth-api.test.ts",
      "lib/plugin/auth/auth-secrets-adapter.test.ts",
      "lib/plugin/auth/auth-pkce-flow.test.ts",
    ],
  },
  {
    // URI / deep-link handler (C2). Capability TAG (no manifest field — the
    // handler is registered imperatively via `ctx.uri.registerHandler`; the
    // contribution is the `onUri` activation event). The deep-link router
    // parses `cognia://plugin/<id>/...` and routes to the owning plugin.
    id: "uri-handler",
    support: "supported",
    manifestFields: [],
    runtimeBinding:
      "ctx.uri.registerHandler + uri-handler-registry + plugin-deep-link-router (Tauri pipe) + onUri activation",
    hostBindings: [
      "lib/plugin/api/uri-api.ts",
      "lib/plugin/uri/uri-handler-registry.ts",
      "lib/plugin/uri/parse-deep-link.ts",
      "components/plugins/plugin-deep-link-router.tsx",
      "lib/plugin/core/manager.ts",
    ],
    typescriptSdk: [
      "packages/plugin-sdk/src/define/define-uri-handler.ts",
      "packages/plugin-sdk/src/index.ts",
    ],
    pythonSdk: ["plugin-sdk/python/src/cognia/context.py"],
    docs: "docs/content/docs/en/subsystems/plugin-system/contracts-and-registries.mdx#capabilities",
    requiredTests: [
      "lib/plugin/uri/parse-deep-link.test.ts",
      "lib/plugin/uri/uri-handler-registry.test.ts",
      "lib/plugin/api/uri-api.test.ts",
    ],
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
