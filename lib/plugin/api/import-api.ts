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
import { registerChatImporter, unregisterChatImporter } from "@/lib/data/import-registry"
import type { ChatImporter } from "@/lib/data/importers/types"
import type {
  CustomImporter,
  ImportResult,
  ImportSource,
  PluginChatImporter,
  PluginImportAPI,
} from "@/types/plugin/plugin"

interface RegisteredCustomImporter {
  ownerPluginId: string
  importer: CustomImporter
}

// Registry for custom importers, keyed by the namespaced `${pluginId}:${id}`.
const customImporters = new Map<string, RegisteredCustomImporter>()

/** Create the Import API for a plugin. */
export function createImportAPI(pluginId: string): PluginImportAPI {
  const logger = createPluginSystemLogger(pluginId)
  const api: PluginImportAPI = {
    registerImporter: <T = unknown>(importer: CustomImporter<T>) => {
      const importerId = `${pluginId}:${importer.id}`
      customImporters.set(importerId, {
        ownerPluginId: pluginId,
        importer: { ...importer, id: importerId } as CustomImporter,
      })
      logger.info(`Registered importer: ${importer.name}`)
      return () => {
        customImporters.delete(importerId)
        logger.info(`Unregistered importer: ${importer.name}`)
      }
    },

    getCustomImporters: (): CustomImporter[] =>
      Array.from(customImporters.entries())
        .filter(([, registration]) => registration.ownerPluginId === pluginId)
        .map(([, registration]) => registration.importer),

    registerSessionSource: (adapter: AgentSessionSourceAdapter) => {
      const dispose = registerSessionSource(adapter, { pluginId })
      logger.info(`Registered session source: ${adapter.id}`)
      return () => {
        dispose()
        logger.info(`Unregistered session source: ${adapter.id}`)
      }
    },

    registerChatImporter: <T = unknown>(importer: PluginChatImporter<T>) => {
      // Namespace the format so a plugin can neither claim a built-in id nor
      // collide with another plugin. `detectFormat` runs the static registry
      // first, so a built-in always wins a tie regardless.
      const chatImporter: ChatImporter<T> = {
        format: `${pluginId}:${importer.format}`,
        label: importer.label,
        detect: importer.detect,
        parse: importer.parse,
      }
      registerChatImporter(chatImporter, { pluginId })
      logger.info(`Registered chat importer: ${importer.label} (${chatImporter.format})`)
      return () => {
        unregisterChatImporter(chatImporter)
        logger.info(`Unregistered chat importer: ${chatImporter.format}`)
      }
    },

    importContent: async (source: ImportSource, format: string): Promise<ImportResult> => {
      const importerId = format.includes(":") ? format : `${pluginId}:${format}`
      if (!importerId.startsWith(`${pluginId}:`)) {
        return { success: false, error: `Importer is not owned by plugin: ${format}` }
      }
      const registration = customImporters.get(importerId)
      if (!registration || registration.ownerPluginId !== pluginId) {
        return { success: false, error: `No importer registered for format: ${format}` }
      }
      try {
        return await registration.importer.import(source)
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
        "registerChatImporter",
        "importContent",
      ],
    }
  )
}

/** Host-only lookup used to authorize attached bytes for matching importer owners. */
export function getCustomImporterOwnersForFile(filename: string, mimeType?: string): string[] {
  const dot = filename.lastIndexOf(".")
  const extension = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : ""
  const normalizedMime = mimeType?.toLowerCase()
  const owners = new Set<string>()
  for (const { ownerPluginId, importer } of customImporters.values()) {
    const extensionMatch = importer.extensions.some(
      (candidate) => candidate.replace(/^\./, "").toLowerCase() === extension
    )
    const mimeMatch = Boolean(normalizedMime) && importer.mimeType?.toLowerCase() === normalizedMime
    if (extensionMatch || mimeMatch) owners.add(ownerPluginId)
  }
  return [...owners]
}

/**
 * Drop every custom importer registered by `pluginId`. Called from the plugin
 * manager's disable path.
 *
 * Without it, `ctx.import.registerImporter` was the one imperative plugin
 * registration in this file with no bulk cleanup: a disabled or uninstalled
 * plugin kept matching filenames in {@link getCustomImporterOwnersForFile},
 * which is what authorizes chat-attachment BYTES to an importer's owner
 * (`lib/chat/attachments/dispatch.ts`). Returns the number removed.
 */
export function clearCustomImportersByPlugin(pluginId: string): number {
  let removed = 0
  for (const [importerId, registration] of [...customImporters.entries()]) {
    if (registration.ownerPluginId !== pluginId) continue
    customImporters.delete(importerId)
    removed += 1
  }
  return removed
}

/** Clear all custom importers (test isolation). */
export function clearCustomImporters(): void {
  customImporters.clear()
}
