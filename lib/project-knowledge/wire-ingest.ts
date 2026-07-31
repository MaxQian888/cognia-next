/**
 * Project-knowledge ingest controller.
 *
 * Reconciles the derived `projectChunks` index against the authoritative source
 * (`Project.knowledgeBase`). A pure diff (`diffKnowledgeBases`) compares a prior
 * snapshot of every project's files (by content hash) with the current one and
 * yields the ingest / removal actions; the controller applies them through a
 * serial queue so bulk edits don't thrash the embedder.
 *
 * The store stays side-effect-free: this controller is driven from a zustand
 * subscription in `components/shell/project-kb-worker-initializer.tsx`, not from
 * inside the store mutations. All work is best-effort and never throws.
 */

import type { Project } from "@/types"
import { hashContent, ingestKnowledgeFile } from "./ingest/ingest-file"
import { tryBuildProjectKnowledgeDeps } from "./runtime/build-deps"
import { deleteProjectChunksByFile, listProjectChunksByFile } from "@/lib/db/project-chunks"
import { projectVectorCollectionName } from "./ingest/persist"

/** Snapshot: projectId → (fileId → content hash). */
export type KnowledgeSnapshot = Map<string, Map<string, string>>

export interface IngestAction {
  projectId: string
  fileId: string
}

export interface KnowledgeDiff {
  /** Files that are new or whose content changed → (re)ingest. */
  toIngest: IngestAction[]
  /** Files removed from a still-present project → drop their chunks. */
  toRemove: IngestAction[]
  /** The snapshot to remember for the next diff. */
  next: KnowledgeSnapshot
}

/** Build a fresh snapshot from the current projects. */
export function snapshotOf(projects: Project[]): KnowledgeSnapshot {
  const snap: KnowledgeSnapshot = new Map()
  for (const p of projects) {
    const files = new Map<string, string>()
    for (const f of p.knowledgeBase ?? []) files.set(f.id, hashContent(f.content ?? ""))
    snap.set(p.id, files)
  }
  return snap
}

/**
 * Pure diff of the previous snapshot vs. the current projects. Only diffs files
 * within projects still present in `projects` — a fully-removed project has its
 * chunks dropped by `deleteProjectCascade`, so we don't emit removals for it
 * (which would need a remote purge the cascade already performs).
 */
export function diffKnowledgeBases(prev: KnowledgeSnapshot, projects: Project[]): KnowledgeDiff {
  const toIngest: IngestAction[] = []
  const toRemove: IngestAction[] = []
  const next = snapshotOf(projects)

  for (const p of projects) {
    const prevFiles = prev.get(p.id) ?? new Map<string, string>()
    const nextFiles = next.get(p.id) ?? new Map<string, string>()
    for (const [fileId, hash] of nextFiles) {
      if (prevFiles.get(fileId) !== hash) toIngest.push({ projectId: p.id, fileId })
    }
    for (const fileId of prevFiles.keys()) {
      if (!nextFiles.has(fileId)) toRemove.push({ projectId: p.id, fileId })
    }
  }

  return { toIngest, toRemove, next }
}

export interface ProjectKnowledgeIngestController {
  /** Diff the current projects vs. the last snapshot and apply the changes. */
  reconcile: (projects: Project[]) => Promise<void>
  /** Force a full re-ingest of one project's files (manual "reindex all"). */
  reindexProject: (project: Project) => Promise<void>
  /** Force a re-ingest of a single file (manual per-file "reindex"). */
  reindexFile: (projectId: string, file: Project["knowledgeBase"][number]) => Promise<void>
}

export function createProjectKnowledgeIngestController(): ProjectKnowledgeIngestController {
  let snapshot: KnowledgeSnapshot = new Map()
  // Serial task queue — one ingest/remove at a time so a burst of file adds
  // doesn't fire N concurrent embed batches.
  let tail: Promise<void> = Promise.resolve()
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    tail = tail.then(task, task)
    return tail
  }

  const fileById = (projects: Project[], projectId: string, fileId: string) =>
    projects.find((p) => p.id === projectId)?.knowledgeBase.find((f) => f.id === fileId)

  const ingest = async (
    projectId: string,
    file: Project["knowledgeBase"][number],
    skipUnchanged: boolean
  ): Promise<void> => {
    const deps = await tryBuildProjectKnowledgeDeps()
    if (!deps) return
    await ingestKnowledgeFile({ projectId, file, deps, skipUnchanged })
  }

  const removeFile = async (projectId: string, fileId: string): Promise<void> => {
    // Best-effort remote purge (collect ids before dropping the local rows).
    try {
      const existing = await listProjectChunksByFile(projectId, fileId)
      const vectorIds = existing.map((c) => c.vectorDocId).filter(Boolean)
      if (vectorIds.length > 0) {
        const deps = await tryBuildProjectKnowledgeDeps()
        if (deps?.store?.deleteDocuments) {
          await deps.store.deleteDocuments(projectVectorCollectionName(projectId), vectorIds)
        }
      }
    } catch {
      // Remote purge failure is non-fatal — the local rows are still dropped.
    }
    await deleteProjectChunksByFile(projectId, fileId)
  }

  return {
    reconcile: async (projects) => {
      const diff = diffKnowledgeBases(snapshot, projects)
      snapshot = diff.next
      for (const { projectId, fileId } of diff.toIngest) {
        const file = fileById(projects, projectId, fileId)
        if (file) await enqueue(() => ingest(projectId, file, true).catch(() => undefined))
      }
      for (const { projectId, fileId } of diff.toRemove) {
        await enqueue(() => removeFile(projectId, fileId).catch(() => undefined))
      }
    },
    reindexProject: async (project) => {
      for (const file of project.knowledgeBase ?? []) {
        await enqueue(() => ingest(project.id, file, false).catch(() => undefined))
      }
      // Refresh the snapshot so the next reconcile doesn't re-ingest.
      snapshot.set(
        project.id,
        new Map((project.knowledgeBase ?? []).map((f) => [f.id, hashContent(f.content ?? "")]))
      )
    },
    reindexFile: async (projectId, file) => {
      await enqueue(() => ingest(projectId, file, false).catch(() => undefined))
      const files = snapshot.get(projectId) ?? new Map<string, string>()
      files.set(file.id, hashContent(file.content ?? ""))
      snapshot.set(projectId, files)
    },
  }
}
