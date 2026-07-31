"use client"

/**
 * Bridges the in-memory canvas state (Zustand-backed `useArtifactStore`
 * for documents + versions, `useCommentStore` for comments) with the
 * Dexie canvas tables. cognia-next persists canvas data primarily in
 * Zustand+localStorage (the `cognia-artifacts` and
 * `cognia-canvas-comments` namespaces, identical to Cognia upstream)
 * but the v3 backup format reads from Dexie. The bridge keeps both
 * sides in lockstep:
 *
 *   - Hydration: nothing to load — Zustand persistence is the
 *     authoritative source. Dexie is a write-through mirror.
 *   - Subscription: every store change diffs against the mirror and
 *     writes adds/updates/deletes into Dexie. Versions are flattened
 *     out of each document's nested `versions[]` array into the
 *     dedicated `canvasVersions` table so the backup importer can
 *     restore them on a different device.
 *
 * Comment-store comments are mirrored verbatim with timestamps
 * normalised to numbers. canvasSessions is reserved for future
 * standalone collaboration session pinning; nothing writes to it
 * today, but the table is preserved for forward compatibility.
 */

import type { CanvasDocument, CanvasDocumentVersion } from "@/types/artifact/artifact"
import type { CanvasComment } from "@/types/canvas/collaboration"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useCommentStore } from "@/stores/canvas/comment-store"
import { getDb } from "@/lib/db/schema"
import type { CanvasCommentRow, CanvasDocumentRow, CanvasVersionRow } from "@/lib/db/canvas-types"
import type { ContextCommentRow } from "@/types/context-comment"
import { canvasCommentRowFromContext, contextCommentRowFromCanvas } from "@/lib/db/context-comments"
import { loggers } from "@cognia/logging"

let started = false
let mirroredDocs: Record<string, CanvasDocument> = {}
let mirroredVersionIds = new Set<string>()
let mirroredCommentIds = new Set<string>()

function dateMs(d: Date | string | undefined): number {
  if (!d) return 0
  return d instanceof Date ? d.getTime() : new Date(d).getTime()
}

function docToRow(doc: CanvasDocument): CanvasDocumentRow {
  return {
    id: doc.id,
    sessionId: doc.sessionId,
    // Workspace isolation (Dexie v86) — mirror the doc's owning project so the
    // backup format + cascade delete partition canvas docs per workspace.
    projectId: doc.projectId,
    title: doc.title,
    content: doc.content,
    language: doc.language,
    type: doc.type,
    createdAt: dateMs(doc.createdAt),
    updatedAt: dateMs(doc.updatedAt),
    editorContext: doc.editorContext,
    aiSuggestions: doc.aiSuggestions,
    currentVersionId: doc.currentVersionId,
  }
}

function versionToRow(documentId: string, v: CanvasDocumentVersion): CanvasVersionRow {
  return {
    id: v.id,
    documentId,
    content: v.content,
    title: v.title,
    createdAt: dateMs(v.createdAt),
    description: v.description,
    isAutoSave: v.isAutoSave,
  }
}

function commentToRow(c: CanvasComment): CanvasCommentRow {
  return {
    ...c,
    createdAt: dateMs(c.createdAt),
    updatedAt: c.updatedAt ? dateMs(c.updatedAt) : undefined,
    resolvedAt: c.resolvedAt ? dateMs(c.resolvedAt) : undefined,
  }
}

/**
 * Sync the documents + their nested versions to Dexie. Versions are
 * flattened so a single backup-restore round-trip on a new device
 * preserves the full snapshot history. Bulk writes happen inside one
 * Dexie transaction so a partial failure rolls back.
 */
async function syncDocumentsAndVersions(next: Record<string, CanvasDocument>): Promise<void> {
  const db = getDb()
  const prevIds = new Set(Object.keys(mirroredDocs))
  const nextIds = new Set(Object.keys(next))
  const removedDocs: string[] = []
  for (const id of prevIds) if (!nextIds.has(id)) removedDocs.push(id)

  // Always upsert documents we still have — title, content, suggestions
  // and editor-context can change without the row reference flipping.
  const docUpserts: CanvasDocumentRow[] = []
  for (const id of nextIds) docUpserts.push(docToRow(next[id]))

  // Reconcile versions: collect every (documentId, version) pair from
  // memory; everything we used to mirror but isn't in this list gets
  // removed; everything new or updated gets bulk-put.
  const seenVersionIds = new Set<string>()
  const versionUpserts: CanvasVersionRow[] = []
  for (const id of nextIds) {
    const doc = next[id]
    for (const v of doc.versions ?? []) {
      seenVersionIds.add(v.id)
      versionUpserts.push(versionToRow(id, v))
    }
  }
  const removedVersionIds: string[] = []
  for (const vid of mirroredVersionIds) {
    if (!seenVersionIds.has(vid)) removedVersionIds.push(vid)
  }

  if (
    removedDocs.length === 0 &&
    docUpserts.length === 0 &&
    versionUpserts.length === 0 &&
    removedVersionIds.length === 0
  ) {
    return
  }

  await db.transaction(
    "rw",
    db.canvasDocuments,
    db.canvasVersions,
    db.contextComments,
    db.canvasSessions,
    async () => {
      for (const id of removedDocs) {
        await db.canvasVersions.where("documentId").equals(id).delete()
        await db.contextComments
          .where("[resourceKind+resourceId]")
          .equals(["canvas-document", id])
          .delete()
        await db.canvasSessions.where("documentId").equals(id).delete()
        await db.canvasDocuments.delete(id)
      }
      if (docUpserts.length > 0) await db.canvasDocuments.bulkPut(docUpserts)
      if (removedVersionIds.length > 0) await db.canvasVersions.bulkDelete(removedVersionIds)
      if (versionUpserts.length > 0) await db.canvasVersions.bulkPut(versionUpserts)
    }
  )

  mirroredVersionIds = seenVersionIds
}

/**
 * Sync the comment-store map to the canvasComments table. Reactions
 * are nested inside each comment row, so we always re-upsert every
 * row we have in memory (cheaper than a per-field diff) and delete
 * anything we used to mirror but no longer see.
 */
async function syncComments(byDoc: Record<string, CanvasComment[]>): Promise<void> {
  const db = getDb()
  const seenIds = new Set<string>()
  const upserts: ContextCommentRow[] = []
  for (const list of Object.values(byDoc)) {
    for (const c of list) {
      seenIds.add(c.id)
      upserts.push(contextCommentRowFromCanvas(commentToRow(c)))
    }
  }
  const removedIds: string[] = []
  for (const id of mirroredCommentIds) {
    if (!seenIds.has(id)) removedIds.push(id)
  }
  if (upserts.length === 0 && removedIds.length === 0) return
  await db.transaction("rw", db.contextComments, async () => {
    if (removedIds.length > 0) await db.contextComments.bulkDelete(removedIds)
    if (upserts.length > 0) await db.contextComments.bulkPut(upserts)
  })
  mirroredCommentIds = seenIds
}

/**
 * On boot, check Dexie for canvas data the artifact-store doesn't
 * know about. This happens after a backup import on a fresh device:
 * `applyBackupPackage` writes to Dexie, but the artifact-store
 * (Zustand+localStorage) still has its old / empty state. Without
 * hydration the user can't see the imported documents.
 *
 * We seed the artifact-store with rows that are in Dexie but not in
 * memory; rows already in the store win (Zustand persistence is
 * authoritative for "what the user is editing right now"). Versions
 * and comments are bucketed back onto their parent documents.
 */
async function hydrateFromDexie(): Promise<void> {
  const db = getDb()
  const [docRows, versionRows, commentRows] = await Promise.all([
    db.canvasDocuments.toArray(),
    db.canvasVersions.toArray(),
    db.contextComments.where("resourceKind").equals("canvas-document").toArray(),
  ])
  if (docRows.length === 0 && commentRows.length === 0) return

  const memoryDocs = useArtifactStore.getState().canvasDocuments
  const versionsByDoc = new Map<string, CanvasDocumentVersion[]>()
  for (const row of versionRows) {
    const list = versionsByDoc.get(row.documentId) ?? []
    list.push({
      id: row.id,
      content: row.content,
      title: row.title,
      createdAt: new Date(row.createdAt),
      description: row.description,
      isAutoSave: row.isAutoSave,
    })
    versionsByDoc.set(row.documentId, list)
  }

  const docPatch: Record<string, CanvasDocument> = {}
  for (const row of docRows) {
    if (memoryDocs[row.id]) continue // memory wins
    docPatch[row.id] = {
      id: row.id,
      sessionId: row.sessionId ?? "",
      title: row.title,
      content: row.content,
      language: row.language,
      type: row.type,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
      editorContext: row.editorContext,
      aiSuggestions: row.aiSuggestions,
      currentVersionId: row.currentVersionId,
      versions: (versionsByDoc.get(row.id) ?? []).sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
      ),
    } as CanvasDocument
  }
  if (Object.keys(docPatch).length > 0) {
    useArtifactStore.setState((state) => ({
      canvasDocuments: { ...docPatch, ...state.canvasDocuments },
    }))
  }

  const commentMemory = useCommentStore.getState().comments
  const commentPatch: Record<string, CanvasComment[]> = {}
  for (const contextRow of commentRows) {
    const row = canvasCommentRowFromContext(contextRow)
    const docList = commentPatch[row.documentId] ?? [...(commentMemory[row.documentId] ?? [])]
    if (docList.find((c) => c.id === row.id)) continue
    docList.push({
      ...row,
      createdAt: new Date(row.createdAt),
      updatedAt: row.updatedAt !== undefined ? new Date(row.updatedAt) : undefined,
      resolvedAt: row.resolvedAt !== undefined ? new Date(row.resolvedAt) : undefined,
    })
    commentPatch[row.documentId] = docList
  }
  if (Object.keys(commentPatch).length > 0) {
    useCommentStore.setState((state) => ({
      comments: { ...state.comments, ...commentPatch },
    }))
  }
}

/**
 * Start the bridge. Idempotent; subsequent calls are no-ops. Returns
 * a disposer that cancels the subscriptions if the caller wants to
 * scope the bridge to a specific lifecycle (tests).
 *
 * Boot order: hydrate Dexie → memory FIRST, then start the
 * Zustand → Dexie subscriptions. If we subscribed first, the
 * setState calls during hydration would race the bridge and
 * potentially clobber Dexie rows we hadn't yet observed.
 */
export function startCanvasDexieBridge(): () => void {
  if (started || typeof window === "undefined") return () => {}
  started = true

  let unsubDocs: () => void = () => {}
  let unsubComments: () => void = () => {}

  void hydrateFromDexie()
    .catch((err) => loggers.canvas.warn("dexie-bridge hydration failed", { err: String(err) }))
    .then(() => {
      const initial = useArtifactStore.getState()
      mirroredDocs = { ...initial.canvasDocuments }
      void syncDocumentsAndVersions(initial.canvasDocuments).catch((err) =>
        loggers.canvas.warn("dexie-bridge initial document sync failed", {
          err: String(err),
        })
      )
      void syncComments(useCommentStore.getState().comments).catch((err) =>
        loggers.canvas.warn("dexie-bridge initial comment sync failed", {
          err: String(err),
        })
      )

      unsubDocs = useArtifactStore.subscribe((state) => {
        const docs = state.canvasDocuments
        void syncDocumentsAndVersions(docs)
          .then(() => {
            mirroredDocs = { ...docs }
          })
          .catch((err) =>
            loggers.canvas.warn("dexie-bridge document sync failed", { err: String(err) })
          )
      })

      unsubComments = useCommentStore.subscribe((state) => {
        void syncComments(state.comments).catch((err) =>
          loggers.canvas.warn("dexie-bridge comment sync failed", { err: String(err) })
        )
      })
    })

  return () => {
    unsubDocs()
    unsubComments()
    started = false
  }
}
