"use client"

/**
 * Bridges the in-memory canvas state (Zustand-backed `useArtifactStore`
 * for documents + versions, `useCommentStore` for comments) with the
 * Dexie canvas tables.
 *
 * Dexie is AUTHORITATIVE for documents and versions from persist v7 on.
 * `partialize` used to write every canvas document into the
 * `cognia-artifacts` localStorage blob in full, on every state change —
 * and `editorContext.selection` changes on every cursor move, so moving
 * the caret through one large document re-stringified all of them. Now
 * the store keeps the working copy in memory and this bridge owns the
 * durable one:
 *
 *   - Hydration seeds the store from Dexie for every document memory
 *     does not already hold. Memory still wins on a conflict — it is
 *     either what the user is editing right now, or the v6 blob that
 *     has not been migrated yet, and both are newer than the row.
 *   - Subscription: every store change diffs against the mirror and
 *     writes adds/updates/deletes into Dexie. Versions are flattened
 *     out of each document's nested `versions[]` array into the
 *     dedicated `canvasVersions` table so the backup importer can
 *     restore them on a different device.
 *
 * Two safety rules the account lifecycle forces, shared with
 * `lib/artifacts/dexie-bridge.ts`:
 *
 *   1. **Never write to a database this mirror was not built against.**
 *      Locking an account clears the Dexie selection BEFORE it clears
 *      the store, so a live subscription would observe an empty store
 *      pointed at another database and delete every row in it.
 *   2. **A failed hydration disables the mirror entirely.** Deletes are
 *      derived from "in the mirror, absent from memory"; if hydration
 *      threw, memory is an unknown subset of the table.
 *
 * Comment-store comments are mirrored verbatim with timestamps
 * normalised to numbers. `canvasSessions` is NOT this bridge's to
 * mirror — it already has live writers (`collaboration/crdt-store.ts`
 * on session create/join/leave, and `lib/plugin/api/canvas-api.ts`),
 * which write it directly. All this bridge does with that table is
 * cascade the delete when its document goes away.
 */

import type {
  CanvasDocument,
  CanvasDocumentVersion,
  CanvasPendingReview,
} from "@/types/artifact/artifact"
import type { CanvasComment } from "@/types/canvas/collaboration"
import { rehydrateCanvasDocument, useArtifactStore } from "@/stores/artifact/artifact-store"
import { useCommentStore } from "@/stores/canvas/comment-store"
import { getDb } from "@/lib/db/schema"
import type { CanvasCommentRow, CanvasDocumentRow, CanvasVersionRow } from "@/lib/db/canvas-types"
import type { ContextCommentRow } from "@/types/context-comment"
import { canvasCommentRowFromContext, contextCommentRowFromCanvas } from "@/lib/db/context-comments"
import { loggers } from "@cognia/logging"

/**
 * How long a burst of edits may accumulate before it reaches Dexie. The editor
 * already commits on a typing pause, so this only coalesces what survives that:
 * cursor moves, selection changes, autosave ticks.
 */
const DOCUMENT_SYNC_DEBOUNCE_MS = 500

let started = false
let flushDocumentSync: (() => void) | null = null
let mirroredDocs: Record<string, CanvasDocument> = {}
/**
 * The proposal last written per document. A review lives in a different store
 * map from the document, so its change does not alter the document's object
 * identity and the identity bail below would skip the write.
 */
let mirroredReviews: Record<string, CanvasPendingReview | undefined> = {}
let mirroredVersionIds = new Set<string>()
let mirroredCommentIds = new Set<string>()
/** Which database {@link mirroredDocs} describes — see rule 1 in the header. */
let mirroredDbName: string | null = null

/** Test-only: drop the module-level mirror so suites don't leak into each other. */
export function __resetCanvasDexieBridgeForTesting(): void {
  started = false
  flushDocumentSync = null
  mirroredDocs = {}
  mirroredVersionIds = new Set()
  mirroredCommentIds = new Set()
  mirroredReviews = {}
  mirroredDbName = null
}

function dateMs(d: Date | string | undefined): number {
  if (!d) return 0
  return d instanceof Date ? d.getTime() : new Date(d).getTime()
}

function docToRow(doc: CanvasDocument, pendingReview?: CanvasPendingReview): CanvasDocumentRow {
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
    // Dropped by this mirror until persist v7. Invisible while localStorage
    // was authoritative; a broken "return to the artifact this came from" the
    // moment it stopped being.
    sourceArtifactId: doc.sourceArtifactId,
    returnContext: doc.returnContext,
    authoringOrigin: doc.authoringOrigin,
    aiWorkbench: doc.aiWorkbench,
    ...(pendingReview ? { pendingReview } : {}),
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
async function syncDocumentsAndVersions(
  next: Record<string, CanvasDocument>,
  reviews: Record<string, CanvasPendingReview> = {}
): Promise<void> {
  const db = getDb()
  // Rule 1 — see the module header. The mirror describes one database; a
  // different one means the account changed under us and the provider is about
  // to restart the bridge.
  if (mirroredDbName !== null && db.name !== mirroredDbName) return
  const prevIds = new Set(Object.keys(mirroredDocs))
  const nextIds = new Set(Object.keys(next))
  const removedDocs: string[] = []
  for (const id of prevIds) if (!nextIds.has(id)) removedDocs.push(id)

  // Upsert only the documents whose object identity actually changed.
  //
  // This used to push EVERY document unconditionally, which made the early
  // return below unreachable whenever at least one document existed — so a
  // single keystroke ran an IndexedDB transaction that re-put the entire canvas
  // corpus plus its whole version history. The store replaces a document's
  // object on every mutation, so identity is a sound "did this change" test.
  const docUpserts: CanvasDocumentRow[] = []
  for (const id of nextIds) {
    // Two identities to compare, not one: the document and its open proposal.
    // Accepting a hunk changes only the review, and a review that never
    // reached the row would be lost on reload with the document intact.
    if (mirroredDocs[id] === next[id] && mirroredReviews[id] === reviews[id]) continue
    docUpserts.push(docToRow(next[id], reviews[id]))
  }

  // Reconcile versions: collect every (documentId, version) pair from
  // memory; everything we used to mirror but isn't in this list gets
  // removed; everything NEW gets bulk-put. A version is immutable once
  // written, so an id we have already mirrored needs no rewrite.
  const seenVersionIds = new Set<string>()
  const versionUpserts: CanvasVersionRow[] = []
  for (const id of nextIds) {
    const doc = next[id]
    for (const v of doc.versions ?? []) {
      seenVersionIds.add(v.id)
      if (mirroredVersionIds.has(v.id)) continue
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
  mirroredReviews = { ...reviews }
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
 * Seed the artifact-store from Dexie. On an ordinary boot this IS the
 * documents — the store no longer persists them — and it is also how a
 * backup import lands, since `applyBackupPackage` writes Dexie while the
 * store still holds its old state.
 *
 * Rows already in memory win: they are either what the user is editing
 * right now, or the v6 blob that has not been migrated yet. Versions and
 * comments are bucketed back onto their parent documents.
 */
async function hydrateFromDexie(): Promise<void> {
  const db = getDb()
  const [docRows, versionRows, commentRows] = await Promise.all([
    db.canvasDocuments.toArray(),
    db.canvasVersions.toArray(),
    db.contextComments.where("resourceKind").equals("canvas-document").toArray(),
  ])
  // Stamped before the early return: rule 1 needs to know which database this
  // mirror belongs to even when that database turned out to be empty.
  mirroredDbName = db.name
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
  const reviewPatch: Record<string, CanvasPendingReview> = {}
  for (const row of docRows) {
    if (memoryDocs[row.id]) continue // memory wins
    docPatch[row.id] = rehydrateCanvasDocument({
      id: row.id,
      sessionId: row.sessionId ?? "",
      projectId: row.projectId,
      title: row.title,
      content: row.content,
      language: row.language,
      type: row.type,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
      editorContext: row.editorContext,
      aiSuggestions: row.aiSuggestions,
      currentVersionId: row.currentVersionId,
      sourceArtifactId: row.sourceArtifactId,
      returnContext: row.returnContext,
      authoringOrigin: row.authoringOrigin,
      aiWorkbench: row.aiWorkbench,
      versions: (versionsByDoc.get(row.id) ?? []).sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
      ),
    } as CanvasDocument)
    if (row.pendingReview) {
      // The proposal goes back into `pendingReviews`, which is where the review
      // UI, the tools and the workflow nodes all read it from. Its dates come
      // back as strings from IndexedDB.
      reviewPatch[row.id] = {
        ...row.pendingReview,
        createdAt: new Date(row.pendingReview.createdAt),
      }
    }
  }
  if (Object.keys(docPatch).length > 0 || Object.keys(reviewPatch).length > 0) {
    useArtifactStore.setState((state) => ({
      canvasDocuments: { ...docPatch, ...state.canvasDocuments },
      // Memory wins, same rule as documents: a proposal made this session is
      // newer than one read off disk.
      pendingReviews: { ...reviewPatch, ...state.pendingReviews },
    }))
  }

  // Prime the mirror with exactly what was seeded, so the first sync does not
  // write back the rows it just read. Documents already in memory are
  // deliberately NOT primed: memory won the conflict, so the row on disk is
  // stale and the first sync has to overwrite it.
  mirroredDocs = { ...docPatch }
  mirroredVersionIds = new Set(
    Object.values(docPatch).flatMap((doc) => (doc.versions ?? []).map((v) => v.id))
  )

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

  let disposed = false

  void hydrateFromDexie()
    .then(() => {
      if (disposed) return
      const initialDocs = useArtifactStore.getState().canvasDocuments
      // Documents hydration did NOT seed — the ones that exist only in memory,
      // which on the first boot after persist v7 means the ones still coming
      // out of the old localStorage blob — reach Dexie here.
      void syncDocumentsAndVersions(initialDocs, useArtifactStore.getState().pendingReviews ?? {})
        .then(() => {
          mirroredDocs = { ...initialDocs }
        })
        .catch((err) =>
          loggers.canvas.warn("dexie-bridge initial document sync failed", {
            err: String(err),
          })
        )
      void syncComments(useCommentStore.getState().comments).catch((err) =>
        loggers.canvas.warn("dexie-bridge initial comment sync failed", {
          err: String(err),
        })
      )

      // The subscription is unselected — it fires on EVERY artifact-store write,
      // including the ones that only touch artifacts. Bail on identity before
      // doing any work, and coalesce a typing burst into one transaction.
      let lastSeenDocs = initialDocs
      let lastSeenReviews = useArtifactStore.getState().pendingReviews ?? {}
      let pendingSync: ReturnType<typeof setTimeout> | null = null
      let queuedDocs: Record<string, CanvasDocument> | null = null
      let queuedReviews: Record<string, CanvasPendingReview> = lastSeenReviews

      const runSync = () => {
        pendingSync = null
        const docs = queuedDocs
        const reviews = queuedReviews
        queuedDocs = null
        if (!docs) return
        void syncDocumentsAndVersions(docs, reviews)
          .then(() => {
            mirroredDocs = { ...docs }
          })
          .catch((err) =>
            loggers.canvas.warn("dexie-bridge document sync failed", { err: String(err) })
          )
      }

      flushDocumentSync = () => {
        if (pendingSync !== null) {
          clearTimeout(pendingSync)
          runSync()
        }
      }

      unsubDocs = useArtifactStore.subscribe((state) => {
        const docs = state.canvasDocuments
        const reviews = state.pendingReviews ?? {}
        if (docs === lastSeenDocs && reviews === lastSeenReviews) return
        lastSeenDocs = docs
        lastSeenReviews = reviews
        queuedDocs = docs
        queuedReviews = reviews
        if (pendingSync !== null) clearTimeout(pendingSync)
        pendingSync = setTimeout(runSync, DOCUMENT_SYNC_DEBOUNCE_MS)
      })

      if (typeof window !== "undefined") {
        window.addEventListener("pagehide", flushDocumentSync)
      }

      unsubComments = useCommentStore.subscribe((state) => {
        void syncComments(state.comments).catch((err) =>
          loggers.canvas.warn("dexie-bridge comment sync failed", { err: String(err) })
        )
      })
    })
    .catch((err) => {
      // Rule 2 — see the module header. No mirror, no deletes. The `.catch`
      // used to sit BEFORE the `.then`, which swallowed the failure and started
      // the subscriptions anyway: a partial read then looked like "the user
      // deleted everything I did not see".
      loggers.canvas.warn("dexie-bridge hydration failed; mirror disabled", {
        err: String(err),
      })
    })

  return () => {
    disposed = true
    // A pending mirror must not be lost when the bridge is torn down.
    flushDocumentSync?.()
    if (typeof window !== "undefined" && flushDocumentSync) {
      window.removeEventListener("pagehide", flushDocumentSync)
    }
    flushDocumentSync = null
    unsubDocs()
    unsubComments()
    mirroredDocs = {}
    mirroredVersionIds = new Set()
    mirroredCommentIds = new Set()
    mirroredDbName = null
    started = false
  }
}
