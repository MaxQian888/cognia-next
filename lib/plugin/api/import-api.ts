/**
 * Plugin Import API implementation — the symmetric counterpart of
 * `export-api.ts`. A per-plugin registry of content importers plus a runner
 * that dispatches to the importer registered for a given format. The importer's
 * `import()` parses raw content and returns whatever the plugin needs; what to
 * do with the parsed result is up to the plugin (via other `ctx.*` APIs).
 */

import { createPluginSystemLogger } from "../core/logger"
import { createApiGuardedAPI } from "./api-permission-gate"
import { registerSessionSource } from "@/lib/session-import/registry"
import type { AgentSessionSourceAdapter } from "@/lib/session-import/types"
import type {
  CustomImporter,
  ImportResult,
  ImportSource,
  PluginImportAPI,
} from "@/types/plugin/plugin"

// Registry for custom importers, keyed by the namespaced `${pluginId}:${id}`.
const customImporters = new Map<string, CustomImporter>()

/** Create the Import API for a plugin. */
export function createImportAPI(pluginId: string): PluginImportAPI {
  const logger = createPluginSystemLogger(pluginId)
  const api: PluginImportAPI = {
    registerImporter: <T = unknown>(importer: CustomImporter<T>) => {
      const importerId = `${pluginId}:${importer.id}`
      customImporters.set(importerId, { ...importer, id: importerId } as CustomImporter)
      logger.info(`Registered importer: ${importer.name}`)
      return () => {
        customImporters.delete(importerId)
        logger.info(`Unregistered importer: ${importer.name}`)
      }
    },

    getCustomImporters: (): CustomImporter[] => Array.from(customImporters.values()),

    registerSessionSource: (adapter: AgentSessionSourceAdapter) => {
      const dispose = registerSessionSource(adapter, { pluginId })
      logger.info(`Registered session source: ${adapter.id}`)
      return () => {
        dispose()
        logger.info(`Unregistered session source: ${adapter.id}`)
      }
    },

    importContent: async (source: ImportSource, format: string): Promise<ImportResult> => {
      const importer = Array.from(customImporters.values()).find((i) => i.format === format)
      if (!importer) {
        return { success: false, error: `No importer registered for format: ${format}` }
      }
      try {
        return await importer.import(source)
      } catch (error) {
        logger.error("Custom import failed:", error)
        return {
          success: false,
          error: error instanceof Error ? error.message : "Custom import failed",
        }
      }
    },
  }

  // Every current method only operates on the plugin's OWN registered
  // importers/adapters (no user-data access) — the wrap exists so any future
  // method added without a mapping fails closed instead of shipping ungated.
  return createApiGuardedAPI(
    pluginId,
    api,
    {},
    {
      unguarded: [
        "registerImporter",
        "getCustomImporters",
        "registerSessionSource",
        "importContent",
      ],
    }
  )
}

/** Clear all custom importers (test isolation). */
export function clearCustomImporters(): void {
  customImporters.clear()
}
