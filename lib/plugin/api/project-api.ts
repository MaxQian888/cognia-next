/**
 * Plugin Project API Implementation
 *
 * Provides project management capabilities to plugins.
 */

import { useProjectStore } from "@/stores/project/project-store"
import type { PluginProjectAPI, ProjectFilter, ProjectFileInput } from "@/types/plugin/plugin"
import type { Project, KnowledgeFile } from "@/types"
import {
  inferKnowledgeFileTypeFromFilename,
  buildTextDocumentStructure,
  documentContentHash,
} from "@cognia/document"
import type { PluginKnowledgeScope } from "@/types/plugin/plugin-knowledge"
import type { KnowledgeBaseSource } from "@/types/knowledge-base"
import type { KnowledgeReadingSettings } from "@cognia/agent-config-types"
import { PROJECT_KNOWLEDGE_SOURCE_FORMATS } from "@/lib/project-knowledge/ingest/ingest-file"
import {
  createKnowledgeReader,
  KnowledgeReadingError,
  type KnowledgeReader,
} from "@/lib/knowledge-base/runtime/progressive-reading"
import {
  getKnowledgeReaderForSession,
  getKnowledgeAccessForSession,
} from "@/lib/knowledge-base/runtime/session-reader"
import { createPluginSystemLogger } from "../core/logger"
import { createApiGuardedAPI, hasApiOrGuardPermission } from "./api-permission-gate"

/**
 * Create the Project API for a plugin
 */
export function createProjectAPI(
  pluginId: string,
  options: {
    getReadingSettings?: () => Partial<KnowledgeReadingSettings> | undefined
    /** Host invocation binding; never exposed as a plugin request argument. */
    knowledgeSessionId?: string
    knowledgeReader?: KnowledgeReader
    isInvocationActive?: () => boolean
    allowProjectReading?: boolean
  } = {}
): PluginProjectAPI {
  const logger = createPluginSystemLogger(pluginId)
  const projectReaders = new Map<string, { reader: KnowledgeReader; settingsKey: string }>()
  const knowledgeReader = (scope: PluginKnowledgeScope): KnowledgeReader => {
    if (options.isInvocationActive && !options.isInvocationActive()) {
      throw new KnowledgeReadingError("session_scope_unavailable")
    }
    if (!hasApiOrGuardPermission(pluginId, "project:read")) {
      throw new KnowledgeReadingError("permission_denied")
    }
    if (!scope || typeof scope !== "object") throw new KnowledgeReadingError("invalid_arguments")
    if (scope.kind === "agent") {
      if (!hasApiOrGuardPermission(pluginId, "knowledge:read")) {
        throw new KnowledgeReadingError("permission_denied")
      }
      // The host binds scope, ACL identity, revisions and budget during a real
      // run. A session id is an address, never authority to select libraries.
      if (
        !options.isInvocationActive?.() ||
        !options.knowledgeSessionId ||
        scope.sessionId !== options.knowledgeSessionId
      ) {
        throw new KnowledgeReadingError("session_scope_unavailable")
      }
      const reader = options.knowledgeReader
      if (!reader || getKnowledgeReaderForSession(options.knowledgeSessionId) !== reader) {
        throw new KnowledgeReadingError("session_reader_unavailable")
      }
      return reader
    }
    if (scope.kind !== "project" || typeof scope.projectId !== "string" || !scope.projectId) {
      throw new KnowledgeReadingError("invalid_arguments")
    }
    const projectId = scope.projectId
    if (options.allowProjectReading === false) throw new KnowledgeReadingError("source_unavailable")
    const knowledgeBaseId = `project:${projectId}`
    if (!useProjectStore.getState().projects.some((project) => project.id === projectId)) {
      throw new KnowledgeReadingError("source_unavailable")
    }
    const settings = { enabled: true, ...options.getReadingSettings?.() }
    const settingsKey = JSON.stringify(settings)
    const existing = projectReaders.get(projectId)
    if (existing?.settingsKey === settingsKey) return existing.reader
    const files = () =>
      useProjectStore.getState().projects.find((p) => p.id === projectId)?.knowledgeBase ?? []
    const source = (file: KnowledgeFile): KnowledgeBaseSource => ({
      id: file.id,
      knowledgeBaseId,
      kind: "document",
      format: PROJECT_KNOWLEDGE_SOURCE_FORMATS[file.type],
      title: file.name,
      content: file.content,
      bytes: file.size ?? file.content.length,
      fingerprint: documentContentHash(file.content),
      status: "ready",
      chunkCount: 0,
      createdAt: new Date(file.createdAt ?? 0).getTime(),
      updatedAt: new Date(file.updatedAt ?? 0).getTime(),
    })
    const reader = createKnowledgeReader({
      knowledgeBaseIds: [knowledgeBaseId],
      settings,
      deps: {
        listSources: async (id) => (id === knowledgeBaseId ? files().map(source) : []),
        getSources: async (ids) =>
          files()
            .filter((file) => ids.includes(file.id))
            .map(source),
        getSnapshot: async (identity) => {
          const file = files().find((item) => item.id === identity.sourceId)
          if (!file || identity.knowledgeBaseId !== knowledgeBaseId) return undefined
          const contentHash = documentContentHash(file.content)
          if (identity.generationId && identity.generationId !== contentHash) return undefined
          // A changed original invalidates stale ranges immediately. Reuse the
          // parser's canonical backfill for legacy files and edited originals.
          const structure =
            file.structure?.contentHash === contentHash
              ? file.structure
              : buildTextDocumentStructure(file.content, file.name)
          return {
            generationId: contentHash,
            contentHash,
            originalText: file.content,
            structure,
            title: file.name,
            format: source(file).format,
            createdAt: source(file).createdAt,
          }
        },
      },
    })
    projectReaders.set(projectId, { reader, settingsKey })
    return reader
  }
  const api: PluginProjectAPI = {
    getCurrentProject: () => {
      const store = useProjectStore.getState()
      if (!store.activeProjectId) return null
      return store.projects.find((p) => p.id === store.activeProjectId) || null
    },

    getCurrentProjectId: () => {
      return useProjectStore.getState().activeProjectId
    },

    getProject: async (id: string) => {
      const store = useProjectStore.getState()
      return store.projects.find((p) => p.id === id) || null
    },

    createProject: async (options) => {
      const store = useProjectStore.getState()
      const project = store.createProject(options)
      logger.info(`Created project: ${project.id}`)
      return project
    },

    updateProject: async (id: string, updates) => {
      const store = useProjectStore.getState()
      store.updateProject(id, updates)
      logger.info(`Updated project: ${id}`)
    },

    deleteProject: async (id: string) => {
      const store = useProjectStore.getState()
      await store.deleteProject(id)
      logger.info(`Deleted project: ${id}`)
    },

    setActiveProject: async (id: string | null) => {
      const store = useProjectStore.getState()
      store.setActiveProject(id)
      logger.info(`Set active project: ${id}`)
    },

    listProjects: async (filter?: ProjectFilter) => {
      const store = useProjectStore.getState()
      let projects = [...store.projects]

      if (filter) {
        if (filter.isArchived !== undefined) {
          projects = projects.filter((p) => p.isArchived === filter.isArchived)
        }
        if (filter.tags && filter.tags.length > 0) {
          projects = projects.filter((p) => filter.tags!.some((tag) => p.tags?.includes(tag)))
        }
        if (filter.createdAfter) {
          projects = projects.filter((p) => new Date(p.createdAt) > filter.createdAfter!)
        }
        if (filter.createdBefore) {
          projects = projects.filter((p) => new Date(p.createdAt) < filter.createdBefore!)
        }

        // Sort
        if (filter.sortBy) {
          projects.sort((a, b) => {
            const aVal = a[filter.sortBy!]
            const bVal = b[filter.sortBy!]
            if (aVal instanceof Date && bVal instanceof Date) {
              return filter.sortOrder === "desc"
                ? bVal.getTime() - aVal.getTime()
                : aVal.getTime() - bVal.getTime()
            }
            if (typeof aVal === "string" && typeof bVal === "string") {
              return filter.sortOrder === "desc"
                ? bVal.localeCompare(aVal)
                : aVal.localeCompare(bVal)
            }
            return 0
          })
        }

        // Pagination
        if (filter.offset) {
          projects = projects.slice(filter.offset)
        }
        if (filter.limit) {
          projects = projects.slice(0, filter.limit)
        }
      }

      return projects
    },

    archiveProject: async (id: string) => {
      const store = useProjectStore.getState()
      store.archiveProject(id)
      logger.info(`Archived project: ${id}`)
    },

    unarchiveProject: async (id: string) => {
      const store = useProjectStore.getState()
      store.unarchiveProject(id)
      logger.info(`Unarchived project: ${id}`)
    },

    addKnowledgeFile: async (projectId: string, file: ProjectFileInput) => {
      const store = useProjectStore.getState()
      if (
        !file ||
        typeof file.name !== "string" ||
        !file.name.trim() ||
        typeof file.content !== "string" ||
        (file.embeddableContent !== undefined && typeof file.embeddableContent !== "string")
      ) {
        throw new KnowledgeReadingError("invalid_arguments")
      }

      // Infer type from extension if not provided
      let fileType = file.type
      if (!fileType) {
        fileType = inferKnowledgeFileTypeFromFilename(file.name) as KnowledgeFile["type"]
      }

      const knowledgeFile: Omit<KnowledgeFile, "id" | "createdAt" | "updatedAt"> = {
        name: file.name,
        content: file.content,
        embeddableContent: file.embeddableContent,
        structure:
          file.structure?.contentHash === documentContentHash(file.content) &&
          file.structure.textLength === file.content.length
            ? file.structure
            : buildTextDocumentStructure(file.content, file.name),
        type: fileType,
        size: new Blob([file.content]).size,
        mimeType: file.mimeType,
      }

      if (!store.projects.some((p) => p.id === projectId)) {
        throw new Error(`Project not found: ${projectId}`)
      }
      store.addKnowledgeFile(projectId, knowledgeFile)

      // Read AFTER the mutation. `store` is the pre-mutation snapshot: the store
      // replaces the row immutably, so reading it returned the previous last
      // file, or undefined for a workspace with no knowledge yet.
      const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
      const addedFile = project?.knowledgeBase[project.knowledgeBase.length - 1]
      if (!addedFile) throw new Error(`Knowledge file was not added to project ${projectId}`)

      logger.info(`Added knowledge file to project ${projectId}: ${file.name}`)

      return addedFile
    },

    removeKnowledgeFile: async (projectId: string, fileId: string) => {
      const store = useProjectStore.getState()
      store.removeKnowledgeFile(projectId, fileId)
      logger.info(`Removed knowledge file ${fileId} from project ${projectId}`)
    },

    updateKnowledgeFile: async (projectId: string, fileId: string, content: string) => {
      const store = useProjectStore.getState()
      if (typeof content !== "string") throw new KnowledgeReadingError("invalid_arguments")
      if (
        !store.projects
          .find((project) => project.id === projectId)
          ?.knowledgeBase.some((file) => file.id === fileId)
      ) {
        throw new KnowledgeReadingError("source_unavailable")
      }
      store.updateKnowledgeFile(projectId, fileId, content)
      logger.info(`Updated knowledge file ${fileId} in project ${projectId}`)
    },

    getKnowledgeFiles: async (projectId: string) => {
      const store = useProjectStore.getState()
      const project = store.projects.find((p) => p.id === projectId)
      return project?.knowledgeBase || []
    },

    listKnowledgeDocuments: async ({ scope, ...request }) => {
      const result = await knowledgeReader(scope).listDocuments(request)
      knowledgeReader(scope)
      return result
    },
    readKnowledgeOutline: async ({ scope, ...request }) => {
      const result = await knowledgeReader(scope).readOutline(request)
      knowledgeReader(scope)
      return result
    },
    readKnowledgeRange: async ({ scope, ...request }) => {
      const result = await knowledgeReader(scope).readRange(request)
      knowledgeReader(scope)
      return result
    },
    locateKnowledgeDocument: async ({ scope, ...request }) => {
      const result = await knowledgeReader(scope).locate(request)
      knowledgeReader(scope)
      return result
    },

    linkSession: async (projectId: string, sessionId: string) => {
      const store = useProjectStore.getState()
      store.addSessionToProject(projectId, sessionId)
      logger.info(`Linked session ${sessionId} to project ${projectId}`)
    },

    unlinkSession: async (projectId: string, sessionId: string) => {
      const store = useProjectStore.getState()
      store.removeSessionFromProject(projectId, sessionId)
      logger.info(`Unlinked session ${sessionId} from project ${projectId}`)
    },

    getProjectSessions: async (projectId: string) => {
      const store = useProjectStore.getState()
      const project = store.projects.find((p) => p.id === projectId)
      return project?.sessionIds || []
    },

    onProjectChange: (handler: (project: Project | null) => void) => {
      let lastProjectId: string | null = null

      const unsubscribe = useProjectStore.subscribe((state) => {
        if (state.activeProjectId !== lastProjectId) {
          lastProjectId = state.activeProjectId
          const project = state.activeProjectId
            ? state.projects.find((p) => p.id === state.activeProjectId) || null
            : null
          handler(project)
        }
      })

      return unsubscribe
    },

    addTag: async (projectId: string, tag: string) => {
      const store = useProjectStore.getState()
      store.addTag(projectId, tag)
      logger.info(`Added tag "${tag}" to project ${projectId}`)
    },

    removeTag: async (projectId: string, tag: string) => {
      const store = useProjectStore.getState()
      store.removeTag(projectId, tag)
      logger.info(`Removed tag "${tag}" from project ${projectId}`)
    },
  }

  return createApiGuardedAPI(pluginId, api, {
    getCurrentProject: "project:read",
    getCurrentProjectId: "project:read",
    getProject: "project:read",
    createProject: "project:write",
    updateProject: "project:write",
    deleteProject: "project:delete",
    setActiveProject: "project:write",
    listProjects: "project:read",
    archiveProject: "project:write",
    unarchiveProject: "project:write",
    addKnowledgeFile: "project:write",
    removeKnowledgeFile: "project:write",
    updateKnowledgeFile: "project:write",
    getKnowledgeFiles: "project:read",
    listKnowledgeDocuments: "project:read",
    readKnowledgeOutline: "project:read",
    readKnowledgeRange: "project:read",
    locateKnowledgeDocument: "project:read",
    linkSession: "project:write",
    unlinkSession: "project:write",
    getProjectSessions: "project:read",
    onProjectChange: "project:read",
    addTag: "project:write",
    removeTag: "project:write",
  })
}

/** Per-tool invocation context. Disposal closes retained APIs even with a valid grant. */
export function createInvocationProjectAPI(
  pluginId: string,
  sessionId: string
): {
  api: PluginProjectAPI
  dispose: () => void
} {
  let active = true
  const authority = getKnowledgeAccessForSession(sessionId)
  const authorityKey = JSON.stringify(authority)
  const local =
    !!authority && !["portal", "http", "mcp"].includes(authority.knowledgeAccess.entrypoint ?? "")
  const invocationActive = () =>
    active &&
    !!authority &&
    JSON.stringify(getKnowledgeAccessForSession(sessionId)) === authorityKey
  const api = createProjectAPI(pluginId, {
    knowledgeSessionId: sessionId,
    knowledgeReader: getKnowledgeReaderForSession(sessionId),
    isInvocationActive: invocationActive,
    allowProjectReading: local,
  })
  const documentReads = new Set([
    "listKnowledgeDocuments",
    "readKnowledgeOutline",
    "readKnowledgeRange",
    "locateKnowledgeDocument",
  ])
  return {
    api: new Proxy(api, {
      get(target, property) {
        const member = target[property as keyof PluginProjectAPI]
        if (typeof member !== "function") return member
        return (...args: unknown[]) => {
          const error = !invocationActive()
            ? new KnowledgeReadingError("session_scope_unavailable")
            : !local && !documentReads.has(String(property))
              ? new KnowledgeReadingError("source_unavailable")
              : null
          if (error) {
            if (documentReads.has(String(property))) return Promise.reject(error)
            throw error
          }
          return (member as (...args: unknown[]) => unknown).apply(target, args)
        }
      },
    }),
    dispose: () => {
      active = false
    },
  }
}
