import type { UIMessage } from "ai"
import type { StoredMessage } from "@cognia/agent-config-types"
import { markMessagesRemoved, markSessionDirty } from "@/lib/chat/search/indexer"
import { normalizeMessageMedia } from "@/lib/chat/media/normalize-message-media"
import { publishTranscriptRevision } from "@/lib/chat/transcript/revision-events"
import { getDb, withDbReopenRetry } from "./schema"
import { resolveScopeProjectId } from "./project-scope"
import {
  collectUnreferencedMessageMedia,
  messageMediaRefRows,
} from "./message-media-refs"

function newId() {
  return "m_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

/** Max characters kept in the denormalized {@link ChatSession.lastMessagePreview}. */
const PREVIEW_MAX = 120

/** Concatenate the text of a message's `text` parts (ignores tool/file parts). */
function messageText(parts: StoredMessage["parts"]): string {
  let out = ""
  for (const p of parts ?? []) {
    if (p && typeof p === "object" && (p as { type?: unknown }).type === "text") {
      const t = (p as { text?: unknown }).text
      if (typeof t === "string") out += (out ? " " : "") + t
    }
  }
  return out
}

/** One-line, length-capped preview derived from a message's text parts. */
function previewOf(parts: StoredMessage["parts"]): string {
  return messageText(parts).replace(/\s+/g, " ").trim().slice(0, PREVIEW_MAX)
}

async function bumpTranscriptRevision(
  db: ReturnType<typeof getDb>,
  sessionId: string
): Promise<number | null> {
  const session = await db.sessions.get(sessionId)
  if (!session) return null
  const revision = (session.transcriptRevision ?? 0) + 1
  await db.sessions.update(sessionId, { transcriptRevision: revision })
  return revision
}

/**
 * Per-session snapshot of the last *committed* persist: message id →
 * `{ ref, createdAt }`. `ref` is the in-memory `UIMessage` object reference at
 * the time it was written. The streaming adapter keeps object references stable
 * for messages that didn't change (`lib/claude/adapter.ts`), so ref-equality
 * against this snapshot cleanly tells `persistMessages` which rows are
 * unchanged and can be skipped — turning a per-event O(n) full-table rewrite
 * into O(changed rows). It also caches `createdAt` so steady-state streaming
 * never has to `bulkGet` existing rows just to preserve ordering.
 *
 * Only valid because same-session events are serialized upstream
 * (`hooks/chat/use-claude-chat.ts`), so there is never a concurrent persist for
 * one session racing this cache. Any out-of-band mutation of a session's rows
 * (clear / truncate / delete) must call `invalidatePersistSnapshot`.
 */
const persistSnapshots = new Map<string, Map<string, { ref: UIMessage; createdAt: number }>>()

/** Drop the cached persist snapshot for a session (see `persistSnapshots`). */
export function invalidatePersistSnapshot(sessionId: string): void {
  persistSnapshots.delete(sessionId)
}

/**
 * Metadata keys that `listMessages` synthesizes from top-level columns. They
 * exist on the in-memory `UIMessage` purely so the UI can read them without
 * threading props; the column is the source of truth, so `persistMessages`
 * strips them back out rather than duplicating them into the metadata blob.
 */
const HOISTED_META_KEYS = ["senderId", "senderKind", "sessionId", "createdAt", "turnKey"] as const

/**
 * Drop the hoisted keys from a message's metadata ahead of a write. Returns
 * `undefined` when nothing else remains, matching the "don't store an empty
 * blob" convention.
 */
export function stripHoistedMeta(
  meta: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!meta) return undefined
  const copy = { ...meta }
  for (const key of HOISTED_META_KEYS) delete copy[key]
  return Object.keys(copy).length > 0 ? copy : undefined
}

export async function listMessages(sessionId: string): Promise<UIMessage[]> {
  const rows = await getDb()
    .messages.where("[sessionId+createdAt]")
    .between([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER])
    .toArray()
  return rows
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((r) => {
      // Hoist top-level senderId/senderKind into metadata so the UI layer can
      // read them off the in-memory UIMessage. (The store itself uses
      // ai.UIMessage which has no senderId field.)
      // We also surface `sessionId` so per-message components like the
      // trigger badge can read it without threading new props, and `createdAt`
      // so the timeline minimap and the message action bar can show a real
      // wall-clock time instead of falling back to "now".
      // Every key hoisted here MUST be listed in HOISTED_META_KEYS so the next
      // persist strips it back out — the column stays the source of truth.
      const metadata: Record<string, unknown> = { ...(r.metadata ?? {}) }
      if (r.senderId !== undefined) metadata.senderId = r.senderId
      if (r.senderKind !== undefined) metadata.senderKind = r.senderKind
      if (r.turnKey !== undefined) metadata.turnKey = r.turnKey
      metadata.sessionId = r.sessionId
      metadata.createdAt = r.createdAt
      return {
        id: r.id,
        role: r.role,
        parts: r.parts,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      }
    })
}

/**
 * Persist the current message list for a session.
 *
 * Streaming sends one event per token-batch, so this gets called many times
 * per turn. We diff by id: upsert what's still here, delete what disappeared.
 * That keeps the IO proportional to *changed* messages instead of total
 * messages, which matters once a session grows past a few dozen turns.
 */
export async function replaceSessionTranscript(
  sessionId: string,
  messages: UIMessage[]
): Promise<void> {
  const db = getDb()
  const now = Date.now()
  const normalizedMessages = await Promise.all(messages.map(normalizeMessageMedia))

  // Owning workspace for these rows (Workspace isolation, Dexie v86). Resolved
  // once per call from the session — messages inherit their session's project.
  // Falls back to the active project for a session row that predates the column.
  const session = await db.sessions.get(sessionId)
  const projectId = session?.projectId ?? (await resolveScopeProjectId())

  // Captured outside the transaction so we can fan-out trigger.chat.message
  // events for newly-arrived user messages once the rows are persisted.
  const newUserMessageIds: string[] = []

  // The last message's resolved timestamp + parts, captured in the write loop
  // so we can denormalize a preview onto the session row after commit.
  let lastPreviewSource: { createdAt: number; parts: StoredMessage["parts"] } | null = null

  const snapshot = persistSnapshots.get(sessionId)
  // Built inside the transaction, applied to `persistSnapshots` only after the
  // write commits — so a thrown/aborted transaction never leaves the cache
  // ahead of disk.
  let nextSnapshot: Map<string, { ref: UIMessage; createdAt: number }> | null = null
  let clearSnapshot = false
  const orphanCandidates = new Set<string>()
  let publishedRevision: number | null = null

  await withDbReopenRetry(() => {
    const transactionDb = getDb()
    newUserMessageIds.length = 0
    lastPreviewSource = null
    nextSnapshot = null
    clearSnapshot = false
    publishedRevision = null
    return transactionDb.transaction(
      "rw",
      transactionDb.messages,
      transactionDb.messageMediaRefs,
      transactionDb.sessions,
      () => {
      // Existing ids for this session — used to compute deletions. `primaryKeys`
      // reads the index only (no row/parts deserialization), so this stays cheap.
      return transactionDb.messages
        .where("sessionId")
        .equals(sessionId)
        .primaryKeys()
        .then((existingKeys) => {
          const existingIds = new Set(existingKeys as string[])

          if (messages.length === 0) {
            clearSnapshot = true
            return transactionDb.messageMediaRefs
              .where("sessionId")
              .equals(sessionId)
              .toArray()
              .then((refs) => {
                for (const ref of refs) orphanCandidates.add(ref.hash)
                return Promise.all([
                  existingIds.size > 0
                    ? transactionDb.messages.bulkDelete([...existingIds])
                    : Promise.resolve(),
                  transactionDb.messageMediaRefs.where("sessionId").equals(sessionId).delete(),
                ]).then(async () => {
                  if (existingIds.size > 0) {
                    publishedRevision = await bumpTranscriptRevision(transactionDb, sessionId)
                  }
                })
              })
          }

          // createdAt source: prefer the in-memory snapshot; only fetch rows from
          // Dexie for ids that exist on disk but aren't cached (cold start). In
          // steady-state streaming the snapshot covers every existing id, so this
          // read — the old per-event full-table `bulkGet` — is skipped entirely.
          const createdAtById = new Map<string, number>()
          if (snapshot) {
            for (const [id, entry] of snapshot) createdAtById.set(id, entry.createdAt)
          }
          const missingIds = [...existingIds].filter((id) => !createdAtById.has(id))

          const persistRows = (fetched: Array<StoredMessage | undefined>): Promise<void> => {
            for (const row of fetched) {
              if (row) createdAtById.set(row.id, row.createdAt)
            }

            // Only changed/new rows are written; unchanged ones are skipped via
            // ref-equality against the snapshot. `incomingIds` still covers *all*
            // messages so deletion stays computed against the full set.
            const rows: StoredMessage[] = []
            const incomingIds = new Set<string>()
            nextSnapshot = new Map<string, { ref: UIMessage; createdAt: number }>()

            for (let i = 0; i < messages.length; i++) {
              const message = messages[i]
              const normalizedMessage = normalizedMessages[i] ?? message
              const id = message.id ?? newId()
              incomingIds.add(id)

              const createdAt = createdAtById.get(id) ?? now + i
              nextSnapshot.set(id, { ref: message, createdAt })
              if (i === messages.length - 1) {
                lastPreviewSource = { createdAt, parts: message.parts }
              }

              const prevEntry = snapshot?.get(id)
              if (prevEntry !== undefined && prevEntry.ref === message && existingIds.has(id)) {
                continue
              }

              const meta = (message as { metadata?: Record<string, unknown> }).metadata
              const senderId = typeof meta?.senderId === "string" ? meta.senderId : undefined
              const senderKindRaw = meta?.senderKind
              const senderKind =
                senderKindRaw === "user" ||
                senderKindRaw === "assistant" ||
                senderKindRaw === "system"
                  ? senderKindRaw
                  : undefined
              rows.push({
                id,
                sessionId,
                projectId,
                role: message.role,
                parts: normalizedMessage.parts,
                turnKey: typeof meta?.turnKey === "string" ? meta.turnKey : undefined,
                senderId,
                senderKind,
                metadata: stripHoistedMeta(meta),
                createdAt,
              })
              // `triggerWorkflows: false` opts a message out of the
              // `trigger.chat.message` fan-out. Live-voice turns set it: the
              // user spoke to the assistant directly and never went through the
              // send path, so firing chat-message workflows would surprise
              // them. The flag must be present on FIRST persist —
              // `updateMessageMetadata` cannot retract a dispatch that already
              // happened.
              if (
                !existingIds.has(id) &&
                message.role === "user" &&
                meta?.triggerWorkflows !== false
              ) {
                newUserMessageIds.push(id)
              }
            }

            const toDelete = [...existingIds].filter((id) => !incomingIds.has(id))
            const changedIds = [...toDelete, ...rows.map((row) => row.id)]
            const replacementRefs = rows.flatMap((row) =>
              messageMediaRefRows(row.id, row.sessionId, row.parts)
            )
            const oldRefs =
              changedIds.length > 0
                ? transactionDb.messageMediaRefs.where("messageId").anyOf(changedIds).toArray()
                : Promise.resolve([])
            return oldRefs.then(async (refs) => {
              for (const ref of refs) orphanCandidates.add(ref.hash)
              if (toDelete.length > 0) await transactionDb.messages.bulkDelete(toDelete)
              if (rows.length > 0) await transactionDb.messages.bulkPut(rows)
              if (changedIds.length > 0) {
                await transactionDb.messageMediaRefs.where("messageId").anyOf(changedIds).delete()
              }
              if (replacementRefs.length > 0) {
                await transactionDb.messageMediaRefs.bulkPut(replacementRefs)
              }
              if (changedIds.length > 0) {
                publishedRevision = await bumpTranscriptRevision(transactionDb, sessionId)
              }
            })
          }

          return missingIds.length > 0
            ? transactionDb.messages.bulkGet(missingIds).then(persistRows)
            : persistRows([])
        })
      }
    )
  })

  if (orphanCandidates.size > 0) {
    await collectUnreferencedMessageMedia(orphanCandidates)
  }
  if (publishedRevision !== null) {
    await publishTranscriptRevision(sessionId, publishedRevision)
  }

  // Commit the cache only after the transaction resolved cleanly.
  if (clearSnapshot) {
    persistSnapshots.delete(sessionId)
  } else if (nextSnapshot) {
    persistSnapshots.set(sessionId, nextSnapshot)
  }

  // Denormalize a preview of the last message onto the session row so the
  // sidebar can render a preview line without a per-row message query. Written
  // only on a message *boundary* (a different `lastMessageAt`) — never on
  // in-place streaming text growth, which would rewrite the row on every token
  // batch and churn the sidebar's `useLiveQuery`. A long streamed reply's
  // preview may therefore show an early chunk; it refreshes on the next message.
  // Re-widen: `lastPreviewSource` is only ever assigned inside the transaction
  // closure, so the compiler's outer-flow type stays at its `null` initializer.
  const previewSource = lastPreviewSource as {
    createdAt: number
    parts: StoredMessage["parts"]
  } | null
  if (previewSource && session) {
    const boundaryChanged =
      session.lastMessageAt !== previewSource.createdAt || session.lastMessagePreview === undefined
    if (boundaryChanged) {
      await withDbReopenRetry(() =>
        getDb().sessions.update(sessionId, {
          lastMessagePreview: previewOf(previewSource.parts),
          lastMessageAt: previewSource.createdAt,
        })
      )
    }
  }

  if (newUserMessageIds.length > 0) {
    // Fire-and-forget so persistence is never blocked by the workflow
    // subsystem. Each user-message arrival is its own trigger event so a
    // workflow scoped to the session/character fans out once per message.
    void dispatchChatMessageTriggers(sessionId, newUserMessageIds, session?.characterId).catch(
      () => {
        // Swallow — the trigger fan-out is best-effort and must not surface
        // to the chat send pipeline.
      }
    )
  }

  // Derived search text trails persistence by design. Marking is O(1); the
  // shared search hook drains and reconciles this session off the typing and
  // streaming hot paths.
  markSessionDirty(sessionId)
}

/**
 * Backward-compatible name for callers that still own a complete transcript
 * snapshot. Partial windows must use {@link commitMessageDelta}; omissions in
 * this API are intentionally interpreted as deletions.
 */
export const persistMessages = replaceSessionTranscript

export interface MessageDelta {
  /** Messages to insert or replace. Omitted stored messages remain untouched. */
  upserts?: UIMessage[]
  /** Explicit deletions. IDs belonging to another session are ignored. */
  deleteIds?: string[]
}

/**
 * Persist an explicit partial transcript change without treating unloaded
 * history as deleted. This is the safe write path for timeline/detail paging,
 * reconnect reconciliation, and any producer that does not own a full
 * session snapshot.
 */
export async function commitMessageDelta(
  sessionId: string,
  { upserts = [], deleteIds = [] }: MessageDelta
): Promise<void> {
  const db = getDb()
  const session = await db.sessions.get(sessionId)
  const projectId = session?.projectId ?? (await resolveScopeProjectId())
  const normalized = await Promise.all(upserts.map(normalizeMessageMedia))
  const upsertIds = normalized.map((message) => message.id || newId())
  if (new Set(upsertIds).size !== upsertIds.length) {
    throw new Error("Message delta contains duplicate upsert ids")
  }

  const existingUpserts = await db.messages.bulkGet(upsertIds)
  const existingById = new Map(
    existingUpserts
      .filter((row): row is StoredMessage => row !== undefined)
      .map((row) => [row.id, row])
  )
  for (const row of existingById.values()) {
    if (row.sessionId !== sessionId) {
      throw new Error("Message delta cannot move a message between sessions")
    }
  }

  const now = Date.now()
  const rows = normalized.map((message, index): StoredMessage => {
    const id = upsertIds[index]!
    const meta = (message as { metadata?: Record<string, unknown> }).metadata
    const senderKindRaw = meta?.senderKind
    const senderKind =
      senderKindRaw === "user" || senderKindRaw === "assistant" || senderKindRaw === "system"
        ? senderKindRaw
        : undefined
    return {
      id,
      sessionId,
      projectId,
      role: message.role,
      parts: message.parts,
      turnKey: typeof meta?.turnKey === "string" ? meta.turnKey : undefined,
      senderId: typeof meta?.senderId === "string" ? meta.senderId : undefined,
      senderKind,
      metadata: stripHoistedMeta(meta),
      createdAt: existingById.get(id)?.createdAt ?? now + index,
    }
  })

  const requestedDeleteIds = [...new Set(deleteIds)].filter((id) => !upsertIds.includes(id))
  const existingDeletes = await db.messages.bulkGet(requestedDeleteIds)
  const effectiveDeleteIds = existingDeletes
    .filter((row): row is StoredMessage => row?.sessionId === sessionId)
    .map((row) => row.id)
  const changedIds = [...effectiveDeleteIds, ...upsertIds]
  if (changedIds.length === 0) return

  const newUserMessageIds = rows
    .filter(
      (row) =>
        !existingById.has(row.id) &&
        row.role === "user" &&
        row.metadata?.triggerWorkflows !== false
    )
    .map((row) => row.id)
  const orphanCandidates = new Set<string>()
  let publishedRevision: number | null = null

  await db.transaction("rw", db.messages, db.messageMediaRefs, db.sessions, async () => {
    const oldRefs = await db.messageMediaRefs.where("messageId").anyOf(changedIds).toArray()
    for (const ref of oldRefs) orphanCandidates.add(ref.hash)
    if (effectiveDeleteIds.length > 0) await db.messages.bulkDelete(effectiveDeleteIds)
    if (rows.length > 0) await db.messages.bulkPut(rows)
    await db.messageMediaRefs.where("messageId").anyOf(changedIds).delete()
    const replacementRefs = rows.flatMap((row) =>
      messageMediaRefRows(row.id, row.sessionId, row.parts)
    )
    if (replacementRefs.length > 0) await db.messageMediaRefs.bulkPut(replacementRefs)
    publishedRevision = await bumpTranscriptRevision(db, sessionId)
  })

  invalidatePersistSnapshot(sessionId)
  if (orphanCandidates.size > 0) {
    await collectUnreferencedMessageMedia(orphanCandidates)
  }
  if (publishedRevision !== null) {
    await publishTranscriptRevision(sessionId, publishedRevision)
  }
  if (newUserMessageIds.length > 0) {
    void dispatchChatMessageTriggers(sessionId, newUserMessageIds, session?.characterId).catch(
      () => {}
    )
  }
  markSessionDirty(sessionId)
}

/**
 * Persist an append-only stream update without reconciling the full session.
 *
 * This is deliberately narrower than {@link persistMessages}: callers may use
 * it only for mid-turn growth where the message set/order is unchanged and the
 * trailing message is the sole mutation. A missing or incompatible snapshot
 * falls back to the full reconciler, so the first chunk and every message
 * boundary retain the normal insertion/deletion guarantees.
 */
export async function persistStreamingMessages(
  sessionId: string,
  messages: UIMessage[]
): Promise<void> {
  const last = messages.at(-1)
  const snapshot = persistSnapshots.get(sessionId)
  const lastEntry = last?.id ? snapshot?.get(last.id) : undefined
  const first = messages[0]
  const previous = messages.length > 1 ? messages[messages.length - 2] : undefined
  const snapshotMatches =
    last !== undefined &&
    last.id.length > 0 &&
    snapshot !== undefined &&
    snapshot.size === messages.length &&
    lastEntry !== undefined &&
    (first === undefined || snapshot.has(first.id)) &&
    (previous === undefined || snapshot.has(previous.id))

  if (!snapshotMatches) {
    await persistMessages(sessionId, messages)
    return
  }

  const meta = (last as { metadata?: Record<string, unknown> }).metadata
  const senderId = typeof meta?.senderId === "string" ? meta.senderId : undefined
  const senderKindRaw = meta?.senderKind
  const senderKind =
    senderKindRaw === "user" || senderKindRaw === "assistant" || senderKindRaw === "system"
      ? senderKindRaw
      : undefined
  const normalizedLast = await normalizeMessageMedia(last)
  const db = getDb()
  const oldRefs = await db.messageMediaRefs.where("messageId").equals(last.id).toArray()
  const replacementRefs = messageMediaRefRows(last.id, sessionId, normalizedLast.parts)
  const updated = await db.transaction("rw", db.messages, db.messageMediaRefs, async () => {
    const count = await db.messages.update(last.id, {
      role: last.role,
      parts: normalizedLast.parts,
      turnKey: typeof meta?.turnKey === "string" ? meta.turnKey : undefined,
      senderId,
      senderKind,
      metadata: stripHoistedMeta(meta),
    })
    if (count === 0) return count
    await db.messageMediaRefs.where("messageId").equals(last.id).delete()
    if (replacementRefs.length > 0) await db.messageMediaRefs.bulkPut(replacementRefs)
    return count
  })

  // An out-of-band delete can invalidate an otherwise compatible in-memory
  // snapshot. Recover through the full path instead of silently dropping the
  // streamed row.
  if (updated === 0) {
    invalidatePersistSnapshot(sessionId)
    await persistMessages(sessionId, messages)
    return
  }

  snapshot.set(last.id, { ref: last, createdAt: lastEntry.createdAt })
  if (oldRefs.length > 0) {
    await collectUnreferencedMessageMedia(oldRefs.map((ref) => ref.hash))
  }
  markSessionDirty(sessionId)
}

/**
 * Look up workflows subscribed to `trigger.chat.message` for the session's
 * character + session scope and invoke the orchestrator for each match.
 *
 * Kept here (rather than in the chat-send path) so every code path that
 * lands a user message in Dexie — direct chat, IM bridge inbound,
 * scheduled replay — fans out triggers consistently.
 */
async function dispatchChatMessageTriggers(
  sessionId: string,
  newUserMessageIds: string[],
  characterId?: string
): Promise<void> {
  // Resolve the lightweight in-memory subscription index first. Most messages
  // have no matching workflow, so avoid loading the orchestrator/plugin graph
  // (and touching Dexie again) on that overwhelmingly common path.
  const { findMatchingWorkflows } = await import("@/lib/workflow/runtime/trigger-subscriptions")
  const matches = findMatchingWorkflows("trigger.chat.message", {
    characterId,
    sessionId,
  })
  if (matches.length === 0) return

  // Lazy-load the heavy runtime only when dispatch work actually exists.
  const [{ dispatchTrigger }, audit] = await Promise.all([
    import("@/lib/workflow/runtime/trigger-bridge"),
    import("@/lib/chat/trigger-audit-ring"),
  ])

  const originAt = Date.now()
  await Promise.all(
    newUserMessageIds.flatMap((messageId) =>
      matches.map((match) =>
        dispatchTrigger({
          workflowId: match.workflowId,
          kind: "trigger.chat.message",
          triggerId: match.nodeId,
          payload: { messageId, sessionId, characterId },
          originAt,
          binding: { sessionId, characterId },
        })
          .then(() => {
            audit.recordTriggerAuditEntry({
              sessionId,
              messageId,
              kind: "trigger.chat.message",
              pluginId: null,
              workflowId: match.workflowId,
              status: "dispatched",
              timestamp: originAt,
            })
          })
          .catch((error: unknown) => {
            // Per-match failures are isolated so one bad workflow can't
            // block other subscribers from running.
            audit.recordTriggerAuditEntry({
              sessionId,
              messageId,
              kind: "trigger.chat.message",
              pluginId: null,
              workflowId: match.workflowId,
              status: "error",
              timestamp: Date.now(),
              errorMessage: error instanceof Error ? error.message : String(error),
            })
          })
      )
    )
  )
}

export async function clearMessages(sessionId: string): Promise<void> {
  const db = getDb()
  const refs = await db.messageMediaRefs.where("sessionId").equals(sessionId).toArray()
  let revision: number | null = null
  await db.transaction("rw", db.messages, db.messageMediaRefs, db.sessions, async () => {
    const deleted = await db.messages.where("sessionId").equals(sessionId).delete()
    await db.messageMediaRefs.where("sessionId").equals(sessionId).delete()
    if (deleted > 0) revision = await bumpTranscriptRevision(db, sessionId)
  })
  invalidatePersistSnapshot(sessionId)
  markSessionDirty(sessionId)
  if (refs.length > 0) {
    await collectUnreferencedMessageMedia(refs.map((ref) => ref.hash))
  }
  if (revision !== null) await publishTranscriptRevision(sessionId, revision)
}

/**
 * Delete one persisted message and invalidate every derived view of that row.
 *
 * UI callers should use this helper instead of writing to the Dexie table
 * directly so the persist snapshot and indexed global search cannot retain a
 * message that no longer exists.
 */
export async function deleteStoredMessage(messageId: string): Promise<void> {
  const db = getDb()
  const row = await db.messages.get(messageId)
  if (!row) return

  const refs = await db.messageMediaRefs.where("messageId").equals(messageId).toArray()
  let revision: number | null = null
  await db.transaction("rw", db.messages, db.messageMediaRefs, db.sessions, async () => {
    await db.messages.delete(messageId)
    await db.messageMediaRefs.where("messageId").equals(messageId).delete()
    revision = await bumpTranscriptRevision(db, row.sessionId)
  })
  invalidatePersistSnapshot(row.sessionId)
  markMessagesRemoved([messageId])
  if (refs.length > 0) {
    await collectUnreferencedMessageMedia(refs.map((ref) => ref.hash))
  }
  if (revision !== null) await publishTranscriptRevision(row.sessionId, revision)
}

/**
 * Merge a metadata patch into a single message row, touching nothing else.
 *
 * Unlike `persistMessages` — which diffs the *whole* session array and deletes
 * any id not present — this updates exactly one row by id. That makes it safe to
 * call fire-and-forget from background tasks (e.g. the timeline-label model
 * call) that hold a stale message snapshot: it can never `bulkDelete` a turn
 * that landed after the snapshot was captured. The routing/derived keys
 * (`senderId`/`senderKind`/`sessionId`) are stripped so they aren't
 * double-persisted (they live in dedicated columns / are re-derived on read).
 */
export async function updateMessageMetadata(
  sessionId: string,
  messageId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const db = getDb()
  const row = await db.messages.get(messageId)
  if (!row || row.sessionId !== sessionId) return
  const merged = stripHoistedMeta({ ...(row.metadata ?? {}), ...patch })
  let revision: number | null = null
  await db.transaction("rw", db.messages, db.sessions, async () => {
    await db.messages.update(messageId, { metadata: merged })
    revision = await bumpTranscriptRevision(db, sessionId)
  })
  // The row changed out-of-band from the persist snapshot; drop it so the next
  // `persistMessages` re-derives existence/createdAt from disk.
  invalidatePersistSnapshot(sessionId)
  if (revision !== null) await publishTranscriptRevision(sessionId, revision)
}

/**
 * Drop every message in `sessionId` whose `createdAt` is strictly greater than
 * the anchor message's `createdAt`. Used by edit-and-resend / regenerate to
 * lop off the tail before re-issuing a turn.
 *
 * If the anchor is unknown we delete nothing rather than wiping the session.
 */
export async function truncateAfter(
  sessionId: string,
  anchorMessageId: string,
  options: { inclusive?: boolean } = {}
): Promise<void> {
  const db = getDb()
  const anchor = await db.messages.get(anchorMessageId)
  if (!anchor || anchor.sessionId !== sessionId) return

  const lowerBound = options.inclusive ? anchor.createdAt : anchor.createdAt + 1
  const orphanCandidates = new Set<string>()
  let revision: number | null = null
  await db.transaction("rw", db.messages, db.messageMediaRefs, db.sessions, async () => {
    const ids = await db.messages
      .where("[sessionId+createdAt]")
      .between([sessionId, lowerBound], [sessionId, Number.MAX_SAFE_INTEGER])
      .primaryKeys()
    if (ids.length > 0) {
      const refs = await db.messageMediaRefs.where("messageId").anyOf(ids as string[]).toArray()
      for (const ref of refs) orphanCandidates.add(ref.hash)
      await db.messages.bulkDelete(ids as string[])
      await db.messageMediaRefs.where("messageId").anyOf(ids as string[]).delete()
      revision = await bumpTranscriptRevision(db, sessionId)
    }
  })
  // The on-disk row set changed out-of-band from `persistMessages`; drop the
  // cache so the next persist re-derives existence/createdAt from Dexie.
  invalidatePersistSnapshot(sessionId)
  markSessionDirty(sessionId)
  if (orphanCandidates.size > 0) {
    await collectUnreferencedMessageMedia(orphanCandidates)
  }
  if (revision !== null) await publishTranscriptRevision(sessionId, revision)
}
