import type React from "react"
import type { PluginManifest } from "@/types/plugin/plugin"
import type { ExtensionProps } from "@/types/plugin/plugin"
import { clearPluginExtensions, createExtensionAPI } from "@/lib/plugin/api/extension-api"
import { loggers } from "@/lib/plugin/core/logger"
import { resolvePluginPath } from "@/lib/plugin/core/plugin-path"

export interface ExtensionBridgeError {
  pluginId: string
  point: string
  message: string
}

export interface ExtensionBridgeResult {
  registered: number
  errors: ExtensionBridgeError[]
}

export interface RegisterExtensionsOptions {
  importer: (entry: string) => Promise<Record<string, unknown>>
  hasPermission: (permission: string) => boolean
}

/**
 * Resolve and register manifest-declared extension components. This runs
 * before `activate()` so discovery UI and extension hosts see the declarative
 * contract independently from imperative plugin startup.
 */
export async function registerExtensionsForPlugin(
  manifest: PluginManifest,
  installRoot: string,
  options: RegisterExtensionsOptions
): Promise<ExtensionBridgeResult> {
  const definitions = manifest.extensions ?? []
  clearPluginExtensions(manifest.id)
  if (definitions.length === 0) return { registered: 0, errors: [] }

  const api = createExtensionAPI(manifest.id, {
    governanceMode: "block",
    hasPermission: options.hasPermission,
  })
  const errors: ExtensionBridgeError[] = []
  let registered = 0

  for (const definition of definitions) {
    try {
      const resolvedEntry = resolvePluginPath(installRoot, definition.entry)
      const importedModule = await options.importer(resolvedEntry)
      const exported = importedModule[definition.export]
      if (typeof exported !== "function") {
        throw new Error(
          `entry "${definition.entry}" has no React export named "${definition.export}"`
        )
      }
      api.registerExtension(definition.point, exported as React.ComponentType<ExtensionProps>, {
        priority: definition.priority,
        labelKey: definition.labelKey,
        when: definition.when,
        minWidth: definition.minWidth,
        maxWidth: definition.maxWidth,
      })
      registered += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push({ pluginId: manifest.id, point: definition.point, message })
      loggers.manager.error(
        `[extension-bridge] failed to register ${manifest.id} at "${definition.point}"`,
        error
      )
    }
  }

  return { registered, errors }
}
