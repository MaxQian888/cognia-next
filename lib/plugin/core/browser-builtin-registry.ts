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
import webToolsManifest from "@/plugins/web-tools/plugin.json"
import workflowAiManifest from "@/plugins/workflow-ai/plugin.json"
import workspaceToolsManifest from "@/plugins/workspace-tools/plugin.json"
import agentTeamExamplesManifest from "@/plugins/agent-team-examples/plugin.json"

// Static imports for built-in plugin modules
import clipboardToolsModule from "@/plugins/clipboard-tools/src/index"
import workspaceToolsModule from "@/plugins/workspace-tools/src/index"
import webToolsModule from "@/plugins/web-tools/src/index"
import screenshotModule from "@/plugins/screenshot/src/index"
import promptTemplatesModule from "@/plugins/prompt-templates/src/index"
import clipboardHistoryModule from "@/plugins/clipboard-history/src/index"
import githubDeliveryModule from "@/plugins/github-delivery/src/index"
import workflowAiModule from "@/plugins/workflow-ai/src/index"
import agentTeamExamplesModule from "@/plugins/agent-team-examples/src/index"

export interface BrowserBuiltinRegistryEntry {
  manifest: PluginManifest
  path: string
  compatibilityDiagnostics: ExtensionCompatibilityDiagnostic[]
  load?: () => Promise<PluginDefinition>
}

function asPluginManifest(manifest: unknown): PluginManifest {
  return manifest as PluginManifest
}

function resolvePluginModule(mod: unknown): PluginDefinition {
  return (mod as { default?: PluginDefinition }).default || (mod as PluginDefinition)
}

const browserBuiltins: BrowserBuiltinRegistryEntry[] = [
  {
    manifest: asPluginManifest(clipboardToolsManifest),
    path: "builtin://cognia-clipboard-tools",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(clipboardToolsModule),
  },
  {
    manifest: asPluginManifest(workspaceToolsManifest),
    path: "builtin://cognia-workspace-tools",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(workspaceToolsModule),
  },
  {
    manifest: asPluginManifest(webToolsManifest),
    path: "builtin://cognia-web-tools",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(webToolsModule),
  },
  {
    manifest: asPluginManifest(screenshotManifest),
    path: "builtin://cognia-screenshot",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(screenshotModule),
  },
  {
    manifest: asPluginManifest(promptTemplatesManifest),
    path: "builtin://cognia-prompt-templates",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(promptTemplatesModule),
  },
  {
    manifest: asPluginManifest(clipboardHistoryManifest),
    path: "builtin://cognia-clipboard-history",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(clipboardHistoryModule),
  },
  {
    manifest: asPluginManifest(githubDeliveryManifest),
    path: "builtin://github-delivery",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(githubDeliveryModule),
  },
  {
    manifest: asPluginManifest(workflowAiManifest),
    path: "builtin://cognia-workflow-ai",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(workflowAiModule),
  },
  {
    manifest: asPluginManifest(agentTeamExamplesManifest),
    path: "builtin://cognia-agent-team-examples",
    compatibilityDiagnostics: [],
    load: async () => resolvePluginModule(agentTeamExamplesModule),
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
