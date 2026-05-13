import type {
  ExtensionCompatibilityDiagnostic,
  PluginDefinition,
  PluginManifest,
} from "@/types/plugin"

import clipboardHistoryManifest from "../../../plugins/clipboard-history/plugin.json"
import clipboardToolsManifest from "../../../plugins/clipboard-tools/plugin.json"
import githubDeliveryManifest from "../../../plugins/github-delivery/plugin.json"
import promptTemplatesManifest from "../../../plugins/prompt-templates/plugin.json"
import screenshotManifest from "../../../plugins/screenshot/plugin.json"
import webToolsManifest from "../../../plugins/web-tools/plugin.json"
import workspaceToolsManifest from "../../../plugins/workspace-tools/plugin.json"

export interface BrowserBuiltinRegistryEntry {
  manifest: PluginManifest
  path: string
  compatibilityDiagnostics: ExtensionCompatibilityDiagnostic[]
  load?: () => Promise<PluginDefinition>
}

function asPluginManifest(manifest: unknown): PluginManifest {
  return manifest as PluginManifest
}

const browserBuiltins: BrowserBuiltinRegistryEntry[] = [
  {
    manifest: asPluginManifest(clipboardToolsManifest),
    path: "builtin://cognia-clipboard-tools",
    compatibilityDiagnostics: [],
    load: async () => {
      const mod = await import("../../../plugins/clipboard-tools/src/index")
      return (mod.default || mod) as PluginDefinition
    },
  },
  {
    manifest: asPluginManifest(workspaceToolsManifest),
    path: "builtin://cognia-workspace-tools",
    compatibilityDiagnostics: [],
    load: async () => {
      const mod = await import("../../../plugins/workspace-tools/src/index")
      return (mod.default || mod) as PluginDefinition
    },
  },
  {
    manifest: asPluginManifest(webToolsManifest),
    path: "builtin://cognia-web-tools",
    compatibilityDiagnostics: [],
    load: async () => {
      const mod = await import("../../../plugins/web-tools/src/index")
      return (mod.default || mod) as PluginDefinition
    },
  },
  {
    manifest: asPluginManifest(screenshotManifest),
    path: "builtin://cognia-screenshot",
    compatibilityDiagnostics: [],
    load: async () => {
      const mod = await import("../../../plugins/screenshot/src/index")
      return (mod.default || mod) as PluginDefinition
    },
  },
  {
    manifest: asPluginManifest(promptTemplatesManifest),
    path: "builtin://cognia-prompt-templates",
    compatibilityDiagnostics: [],
    load: async () => {
      const mod = await import("../../../plugins/prompt-templates/src/index")
      return (mod.default || mod) as PluginDefinition
    },
  },
  {
    manifest: asPluginManifest(clipboardHistoryManifest),
    path: "builtin://cognia-clipboard-history",
    compatibilityDiagnostics: [],
    load: async () => {
      const mod = await import("../../../plugins/clipboard-history/src/index")
      return (mod.default || mod) as PluginDefinition
    },
  },
  {
    manifest: asPluginManifest(githubDeliveryManifest),
    path: "builtin://github-delivery",
    compatibilityDiagnostics: [],
    load: async () => {
      const mod = await import("../../../plugins/github-delivery/src/index")
      return (mod.default || mod) as PluginDefinition
    },
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
