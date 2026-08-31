/**
 * Plugin Export API Implementation
 *
 * Provides export capabilities to plugins.
 */

import {
  exportToRichMarkdown,
  exportToRichJSON,
  exportToHTML,
  exportToPlainText,
  exportToAnimatedHTML,
  generateFilename as generateExportFilename,
} from "@/lib/export"
import { createPluginSystemLogger, loggers } from "../core/logger"
import { createApiGuardedAPI } from "./api-permission-gate"
import type {
  PluginExportAPI,
  ExportFormat,
  ExportOptions,
  ExportData,
  ExportResult,
  CustomExporter,
} from "@/types/plugin/plugin"
import type { Session, UIMessage } from "@/types"
import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"
import { resolveSessionTwinProvenance } from "@/lib/twin/export-provenance"
import { enforceExportDisclosure } from "@/lib/export/disclosure"
import type { SingleExportFormat } from "@/lib/export/single"

/**
 * Normalise a plugin-facing `Session` into the persistence-shaped
 * `ChatSession` the rich-markdown / HTML writers expect. Plugin code
 * may pass `Date` instances for createdAt/updatedAt; the writers want
 * ms-since-epoch numbers, so we coerce here.
 */
function toChatSession(session: Session): ChatSession {
  const toMs = (v: number | Date) => (v instanceof Date ? v.getTime() : v)
  return {
    ...session,
    createdAt: toMs(session.createdAt),
    updatedAt: toMs(session.updatedAt),
  } as ChatSession
}

/**
 * Normalise a plugin-facing `UIMessage[]` into `StoredMessage[]`. Plugin
 * code may omit `sessionId` / `parts` (the bridge supplies them later);
 * for the writers we synthesise a single text part from `content` and
 * fall back to the session id supplied by the caller.
 */
function toStoredMessages(messages: UIMessage[], sessionId: string): StoredMessage[] {
  return messages.map((m) => {
    const createdAt =
      typeof m.createdAt === "number"
        ? m.createdAt
        : m.createdAt instanceof Date
          ? m.createdAt.getTime()
          : Date.now()
    const parts =
      m.parts && m.parts.length > 0
        ? m.parts
        : ([{ type: "text", text: m.content ?? "" }] as unknown as StoredMessage["parts"])
    return {
      id: m.id,
      sessionId: m.sessionId ?? sessionId,
      role: m.role,
      parts,
      senderId: m.senderId,
      senderKind: m.senderKind,
      metadata: m.metadata,
      createdAt,
    }
  })
}

// Registry for custom exporters
const customExporters = new Map<string, CustomExporter>()

/**
 * Create the Export API for a plugin
 */
export function createExportAPI(pluginId: string): PluginExportAPI {
  const logger = createPluginSystemLogger(pluginId)
  const api: PluginExportAPI = {
    exportSession: async (sessionId: string, options: ExportOptions): Promise<ExportResult> => {
      const { getPluginEventHooks } = await import("../messaging/hooks-system")
      const { useSessionStore } = await import("@/stores/chat/session-store")
      const { messageRepository } = await import("@/lib/db")
      const hooks = getPluginEventHooks()
      // Plugin host: announce session export start. The pipeline always emits
      // a matching complete (success/failure) below.
      await hooks.dispatchExportStart(sessionId, options.format)
      try {
        const sessionStore = useSessionStore.getState()
        const session = sessionStore.sessions.find((s) => s.id === sessionId)

        if (!session) {
          hooks.dispatchExportComplete(sessionId, options.format, false)
          return { success: false, error: "Session not found" }
        }

        const messages = await messageRepository.getBySessionId(sessionId)
        const exportedAt = new Date()

        const exportData: ExportData = {
          session,
          messages,
          exportedAt,
        }

        const result = await performExport(exportData, options, pluginId)
        hooks.dispatchExportComplete(sessionId, options.format, result.success)
        return result
      } catch (error) {
        hooks.dispatchExportComplete(sessionId, options.format, false)
        logger.error("Export session failed:", error)
        return {
          success: false,
          error: error instanceof Error ? error.message : "Export failed",
        }
      }
    },

    exportProject: async (projectId: string, options: ExportOptions): Promise<ExportResult> => {
      const { getPluginEventHooks } = await import("../messaging/hooks-system")
      const { useProjectStore } = await import("@/stores/project/project-store")
      const hooks = getPluginEventHooks()
      // Plugin host: announce project export start, mirror complete on every
      // exit branch (not-found / success / thrown).
      await hooks.dispatchProjectExportStart(projectId, options.format)
      try {
        const projectStore = useProjectStore.getState()
        const project = projectStore.projects.find((p) => p.id === projectId)

        if (!project) {
          hooks.dispatchProjectExportComplete(projectId, options.format, false)
          return { success: false, error: "Project not found" }
        }

        const exportedAt = new Date()
        const exportData: ExportData = {
          project,
          exportedAt,
        }

        const result = await performExport(exportData, options, pluginId)
        hooks.dispatchProjectExportComplete(projectId, options.format, result.success)
        return result
      } catch (error) {
        hooks.dispatchProjectExportComplete(projectId, options.format, false)
        logger.error("Export project failed:", error)
        return {
          success: false,
          error: error instanceof Error ? error.message : "Export failed",
        }
      }
    },

    exportMessages: async (messages, options: ExportOptions): Promise<ExportResult> => {
      try {
        const exportedAt = new Date()
        const exportData: ExportData = {
          messages,
          exportedAt,
        }

        return await performExport(exportData, options, pluginId)
      } catch (error) {
        logger.error("Export messages failed:", error)
        return {
          success: false,
          error: error instanceof Error ? error.message : "Export failed",
        }
      }
    },

    download: (result: ExportResult, filename?: string) => {
      if (result.success && result.blob) {
        const finalFilename = filename || result.filename || "export"
        const url = URL.createObjectURL(result.blob)
        const a = document.createElement("a")
        a.href = url
        a.download = finalFilename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        logger.info(`Downloaded: ${finalFilename}`)
      }
    },

    registerExporter: (exporter: CustomExporter) => {
      const exporterId = `${pluginId}:${exporter.id}`
      customExporters.set(exporterId, { ...exporter, id: exporterId })
      logger.info(`Registered exporter: ${exporter.name}`)

      return () => {
        customExporters.delete(exporterId)
        logger.info(`Unregistered exporter: ${exporter.name}`)
      }
    },

    getAvailableFormats: (): ExportFormat[] => {
      return ["markdown", "json", "html", "animated-html", "pdf", "text"]
    },

    getCustomExporters: (): CustomExporter[] => {
      return Array.from(customExporters.entries())
        .filter(([id]) => id.startsWith(`${pluginId}:`))
        .map(([, exporter]) => exporter)
    },

    generateFilename: (title: string, extension: string): string => {
      return generateExportFilename(title, extension)
    },
  }

  // `download` writes plugin-supplied bytes to the user's disk on the back of
  // an export flow — gate it with the session-export permission too.
  return createApiGuardedAPI(
    pluginId,
    api,
    {
      exportSession: "export:session",
      exportMessages: "export:session",
      exportProject: "export:project",
      download: "export:session",
    },
    {
      // Pure helpers / contribution registration — no user data access.
      unguarded: [
        "registerExporter",
        "getAvailableFormats",
        "getCustomExporters",
        "generateFilename",
      ],
    }
  )
}

/**
 * Perform the actual export
 */
async function performExport(
  data: ExportData,
  options: ExportOptions,
  pluginId: string
): Promise<ExportResult> {
  const { format, ...restOptions } = options

  let content: string
  let mimeType: string
  let extension: string

  // Resolve message-backed provenance before any exporter or plugin transform.
  // This keeps historical Twin attribution stable after character rebinding.
  const writerSession = data.session ? toChatSession(data.session) : null
  const writerMessages =
    data.session && data.messages ? toStoredMessages(data.messages, data.session.id) : null
  const provenance = writerSession
    ? await resolveSessionTwinProvenance(writerSession, writerMessages ?? [])
    : undefined

  // Check for custom exporter first
  const requestedExporterId = String(format).includes(":")
    ? String(format)
    : `${pluginId}:${String(format)}`
  const customExporter = requestedExporterId.startsWith(`${pluginId}:`)
    ? customExporters.get(requestedExporterId)
    : undefined

  if (customExporter) {
    try {
      const result = await customExporter.export(data)
      const disclosureFormat: SingleExportFormat = customExporter.mimeType.includes("html")
        ? "html"
        : customExporter.mimeType.includes("json")
          ? "json"
          : "text"
      let payload: string | Blob = result
      if (provenance?.length) {
        const textual =
          typeof result === "string" ||
          customExporter.mimeType.startsWith("text/") ||
          customExporter.mimeType.includes("json") ||
          customExporter.mimeType.includes("html")
        if (!textual) {
          return {
            success: false,
            error: "Custom binary exporters cannot safely disclose Digital Twin provenance",
          }
        }
        const text = typeof result === "string" ? result : await result.text()
        payload = enforceExportDisclosure(text, disclosureFormat, provenance)
      }
      const blob =
        payload instanceof Blob ? payload : new Blob([payload], { type: customExporter.mimeType })

      return {
        success: true,
        blob,
        filename: generateExportFilename(
          data.session?.title || data.project?.name || "export",
          customExporter.extension
        ),
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Custom export failed",
      }
    }
  }

  switch (format) {
    case "markdown":
      if (!writerSession || !writerMessages) {
        return { success: false, error: "Session and messages required for markdown export" }
      }
      content = exportToRichMarkdown({
        session: writerSession,
        messages: writerMessages,
        exportedAt: data.exportedAt,
        includeMetadata: restOptions.includeMetadata,
      })
      mimeType = "text/markdown"
      extension = "md"
      break

    case "json":
      if (!writerSession || !writerMessages) {
        return { success: false, error: "Session and messages required for JSON export" }
      }
      content = exportToRichJSON({
        session: writerSession,
        messages: writerMessages,
        exportedAt: data.exportedAt,
      })
      mimeType = "application/json"
      extension = "json"
      break

    case "html":
      if (!writerSession || !writerMessages) {
        return { success: false, error: "Session and messages required for HTML export" }
      }
      content = exportToHTML({
        session: writerSession,
        messages: writerMessages,
        exportedAt: data.exportedAt,
      })
      mimeType = "text/html"
      extension = "html"
      break

    case "animated-html":
      if (!writerSession || !writerMessages) {
        return { success: false, error: "Session and messages required for animated HTML export" }
      }
      content = exportToAnimatedHTML({
        session: writerSession,
        messages: writerMessages,
        exportedAt: data.exportedAt,
      })
      mimeType = "text/html"
      extension = "html"
      break

    case "text":
      if (!writerSession || !writerMessages) {
        return { success: false, error: "Session and messages required for text export" }
      }
      content = exportToPlainText({
        session: writerSession,
        messages: writerMessages,
        exportedAt: data.exportedAt,
      })
      mimeType = "text/plain"
      extension = "txt"
      break

    default:
      return { success: false, error: `Unsupported format: ${format}` }
  }

  // Plugin host: let plugins rewrite the rendered payload before it lands
  // in the result blob. The pipeline returns the original content unchanged
  // when no plugin transforms it.
  const { getPluginEventHooks } = await import("../messaging/hooks-system")
  const transformed = await getPluginEventHooks().dispatchExportTransform(content, format)
  const disclosureFormat: SingleExportFormat =
    format === "animated-html" ? "animated" : (format as SingleExportFormat)
  const disclosed = enforceExportDisclosure(transformed, disclosureFormat, provenance)
  const blob = new Blob([disclosed], { type: mimeType })
  const filename = generateExportFilename(
    data.session?.title || data.project?.name || "export",
    extension
  )

  loggers.manager.info(`Exported as ${format}: ${filename}`)

  return {
    success: true,
    blob,
    filename,
  }
}

/**
 * Clear all custom exporters (for testing purposes)
 */
export function clearCustomExporters(): void {
  customExporters.clear()
}
