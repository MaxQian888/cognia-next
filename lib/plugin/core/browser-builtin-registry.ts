import type {
  ExtensionCompatibilityDiagnostic,
  PluginDefinition,
  PluginManifest,
} from "@/types/plugin"

import clipboardToolsManifest from "../../../plugins/clipboard-tools/plugin.json"
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
    compatibilityDiagnostics: [
      {
        code: "runtime.browser.unsupported",
        severity: "error",
        message:
          "Workspace Tools currently require native filesystem capabilities and are desktop-only in browser runtime.",
        hint: "Use the desktop app for workspace filesystem workflows.",
      },
    ],
  },
  {
    manifest: asPluginManifest(webToolsManifest),
    path: "builtin://cognia-web-tools",
    compatibilityDiagnostics: [
      {
        code: "runtime.browser.unsupported",
        severity: "error",
        message:
          "Web Tools currently depend on desktop-oriented download path handling and are not enabled in browser runtime yet.",
        hint: "Use the desktop app until browser-safe download and path handling are implemented.",
      },
    ],
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
