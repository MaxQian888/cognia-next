/**
 * Plugin Project API Implementation
 *
 * Provides project management capabilities to plugins.
 */

import { useProjectStore } from "@/stores/project/project-store"
import type {
  PluginProjectAPI,
  ProjectFilter,
  ProjectFileInput,
} from "@/types/plugin/plugin-extended"
import type { Project, KnowledgeFile } from "@/types"
import { inferKnowledgeFileTypeFromFilename } from "@cognia/document"
import { createPluginSystemLogger } from "../core/logger"

/**
 * Create the Project API for a plugin
 */
export function createProjectAPI(pluginId: string): PluginProjectAPI {
  const logger = createPluginSystemLogger(pluginId)
  return {
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
      store.deleteProject(id)
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

      // Infer type from extension if not provided
      let fileType = file.type
      if (!fileType) {
        fileType = inferKnowledgeFileTypeFromFilename(file.name) as KnowledgeFile["type"]
      }

      const knowledgeFile: Omit<KnowledgeFile, "id" | "createdAt" | "updatedAt"> = {
        name: file.name,
        content: file.content,
        type: fileType,
        size: new Blob([file.content]).size,
        mimeType: file.mimeType,
      }

      store.addKnowledgeFile(projectId, knowledgeFile)

      // Get the newly added file
      const project = store.projects.find((p) => p.id === projectId)
      const addedFile = project?.knowledgeBase[project.knowledgeBase.length - 1]

      logger.info(`Added knowledge file to project ${projectId}: ${file.name}`)

      return addedFile!
    },

    removeKnowledgeFile: async (projectId: string, fileId: string) => {
      const store = useProjectStore.getState()
      store.removeKnowledgeFile(projectId, fileId)
      logger.info(`Removed knowledge file ${fileId} from project ${projectId}`)
    },

    updateKnowledgeFile: async (projectId: string, fileId: string, content: string) => {
      const store = useProjectStore.getState()
      store.updateKnowledgeFile(projectId, fileId, content)
      logger.info(`Updated knowledge file ${fileId} in project ${projectId}`)
    },

    getKnowledgeFiles: async (projectId: string) => {
      const store = useProjectStore.getState()
      const project = store.projects.find((p) => p.id === projectId)
      return project?.knowledgeBase || []
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
}
