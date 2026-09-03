import type {
  ExtensionCompatibilityDiagnostic,
  PluginDefinition,
  PluginManifest,
} from "@/types/plugin"
import type { PluginSharedModule } from "./shared-modules"
import browserBuiltinAssets from "./browser-builtin-assets.generated.json"

import clipboardHistoryManifest from "@/plugins/clipboard-history/plugin.json"
import clipboardToolsManifest from "@/plugins/clipboard-tools/plugin.json"
import promptTemplatesManifest from "@/plugins/prompt-templates/plugin.json"
import screenshotManifest from "@/plugins/screenshot/plugin.json"
import webCloneManifest from "@/plugins/web-clone/plugin.json"
import ocrManifest from "@/plugins/ocr/plugin.json"
import evalManifest from "@/plugins/eval/plugin.json"
import webToolsManifest from "@/plugins/web-tools/plugin.json"
import workflowAiManifest from "@/plugins/workflow-ai/plugin.json"
import workspaceToolsManifest from "@/plugins/workspace-tools/plugin.json"
import agentTeamExamplesManifest from "@/plugins/agent-team-examples/plugin.json"
import backendRefactorManifest from "@/plugins/cognia-backend-refactor/plugin.json"
import workModeManifest from "@/plugins/cognia-work-mode/plugin.json"
import zhihuContentPipelineManifest from "@/plugins/zhihu-content-pipeline/plugin.json"
import appearanceDemoManifest from "@/plugins/cognia-appearance-demo/plugin.json"
import arknightsThemeManifest from "@/plugins/cognia-arknights-theme/plugin.json"
import schedulingDemoManifest from "@/plugins/cognia-scheduling-demo/plugin.json"
import schedulerToolsManifest from "@/plugins/cognia-scheduler-tools/plugin.json"
import goalInsightsManifest from "@/plugins/cognia-goal-insights/plugin.json"
import shareWatchManifest from "@/plugins/cognia-share-watch/plugin.json"
import sandboxedToolsManifest from "@/plugins/cognia-sandboxed-tools/plugin.json"
import e2bSandboxManifest from "@/plugins/e2b-sandbox/plugin.json"
import computerUseManifest from "@/plugins/computer-use/plugin.json"
import anthropicSkillsManifest from "@/plugins/anthropic-skills/plugin.json"
import deepResearchManifest from "@/plugins/deep-research/plugin.json"
import builtinCharactersManifest from "@/plugins/cognia-builtin-characters/plugin.json"
import playwrightMcpManifest from "@/plugins/playwright-mcp/plugin.json"
import stagehandMcpManifest from "@/plugins/stagehand-mcp/plugin.json"
import ripgrepToolsManifest from "@/plugins/ripgrep-tools/plugin.json"
import skillRecorderManifest from "@/plugins/skill-recorder/plugin.json"
import browserToolsManifest from "@/plugins/browser-tools/plugin.json"
import petDailyQuestsManifest from "@/plugins/pet-daily-quests/plugin.json"
import strixSecurityManifest from "@/plugins/strix-security/plugin.json"
import contextInspectorManifest from "@/plugins/context-inspector/plugin.json"
import uiSurfaceReferenceManifest from "@/plugins/ui-surface-reference/plugin.json"
import sreAgentManifest from "@/plugins/sre-agent/plugin.json"
import githubDeliveryManifest from "@/plugins/github-delivery/plugin.json"
import figmaExternalServiceManifest from "@/plugins/figma-external-service/plugin.json"
import animeEffortManifest from "@/plugins/cognia-anime-effort/plugin.json"

// Static imports for built-in plugin modules
import clipboardToolsModule from "@/plugins/clipboard-tools/src/index"
import workspaceToolsModule from "@/plugins/workspace-tools/src/index"
import webToolsModule from "@/plugins/web-tools/src/index"
import screenshotModule from "@/plugins/screenshot/src/index"
import webCloneModule from "@/plugins/web-clone/src/index"
import ocrModule from "@/plugins/ocr/src/index"
import evalModule from "@/plugins/eval/src/index"
import promptTemplatesModule from "@/plugins/prompt-templates/src/index"
import clipboardHistoryModule from "@/plugins/clipboard-history/src/index"
import workflowAiModule from "@/plugins/workflow-ai/src/index"
import agentTeamExamplesModule from "@/plugins/agent-team-examples/src/index"
import backendRefactorModule from "@/plugins/cognia-backend-refactor/src/index"
import workModeModule from "@/plugins/cognia-work-mode/src/index"
import zhihuContentPipelineModule from "@/plugins/zhihu-content-pipeline/src/index"
import appearanceDemoModule from "@/plugins/cognia-appearance-demo/src/index"
import arknightsThemeModule from "@/plugins/cognia-arknights-theme/src/index"
import schedulingDemoModule from "@/plugins/cognia-scheduling-demo/src/index"
import schedulerToolsModule from "@/plugins/cognia-scheduler-tools/src/index"
import goalInsightsModule from "@/plugins/cognia-goal-insights/src/index"
import shareWatchModule from "@/plugins/cognia-share-watch/src/index"
import sandboxedToolsModule from "@/plugins/cognia-sandboxed-tools/src/index"
import e2bSandboxModule from "@/plugins/e2b-sandbox/src/index"
import computerUseModule from "@/plugins/computer-use/src/index"
import anthropicSkillsModule from "@/plugins/anthropic-skills/src/index"
import deepResearchModule from "@/plugins/deep-research/src/index"
import builtinCharactersModule from "@/plugins/cognia-builtin-characters/src/index"
import playwrightMcpModule from "@/plugins/playwright-mcp/src/index"
import stagehandMcpModule from "@/plugins/stagehand-mcp/src/index"
import ripgrepToolsModule from "@/plugins/ripgrep-tools/src/index"
import skillRecorderModule from "@/plugins/skill-recorder/src/index"
import browserToolsModule from "@/plugins/browser-tools/src/index"
import petDailyQuestsModule from "@/plugins/pet-daily-quests/src/index"
import strixSecurityModule from "@/plugins/strix-security/src/index"
import contextInspectorModule from "@/plugins/context-inspector/src/index"
import * as uiSurfaceReferenceModule from "@/plugins/ui-surface-reference/src/index"
import sreAgentModule from "@/plugins/sre-agent/src/index"
import * as githubDeliveryModule from "@/plugins/github-delivery/src/index"
import figmaExternalServiceModule from "@/plugins/figma-external-service/src/index"
import * as animeEffortModule from "@/plugins/cognia-anime-effort/src/index"

export interface BrowserBuiltinAsset {
  url: string
  sha256: string
  sharedModules: PluginSharedModule[]
  stylesUrl?: string
}

export interface BrowserBuiltinRegistryEntry {
  manifest: PluginManifest
  path: `builtin://${string}`
  compatibilityDiagnostics: ExtensionCompatibilityDiagnostic[]
  asset?: BrowserBuiltinAsset
  load?: () => Promise<PluginDefinition>
  /**
   * Full module export namespace, cached by the loader as the plugin's
   * `moduleExports`. Set this only for built-ins whose manifest declares
   * `connectors[]` (or any other bridge that resolves a factory by name from
   * exports) — otherwise the loader falls back to `{ default: definition }`,
   * which drops the named factory functions and the bridge skips them.
   */
  moduleExports?: Record<string, unknown>
  /** Bundled source for a built-in manifest.styles entry. */
  bundledStyles?: string
}

/**
 * One entry from the generated asset catalog, copied out of it.
 *
 * The catalog is an imported JSON module object, so `entries[pluginId]` is a
 * live reference into it and `browserBuiltins` below is long-lived. Copying
 * here — rather than at each of the five call sites — keeps the registry from
 * aliasing module state, and keeps `compatibilityDiagnostics` an array this
 * registry owns, like every hand-written entry's.
 */
function generatedBuiltin(pluginId: string): BrowserBuiltinRegistryEntry {
  const entries = browserBuiltinAssets.entries as unknown as Record<
    string,
    BrowserBuiltinRegistryEntry
  >
  const entry = entries[pluginId]
  if (!entry) throw new Error(`Missing generated browser builtin asset for ${pluginId}`)
  return { ...entry, compatibilityDiagnostics: [...(entry.compatibilityDiagnostics ?? [])] }
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
    manifest: builtinManifest(webCloneManifest, webCloneModule),
    path: "builtin://cognia-web-clone",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(webCloneModule),
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
    // Reference consumer for declarative webview-backed context panels: the
    // module manifest carries `webviews[]` + `contextPanels[]`, so enabling it
    // exercises the whole declarative chain end to end.
    manifest: builtinManifest(contextInspectorManifest, contextInspectorModule),
    path: "builtin://cognia-context-inspector",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(contextInspectorModule),
  },
  {
    manifest: builtinManifest(uiSurfaceReferenceManifest, uiSurfaceReferenceModule),
    path: "builtin://ui-surface-reference",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(uiSurfaceReferenceModule),
    moduleExports: uiSurfaceReferenceModule as unknown as Record<string, unknown>,
    bundledStyles: uiSurfaceReferenceModule.REFERENCE_PLUGIN_CSS,
  },
  {
    manifest: builtinManifest(animeEffortManifest, animeEffortModule),
    path: "builtin://cognia-anime-effort",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(animeEffortModule),
    // Required, not optional: the manifest declares `extensions[]`, and the
    // bridge resolves `AnimeEffortControl` by name out of these exports. The
    // `{ default: definition }` fallback drops it and the composer slot renders
    // nothing.
    moduleExports: animeEffortModule as unknown as Record<string, unknown>,
    bundledStyles: animeEffortModule.ANIME_EFFORT_CSS,
  },
  {
    manifest: builtinManifest(clipboardHistoryManifest, clipboardHistoryModule),
    path: "builtin://cognia-clipboard-history",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(clipboardHistoryModule),
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
  generatedBuiltin("cognia-office"),
  generatedBuiltin("cognia-pdf"),
  generatedBuiltin("cognia-documents"),
  generatedBuiltin("cognia-visualize"),
  generatedBuiltin("cognia-presentations"),
  {
    // Outcome-to-deliverable Work experience. Its rich module manifest carries
    // the mode, skills, specialist subagents, and team template; activate()
    // registers the artifact/review/parallel-dispatch tools.
    manifest: builtinManifest(workModeManifest, workModeModule),
    path: "builtin://cognia-work-mode",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(workModeModule),
  },
  {
    // Read-only incident diagnostician. The packaged manifest materializes
    // both tool contracts and its subagent so discovery, consent, and the
    // runtime registry all observe the same contribution graph.
    manifest: builtinManifest(sreAgentManifest, sreAgentModule),
    path: "builtin://sre-agent",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(sreAgentModule),
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
    manifest: builtinManifest(arknightsThemeManifest, arknightsThemeModule),
    path: "builtin://cognia-arknights-theme",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(arknightsThemeModule),
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
  {
    // Bundled Agent Skills (code-review / data-analysis / web-research). The
    // `skills` array lives on the module manifest, so the builtinManifest
    // merge is what feeds the overlay walker.
    manifest: builtinManifest(anthropicSkillsManifest, anthropicSkillsModule),
    path: "builtin://cognia-anthropic-skills",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(anthropicSkillsModule),
  },
  {
    // Self-contained DeepResearch agent — `/research` slash + `deep_research`
    // tool + skill, all registered imperatively in activate().
    manifest: builtinManifest(deepResearchManifest, deepResearchModule),
    path: "builtin://cognia-deep-research",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(deepResearchModule),
  },
  {
    // The six default Cognia personas (ADR-0030, v49). The `characterPacks`
    // array rides on the module manifest; discovering+enabling this plugin
    // registers the overlay so `listCharacters`' clone-hides-overlay dedupe
    // and the Apply-Update flow resolve a live overlay character instead of
    // falling back to the static def. Without this entry the overlay half of
    // the v49 design stays dormant.
    manifest: builtinManifest(builtinCharactersManifest, builtinCharactersModule),
    path: "builtin://cognia-builtin-characters",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(builtinCharactersModule),
  },
  {
    // Microsoft Playwright MCP preset. Runtime is Tauri-only (npx stdio MCP),
    // but — exactly like computer-use / e2b-sandbox above — it must still be
    // DISCOVERED on the browser profile; the compatibility policy gates it at
    // enable time, not discovery.
    manifest: builtinManifest(playwrightMcpManifest, playwrightMcpModule),
    path: "builtin://cognia-playwright-mcp",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(playwrightMcpModule),
  },
  {
    // Browserbase Stagehand MCP preset. Tauri-only at runtime; discovered here
    // for parity with the other MCP-preset builtins.
    manifest: builtinManifest(stagehandMcpManifest, stagehandMcpModule),
    path: "builtin://cognia-stagehand-mcp",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(stagehandMcpModule),
  },
  {
    // Declarative ripgrep CLI wrapper (`manifest.cliTools`, zero plugin code).
    // Tauri-only (cli:execute); discovered here so the `ripgrep_search` agent
    // tool is materialized for parity with the other bundled tool plugins.
    manifest: builtinManifest(ripgrepToolsManifest, ripgrepToolsModule),
    path: "builtin://ripgrep-tools",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(ripgrepToolsModule),
  },
  {
    // Record-and-replay skill recorder. `browser: blocked` (needs the native
    // record_* Tauri commands), but discovered here like computer-use so the
    // `/record-skill` command + status tool materialize on every shell; the
    // compatibility policy gates it at enable time, not discovery.
    manifest: builtinManifest(skillRecorderManifest, skillRecorderModule),
    path: "builtin://cognia-skill-recorder",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(skillRecorderModule),
  },
  {
    // ADR-0055 — agent browser loop over the embedded preview webview
    // (browser_navigate / browser_snapshot / browser_click|type|fill_form|
    // select|hover / browser_read_console|network / browser_get_page). Its
    // manifest declares all three runtime profiles supported (ADR-0085 gave the
    // web/mobile shells a remote Chromium backend), but it must still be
    // DISCOVERED here like computer-use / skill-recorder, or the whole agent
    // browser surface stays dormant; the compatibility policy gates it at
    // enable time, not discovery.
    manifest: builtinManifest(browserToolsManifest, browserToolsModule),
    path: "builtin://cognia-browser-tools",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(browserToolsModule),
  },
  {
    // Optional GitHub integration. The full namespace is required because the
    // integration bridge resolves providers, normalizers, and action handlers
    // by their exported names rather than through the default definition.
    manifest: builtinManifest(githubDeliveryManifest, githubDeliveryModule),
    path: "builtin://github-delivery",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(githubDeliveryModule),
    moduleExports: githubDeliveryModule as unknown as Record<string, unknown>,
  },
  {
    // Protocol-conformance reference: all Figma-specific endpoints, Skills,
    // availability, and risk overlays remain in the plugin manifest.
    manifest: builtinManifest(figmaExternalServiceManifest, figmaExternalServiceModule),
    path: "builtin://figma-external-service",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(figmaExternalServiceModule),
  },
  {
    manifest: builtinManifest(petDailyQuestsManifest, petDailyQuestsModule),
    path: "builtin://pet-daily-quests",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(petDailyQuestsModule),
  },
  {
    // Strix autonomous pentest CLI wrapper. `browser`/`mobile` blocked (shells
    // out to strix + a local Docker daemon); discovered here so the
    // `/security` command materializes on the desktop shell. Its panel lives
    // in the right-hand Context Workbench, not in a left-rail view container:
    // the manifest declares no `viewsContainers` at all, and this comment
    // claimed one for long enough to be worth saying so. The compatibility
    // policy gates it at enable time, not discovery.
    manifest: builtinManifest(strixSecurityManifest, strixSecurityModule),
    path: "builtin://strix-security",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(strixSecurityModule),
  },
]

function isBrowserBuiltinAvailable(entry: BrowserBuiltinRegistryEntry): boolean {
  if (
    process.env.NEXT_PUBLIC_E2E === "1" &&
    typeof window !== "undefined" &&
    window.location.pathname === "/e2e/plugin-ui-surfaces"
  ) {
    return entry.manifest.id === "ui-surface-reference"
  }
  return entry.manifest.id !== "ui-surface-reference" || process.env.NEXT_PUBLIC_E2E === "1"
}

export function getBrowserBuiltinRegistry(): BrowserBuiltinRegistryEntry[] {
  return browserBuiltins.filter(isBrowserBuiltinAvailable).map((entry) => ({
    ...entry,
    compatibilityDiagnostics: [...entry.compatibilityDiagnostics],
  }))
}

export function getBrowserBuiltinRegistryEntry(
  pluginId: string
): BrowserBuiltinRegistryEntry | undefined {
  return browserBuiltins.find(
    (entry) => entry.manifest.id === pluginId && isBrowserBuiltinAvailable(entry)
  )
}
