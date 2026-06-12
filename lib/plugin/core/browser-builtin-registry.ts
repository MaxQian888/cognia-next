import type {
  ExtensionCompatibilityDiagnostic,
  PluginDefinition,
  PluginManifest,
} from "@/types/plugin"

import clipboardHistoryManifest from "@/plugins/clipboard-history/plugin.json"
import clipboardToolsManifest from "@/plugins/clipboard-tools/plugin.json"
import githubDeliveryManifest from "@/plugins/github-delivery/plugin.json"
import promptTemplatesManifest from "@/plugins/prompt-templates/plugin.json"
import screenshotManifest from "@/plugins/screenshot/plugin.json"
import ocrManifest from "@/plugins/ocr/plugin.json"
import evalManifest from "@/plugins/eval/plugin.json"
import webToolsManifest from "@/plugins/web-tools/plugin.json"
import workflowAiManifest from "@/plugins/workflow-ai/plugin.json"
import workspaceToolsManifest from "@/plugins/workspace-tools/plugin.json"
import agentTeamExamplesManifest from "@/plugins/agent-team-examples/plugin.json"
import backendRefactorManifest from "@/plugins/cognia-backend-refactor/plugin.json"
import zhihuContentPipelineManifest from "@/plugins/zhihu-content-pipeline/plugin.json"
import appearanceDemoManifest from "@/plugins/cognia-appearance-demo/plugin.json"
import schedulingDemoManifest from "@/plugins/cognia-scheduling-demo/plugin.json"
import schedulerToolsManifest from "@/plugins/cognia-scheduler-tools/plugin.json"
import goalInsightsManifest from "@/plugins/cognia-goal-insights/plugin.json"
import shareWatchManifest from "@/plugins/cognia-share-watch/plugin.json"
import sandboxedToolsManifest from "@/plugins/cognia-sandboxed-tools/plugin.json"
import e2bSandboxManifest from "@/plugins/e2b-sandbox/plugin.json"
import computerUseManifest from "@/plugins/computer-use/plugin.json"

// Static imports for built-in plugin modules
import clipboardToolsModule from "@/plugins/clipboard-tools/src/index"
import workspaceToolsModule from "@/plugins/workspace-tools/src/index"
import webToolsModule from "@/plugins/web-tools/src/index"
import screenshotModule from "@/plugins/screenshot/src/index"
import ocrModule from "@/plugins/ocr/src/index"
import evalModule from "@/plugins/eval/src/index"
import promptTemplatesModule from "@/plugins/prompt-templates/src/index"
import clipboardHistoryModule from "@/plugins/clipboard-history/src/index"
import githubDeliveryModule from "@/plugins/github-delivery/src/index"
import workflowAiModule from "@/plugins/workflow-ai/src/index"
import agentTeamExamplesModule from "@/plugins/agent-team-examples/src/index"
import backendRefactorModule from "@/plugins/cognia-backend-refactor/src/index"
import zhihuContentPipelineModule from "@/plugins/zhihu-content-pipeline/src/index"
import appearanceDemoModule from "@/plugins/cognia-appearance-demo/src/index"
import schedulingDemoModule from "@/plugins/cognia-scheduling-demo/src/index"
import schedulerToolsModule from "@/plugins/cognia-scheduler-tools/src/index"
import goalInsightsModule from "@/plugins/cognia-goal-insights/src/index"
import shareWatchModule from "@/plugins/cognia-share-watch/src/index"
import sandboxedToolsModule from "@/plugins/cognia-sandboxed-tools/src/index"
import e2bSandboxModule from "@/plugins/e2b-sandbox/src/index"
import computerUseModule from "@/plugins/computer-use/src/index"

export interface BrowserBuiltinRegistryEntry {
  manifest: PluginManifest
  path: string
  compatibilityDiagnostics: ExtensionCompatibilityDiagnostic[]
  load?: () => Promise<PluginDefinition>
}

function resolvePluginModule(mod: unknown): PluginDefinition {
  return (mod as { default?: PluginDefinition }).default || (mod as PluginDefinition)
}

/**
 * Build a builtin entry's discovery manifest by overlaying the module
 * definition's manifest on top of the plugin.json base.
 *
 * The declarative contribution arrays (workflowTemplates / skills /
 * mcpServerPresets / characterPacks / agentTeamTemplates / subagents /
 * dexie / i18n) are authored in TypeScript on the module manifest, next to
 * the runtime values they reference (custom node kinds, prompt constants) —
 * plugin.json cannot hold them. Discovery (`scanBrowserBuiltins`) persists
 * the manifest it gets here into the plugin store, and the manager's
 * `OVERLAY_REGISTRY_CAPABILITIES` dispatch loop plus the dexie/i18n enable
 * steps read those fields from the store record. Without this merge they
 * read fields that don't exist and silently skip every declarative
 * contribution (the bug that left e.g. the zhihu-content-pipeline workflow
 * template unregistered).
 *
 * plugin.json stays the base so identity/compat fields the module manifest
 * omits (description, author, license, engines, activationEvents,
 * runtimeCompatibility) survive; `id` stays authoritative from the JSON.
 */
export function builtinManifest(jsonManifest: unknown, mod: unknown): PluginManifest {
  const base = jsonManifest as PluginManifest
  const rich = resolvePluginModule(mod)?.manifest as PluginManifest | undefined
  if (!rich) return base
  return { ...base, ...rich, id: base.id }
}

const browserBuiltins: BrowserBuiltinRegistryEntry[] = [
  {
    manifest: builtinManifest(clipboardToolsManifest, clipboardToolsModule),
    path: "builtin://cognia-clipboard-tools",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(clipboardToolsModule),
  },
  {
    manifest: builtinManifest(workspaceToolsManifest, workspaceToolsModule),
    path: "builtin://cognia-workspace-tools",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(workspaceToolsModule),
  },
  {
    manifest: builtinManifest(webToolsManifest, webToolsModule),
    path: "builtin://cognia-web-tools",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(webToolsModule),
  },
  {
    manifest: builtinManifest(screenshotManifest, screenshotModule),
    path: "builtin://cognia-screenshot",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(screenshotModule),
  },
  {
    manifest: builtinManifest(ocrManifest, ocrModule),
    path: "builtin://cognia-ocr",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(ocrModule),
  },
  {
    manifest: builtinManifest(evalManifest, evalModule),
    path: "builtin://cognia-eval",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(evalModule),
  },
  {
    manifest: builtinManifest(promptTemplatesManifest, promptTemplatesModule),
    path: "builtin://cognia-prompt-templates",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(promptTemplatesModule),
  },
  {
    manifest: builtinManifest(clipboardHistoryManifest, clipboardHistoryModule),
    path: "builtin://cognia-clipboard-history",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(clipboardHistoryModule),
  },
  {
    manifest: builtinManifest(githubDeliveryManifest, githubDeliveryModule),
    path: "builtin://github-delivery",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(githubDeliveryModule),
  },
  {
    manifest: builtinManifest(workflowAiManifest, workflowAiModule),
    path: "builtin://cognia-workflow-ai",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(workflowAiModule),
  },
  {
    manifest: builtinManifest(agentTeamExamplesManifest, agentTeamExamplesModule),
    path: "builtin://cognia-agent-team-examples",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(agentTeamExamplesModule),
  },
  {
    manifest: builtinManifest(backendRefactorManifest, backendRefactorModule),
    path: "builtin://cognia-backend-refactor",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(backendRefactorModule),
  },
  {
    manifest: builtinManifest(zhihuContentPipelineManifest, zhihuContentPipelineModule),
    path: "builtin://zhihu-content-pipeline",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(zhihuContentPipelineModule),
  },
  {
    manifest: builtinManifest(appearanceDemoManifest, appearanceDemoModule),
    path: "builtin://cognia-appearance-demo",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(appearanceDemoModule),
  },
  {
    manifest: builtinManifest(schedulingDemoManifest, schedulingDemoModule),
    path: "builtin://cognia-scheduling-demo",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(schedulingDemoModule),
  },
  {
    manifest: builtinManifest(schedulerToolsManifest, schedulerToolsModule),
    path: "builtin://cognia-scheduler-tools",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(schedulerToolsModule),
  },
  {
    manifest: builtinManifest(goalInsightsManifest, goalInsightsModule),
    path: "builtin://cognia-goal-insights",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(goalInsightsModule),
  },
  {
    manifest: builtinManifest(shareWatchManifest, shareWatchModule),
    path: "builtin://cognia-share-watch",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(shareWatchModule),
  },
  {
    manifest: builtinManifest(sandboxedToolsManifest, sandboxedToolsModule),
    path: "builtin://cognia-sandboxed-tools",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(sandboxedToolsModule),
  },
  {
    manifest: builtinManifest(e2bSandboxManifest, e2bSandboxModule),
    path: "builtin://cognia-e2b-sandbox",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(e2bSandboxModule),
  },
  {
    // ADR-0020 — the Computer Use plugin registers the three chat-path
    // plugin MCP tools (computer_use / bash / text_editor), the native
    // Anthropic tool defs, the `/cu` slash command, the screen-watcher /
    // gui-driver subagents and the desktop-automation team template. It is
    // `browser: blocked` / `tauri: degraded` (needs the Rust automation
    // backend), so the compatibility policy gates it at enable time on the
    // browser profile — but it must still be DISCOVERED here, exactly like
    // the screenshot / clipboard-history native plugins above, or the entire
    // chat-driven Computer Use surface stays dormant.
    manifest: builtinManifest(computerUseManifest, computerUseModule),
    path: "builtin://cognia-computer-use",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(computerUseModule),
  },
]

export function getBrowserBuiltinRegistry(): BrowserBuiltinRegistryEntry[] {
  return browserBuiltins.map((entry) => ({
    ...entry,
    compatibilityDiagnostics: [...entry.compatibilityDiagnostics],
  }))
}

export function getBrowserBuiltinRegistryEntry(
  pluginId: string
): BrowserBuiltinRegistryEntry | undefined {
  return browserBuiltins.find((entry) => entry.manifest.id === pluginId)
}
