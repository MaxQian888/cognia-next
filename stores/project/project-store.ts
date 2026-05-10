"use client"

/**
 * Project store — keeps the in-memory project list, the active project
 * pointer, and the per-project knowledge files / linked sessions / tags.
 *
 * Persistence is intentionally NOT wired up here. cognia-next tracks the
 * authoritative project model in Dexie (`projects` table is on the
 * roadmap); this store mirrors what the plugin Project API needs without
 * blocking on the Dexie migration. Once the Dexie table lands, hydrate
 * from it in `load()` and persist mutations via thin async writers.
 *
 * The shape is dictated by `lib/plugin/api/project-api.ts` — every method
 * the plugin API calls is implemented here, and the field set on
 * `Project` matches the type exported from `@/types`.
 */

import { create } from "zustand"
import { nanoid } from "nanoid"
import type { Project, KnowledgeFile } from "@/types"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"

export interface CreateProjectOptions {
  name?: string
  description?: string
  systemPrompt?: string
  tags?: string[]
  rootDir?: string
  metadata?: Record<string, unknown>
}

export type ProjectUpdates = Partial<
  Omit<Project, "id" | "createdAt" | "updatedAt" | "lastAccessedAt">
>

interface ProjectState {
  projects: Project[]
  activeProjectId: string | null

  /** Create a project, append it to the list, and return it. Pure: does NOT auto-activate. */
  createProject: (options: CreateProjectOptions) => Project
  updateProject: (id: string, updates: ProjectUpdates) => void
  deleteProject: (id: string) => void
  setActiveProject: (id: string | null) => void

  archiveProject: (id: string) => void
  unarchiveProject: (id: string) => void

  addKnowledgeFile: (
    projectId: string,
    file: Omit<KnowledgeFile, "id" | "createdAt" | "updatedAt">
  ) => void
  removeKnowledgeFile: (projectId: string, fileId: string) => void
  updateKnowledgeFile: (projectId: string, fileId: string, content: string) => void

  addSessionToProject: (projectId: string, sessionId: string) => void
  removeSessionFromProject: (projectId: string, sessionId: string) => void

  addTag: (projectId: string, tag: string) => void
  removeTag: (projectId: string, tag: string) => void
}

function nowDate(): Date {
  return new Date()
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  activeProjectId: null,

  createProject: (options) => {
    const now = nowDate()
    const project: Project = {
      id: `project-${nanoid()}`,
      name: options.name?.trim() || "New Project",
      description: options.description,
      customInstructions: options.systemPrompt,
      rootDir: options.rootDir,
      knowledgeBase: [],
      sessionIds: [],
      sessionCount: 0,
      messageCount: 0,
      tags: options.tags ? [...options.tags] : undefined,
      isArchived: false,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      metadata: options.metadata,
    }
    set((state) => ({ projects: [...state.projects, project] }))
    void getPluginEventHooks().dispatchProjectCreate(project)
    return project
  },

  updateProject: (id, updates) => {
    let updated: Project | undefined
    set((state) => ({
      projects: state.projects.map((p) => {
        if (p.id !== id) return p
        const next = { ...p, ...updates, updatedAt: nowDate() }
        updated = next
        return next
      }),
    }))
    if (updated) {
      void getPluginEventHooks().dispatchProjectUpdate(updated, updates as Partial<Project>)
    }
  },

  deleteProject: (id) => {
    let removed = false
    set((state) => {
      const projects = state.projects.filter((p) => p.id !== id)
      removed = projects.length !== state.projects.length
      const activeProjectId = state.activeProjectId === id ? null : state.activeProjectId
      return { projects, activeProjectId }
    })
    if (removed) {
      void getPluginEventHooks().dispatchProjectDelete(id)
    }
  },

  setActiveProject: (id) => {
    const previousProjectId = get().activeProjectId
    if (id === null) {
      set({ activeProjectId: null })
      getPluginEventHooks().dispatchProjectSwitch(null, previousProjectId)
      return
    }
    const exists = get().projects.some((p) => p.id === id)
    if (!exists) {
      // Allow setting an id even when the project list hasn't hydrated yet
      // (Dexie load is async). The next render reconciles. Don't throw —
      // plugins shouldn't have to await load order.
      set({ activeProjectId: id })
      getPluginEventHooks().dispatchProjectSwitch(id, previousProjectId)
      return
    }
    set((state) => ({
      activeProjectId: id,
      projects: state.projects.map((p) => (p.id === id ? { ...p, lastAccessedAt: nowDate() } : p)),
    }))
    getPluginEventHooks().dispatchProjectSwitch(id, previousProjectId)
  },

  archiveProject: (id) => {
    set((state) => ({
      projects: state.projects.map((p) =>
        p.id === id ? { ...p, isArchived: true, updatedAt: nowDate() } : p
      ),
    }))
  },

  unarchiveProject: (id) => {
    set((state) => ({
      projects: state.projects.map((p) =>
        p.id === id ? { ...p, isArchived: false, updatedAt: nowDate() } : p
      ),
    }))
  },

  addKnowledgeFile: (projectId, file) => {
    const now = nowDate()
    const newFile: KnowledgeFile = {
      id: `kbfile-${nanoid()}`,
      ...file,
      createdAt: now,
      updatedAt: now,
    }
    let added = false
    set((state) => ({
      projects: state.projects.map((p) => {
        if (p.id !== projectId) return p
        added = true
        return { ...p, knowledgeBase: [...p.knowledgeBase, newFile], updatedAt: now }
      }),
    }))
    if (added) {
      void getPluginEventHooks().dispatchKnowledgeFileAdd(projectId, newFile)
    }
  },

  removeKnowledgeFile: (projectId, fileId) => {
    let removed = false
    set((state) => ({
      projects: state.projects.map((p) => {
        if (p.id !== projectId) return p
        const nextKb = p.knowledgeBase.filter((f) => f.id !== fileId)
        if (nextKb.length !== p.knowledgeBase.length) {
          removed = true
        }
        return {
          ...p,
          knowledgeBase: nextKb,
          updatedAt: nowDate(),
        }
      }),
    }))
    if (removed) {
      getPluginEventHooks().dispatchKnowledgeFileRemove(projectId, fileId)
    }
  },

  updateKnowledgeFile: (projectId, fileId, content) => {
    const now = nowDate()
    set((state) => ({
      projects: state.projects.map((p) => {
        if (p.id !== projectId) return p
        return {
          ...p,
          knowledgeBase: p.knowledgeBase.map((f) =>
            f.id === fileId ? { ...f, content, size: content.length, updatedAt: now } : f
          ),
          updatedAt: now,
        }
      }),
    }))
  },

  addSessionToProject: (projectId, sessionId) => {
    let linked = false
    set((state) => ({
      projects: state.projects.map((p) => {
        if (p.id !== projectId) return p
        if (p.sessionIds.includes(sessionId)) return p
        linked = true
        const sessionIds = [...p.sessionIds, sessionId]
        return {
          ...p,
          sessionIds,
          sessionCount: sessionIds.length,
          updatedAt: nowDate(),
        }
      }),
    }))
    if (linked) {
      getPluginEventHooks().dispatchSessionLinked(projectId, sessionId)
    }
  },

  removeSessionFromProject: (projectId, sessionId) => {
    let unlinked = false
    set((state) => ({
      projects: state.projects.map((p) => {
        if (p.id !== projectId) return p
        const sessionIds = p.sessionIds.filter((id) => id !== sessionId)
        if (sessionIds.length !== p.sessionIds.length) {
          unlinked = true
        }
        return {
          ...p,
          sessionIds,
          sessionCount: sessionIds.length,
          updatedAt: nowDate(),
        }
      }),
    }))
    if (unlinked) {
      getPluginEventHooks().dispatchSessionUnlinked(projectId, sessionId)
    }
  },

  addTag: (projectId, tag) => {
    set((state) => ({
      projects: state.projects.map((p) => {
        if (p.id !== projectId) return p
        const tags = p.tags ?? []
        if (tags.includes(tag)) return p
        return { ...p, tags: [...tags, tag], updatedAt: nowDate() }
      }),
    }))
  },

  removeTag: (projectId, tag) => {
    set((state) => ({
      projects: state.projects.map((p) => {
        if (p.id !== projectId) return p
        const tags = (p.tags ?? []).filter((t) => t !== tag)
        return { ...p, tags, updatedAt: nowDate() }
      }),
    }))
  },
}))
