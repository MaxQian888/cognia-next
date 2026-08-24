"use client"

/**
 * Project store — keeps the in-memory project list, the active project
 * pointer, and the per-project knowledge files / linked sessions / tags.
 *
 * Persistence: the authoritative model is the Dexie `projects` table
 * (`lib/db/projects.ts`; the active pointer lives on the `AppSettings`
 * singleton). `load()` hydrates from `getAllProjects` / `loadActiveProjectId`
 * (after `ensureDefaultProject`), and every mutation persists through the
 * thin async writers `putProject` / `deleteProjectRow` /
 * `persistActiveProjectId`; deleting a project cascades workspace-scoped rows
 * via `deleteProjectCascade` (`lib/db/project-scope.ts`, Dexie v86 isolation
 * column). The store is therefore an in-memory mirror, never a second source
 * of truth — a user-facing "Workspace" *is* a row of this table.
 *
 * The shape is dictated by `lib/plugin/api/project-api.ts` — every method
 * the plugin API calls is implemented here, and the field set on
 * `Project` matches the type exported from `@/types`.
 */

import { create } from "zustand"
import { nanoid } from "nanoid"
import type { Project, KnowledgeFile } from "@/types"
import type { WorkspaceRoot } from "@/types/workspace"
import { normalizeRoots, syncDerivedDirFields, rootsFromLegacy } from "@/lib/workspace/roots"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import {
  getAllProjects,
  loadActiveProjectId,
  putProject,
  deleteProjectRow,
  persistActiveProjectId,
} from "@/lib/db/projects"
import {
  deleteProjectCascade,
  detachProjectContents,
  ensureDefaultProject,
} from "@/lib/db/project-scope"
import type { ProjectRemovalMode } from "@/lib/db/project-scope"

export interface CreateProjectOptions {
  name?: string
  description?: string
  systemPrompt?: string
  tags?: string[]
  /** Explicit roots; takes precedence over rootDir/additionalDirs when provided. */
  roots?: WorkspaceRoot[]
  rootDir?: string
  additionalDirs?: string[]
  metadata?: Record<string, unknown>
}

export type ProjectUpdates = Partial<
  Omit<Project, "id" | "createdAt" | "updatedAt" | "lastAccessedAt">
>

interface ProjectState {
  projects: Project[]
  activeProjectId: string | null
  /** True once `load()` has hydrated from Dexie (or determined none is available). */
  loaded: boolean

  /** Hydrate the project list + active pointer from Dexie. Idempotent. */
  load: () => Promise<void>

  /** Create a project, append it to the list, and return it. Pure: does NOT auto-activate. */
  createProject: (options: CreateProjectOptions) => Project
  updateProject: (id: string, updates: ProjectUpdates) => void
  /**
   * Remove a workspace. `"detach"` (the default) hands its contents to Default;
   * `"delete-data"` destroys them. Removing a workspace is not the same
   * decision as destroying the conversations that were in it, so the caller
   * has to say which one it means.
   */
  deleteProject: (id: string, mode?: ProjectRemovalMode) => void
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

export const useProjectStore = create<ProjectState>((set, get) => {
  // Mirror a single project row to Dexie after a mutation. Gated on `loaded`
  // so we never write empty in-memory state back over persisted rows before
  // the boot-time `load()` has hydrated — unit tests that `setState` directly
  // (and never call `load()`) skip persistence entirely this way.
  const persist = (id: string): void => {
    if (!get().loaded) return
    const row = get().projects.find((p) => p.id === id)
    if (row) void putProject(row).catch(() => {})
  }
  const persistActive = (id: string | null): void => {
    if (!get().loaded) return
    void persistActiveProjectId(id).catch(() => {})
  }

  return {
    projects: [],
    activeProjectId: null,
    loaded: false,

    load: async () => {
      if (get().loaded) return
      try {
        const [persisted, persistedActiveId] = await Promise.all([
          getAllProjects(),
          loadActiveProjectId(),
        ])
        // Merge rather than overwrite: a project created or activated before
        // this async hydration resolved lives only in memory (persist() was
        // gated on `loaded`). In-memory rows win on id conflicts, and any row
        // that isn't yet persisted is flushed below so it survives a reload.
        const inMemory = get().projects
        const preloadActiveId = get().activeProjectId
        let activeProjectId = preloadActiveId ?? persistedActiveId
        let fallbackProject: Project | null = null
        if (!activeProjectId) {
          fallbackProject = await ensureDefaultProject()
          activeProjectId = fallbackProject.id
        }
        const persistedWithFallback =
          fallbackProject && !persisted.some((project) => project.id === fallbackProject.id)
            ? [...persisted, fallbackProject]
            : persisted
        const pending = inMemory.filter((p) => !persistedWithFallback.some((q) => q.id === p.id))
        const byId = new Map(persistedWithFallback.map((p) => [p.id, p]))
        for (const p of inMemory) byId.set(p.id, p)
        set({ projects: [...byId.values()], activeProjectId, loaded: true })

        // Flush mutations made while the gate was closed.
        for (const p of pending) void putProject(p).catch(() => {})
        if (preloadActiveId && preloadActiveId !== persistedActiveId) {
          void persistActiveProjectId(preloadActiveId).catch(() => {})
        }
      } catch {
        // No persistence available (web/test without indexedDB) — still mark
        // loaded so the store works in-memory.
        set({ loaded: true })
      }
    },

    createProject: (options) => {
      const now = nowDate()
      const roots =
        options.roots != null
          ? normalizeRoots(options.roots)
          : rootsFromLegacy(options.rootDir, options.additionalDirs)
      const base: Project = {
        id: `project-${nanoid()}`,
        name: options.name?.trim() || "New Project",
        description: options.description,
        customInstructions: options.systemPrompt,
        roots,
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
      // syncDerivedDirFields owns rootDir/additionalDirs — they mirror `roots`.
      const project = syncDerivedDirFields(base)
      set((state) => ({ projects: [...state.projects, project] }))
      persist(project.id)
      void getPluginEventHooks().dispatchProjectCreate(project)
      return project
    },

    updateProject: (id, updates) => {
      let updated: Project | undefined
      set((state) => ({
        projects: state.projects.map((p) => {
          if (p.id !== id) return p
          let merged = { ...p, ...updates, updatedAt: nowDate() }
          if (updates.roots != null) {
            merged = { ...merged, roots: normalizeRoots(updates.roots) }
          } else if (updates.rootDir !== undefined || updates.additionalDirs !== undefined) {
            // Legacy-shape update: rebuild roots from the (possibly partial) mirrors.
            const rootDir = updates.rootDir !== undefined ? updates.rootDir : p.rootDir
            const additionalDirs =
              updates.additionalDirs !== undefined ? updates.additionalDirs : p.additionalDirs
            merged = { ...merged, roots: rootsFromLegacy(rootDir, additionalDirs) }
          }
          const next = syncDerivedDirFields(merged)
          updated = next
          return next
        }),
      }))
      if (updated) {
        persist(id)
        void getPluginEventHooks().dispatchProjectUpdate(updated, updates as Partial<Project>)
      }
    },

    deleteProject: (id, mode = "detach") => {
      let removed = false
      const previouslyActive = get().activeProjectId === id
      set((state) => {
        const projects = state.projects.filter((p) => p.id !== id)
        removed = projects.length !== state.projects.length
        const activeProjectId = state.activeProjectId === id ? null : state.activeProjectId
        return { projects, activeProjectId }
      })
      if (removed) {
        if (get().loaded) {
          // Settle the workspace's runtime data (sessions, messages,
          // goals/plans/loops, canvas, workflow runs, connector routing rows,
          // + artifact/agent-team buckets) BEFORE dropping the project row, so
          // nothing is left pointing at a workspace that no longer exists.
          // `detach` hands it to Default; `delete-data` destroys it. Best-effort
          // + fire-and-forget to match the store's non-blocking contract.
          void (mode === "delete-data" ? deleteProjectCascade(id) : detachProjectContents(id))
            .catch(() => {})
            .finally(() => {
              void deleteProjectRow(id).catch(() => {})
            })
        }
        // Deleting the active workspace clears the pointer — persist that too.
        if (previouslyActive) persistActive(get().activeProjectId)
        void getPluginEventHooks().dispatchProjectDelete(id)
      }
    },

    setActiveProject: (id) => {
      const previousProjectId = get().activeProjectId
      if (id === null) {
        set({ activeProjectId: null })
        persistActive(null)
        getPluginEventHooks().dispatchProjectSwitch(null, previousProjectId)
        return
      }
      const exists = get().projects.some((p) => p.id === id)
      if (!exists) {
        // Allow setting an id even when the project list hasn't hydrated yet
        // (Dexie load is async). The next render reconciles. Don't throw —
        // plugins shouldn't have to await load order.
        set({ activeProjectId: id })
        persistActive(id)
        getPluginEventHooks().dispatchProjectSwitch(id, previousProjectId)
        return
      }
      set((state) => ({
        activeProjectId: id,
        projects: state.projects.map((p) =>
          p.id === id ? { ...p, lastAccessedAt: nowDate() } : p
        ),
      }))
      persistActive(id)
      persist(id)
      getPluginEventHooks().dispatchProjectSwitch(id, previousProjectId)
    },

    archiveProject: (id) => {
      set((state) => ({
        projects: state.projects.map((p) =>
          p.id === id ? { ...p, isArchived: true, updatedAt: nowDate() } : p
        ),
      }))
      persist(id)
    },

    unarchiveProject: (id) => {
      set((state) => ({
        projects: state.projects.map((p) =>
          p.id === id ? { ...p, isArchived: false, updatedAt: nowDate() } : p
        ),
      }))
      persist(id)
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
        persist(projectId)
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
        persist(projectId)
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
      persist(projectId)
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
        persist(projectId)
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
        persist(projectId)
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
      persist(projectId)
    },

    removeTag: (projectId, tag) => {
      set((state) => ({
        projects: state.projects.map((p) => {
          if (p.id !== projectId) return p
          const tags = (p.tags ?? []).filter((t) => t !== tag)
          return { ...p, tags, updatedAt: nowDate() }
        }),
      }))
      persist(projectId)
    },
  }
})
