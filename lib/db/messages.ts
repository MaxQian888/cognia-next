import type { UIMessage } from "ai"
import type { StoredMessage } from "@cognia/agent-config-types"
import { getDb } from "./schema"
import { resolveScopeProjectId } from "./project-scope"

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

export interface ContentSearchResult {
  /** Session ids with at least one message whose text matched the needle. */
  ids: Set<string>
  /** True when the scan hit `limit` before exhausting the workspace's messages. */
  truncated: boolean
}

/**
 * Opt-in message-content search for the conversation sidebar. Scans up to
 * `limit` messages (optionally scoped to a workspace via `projectId`) and
 * returns the distinct session ids whose text parts contain `needle`
 * (case-insensitive). Bounded by design — an unbounded scan of the whole
 * `messages` store would be expensive — and reports `truncated` so the caller
 * can surface "results may be incomplete" instead of silently dropping matches.
 * `projectId` is matched with `.filter` (not `.where`) so it works without a
 * dedicated index.
 */
export async function searchSessionsByContent(
  needle: string,
  opts: { projectId?: string; limit?: number } = {}
): Promise<ContentSearchResult> {
  const trimmed = needle.trim().toLowerCase()
  const ids = new Set<string>()
  if (!trimmed) return { ids, truncated: false }

  const limit = opts.limit ?? 5000
  const db = getDb()
  const inScope = opts.projectId
    ? (row: StoredMessage) => row.projectId === opts.projectId
    : () => true
  // Read one extra row to detect truncation without a second query.
  const rows = (await db.messages
    .filter(inScope)
    .limit(limit + 1)
    .toArray()) as StoredMessage[]
  const truncated = rows.length > limit
  const scanned = truncated ? rows.slice(0, limit) : rows
  for (const row of scanned) {
    if (ids.has(row.sessionId)) continue
    if (messageText(row.parts).toLowerCase().includes(trimmed)) ids.add(row.sessionId)
  }
  return { ids, truncated }
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
      // trigger badge can read it without threading new props.
      const metadata: Record<string, unknown> = { ...(r.metadata ?? {}) }
      if (r.senderId !== undefined) metadata.senderId = r.senderId
      if (r.senderKind !== undefined) metadata.senderKind = r.senderKind
      metadata.sessionId = r.sessionId
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
export async function persistMessages(sessionId: string, messages: UIMessage[]): Promise<void> {
  const db = getDb()
  const now = Date.now()

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

  await db.transaction("rw", db.messages, async () => {
    // Existing ids for this session — used to compute deletions. `primaryKeys`
    // reads the index only (no row/parts deserialization), so this stays cheap.
    const existingIds = new Set(
      await db.messages.where("sessionId").equals(sessionId).primaryKeys()
    )

    if (messages.length === 0) {
      if (existingIds.size > 0) {
        await db.messages.bulkDelete([...existingIds])
      }
      clearSnapshot = true
      return
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
    if (missingIds.length > 0) {
      const fetched = await db.messages.bulkGet(missingIds)
      for (const r of fetched) {
        if (r) createdAtById.set(r.id, r.createdAt)
      }
    }

    // Only changed/new rows are written; unchanged ones are skipped via
    // ref-equality against the snapshot. `incomingIds` still covers *all*
    // messages so deletion stays computed against the full set.
    const rows: StoredMessage[] = []
    const incomingIds = new Set<string>()
    nextSnapshot = new Map<string, { ref: UIMessage; createdAt: number }>()

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      const id = m.id ?? newId()
      incomingIds.add(id)

      const createdAt = createdAtById.get(id) ?? now + i
      // Record every message in the next snapshot regardless of whether we
      // rewrite its row, so the next persist can skip it.
      nextSnapshot.set(id, { ref: m, createdAt })

      // Remember the trailing message (resolved createdAt = boundary key) for
      // the post-commit preview denormalization below.
      if (i === messages.length - 1) {
        lastPreviewSource = { createdAt, parts: m.parts }
      }

      // Skip rewriting a row whose in-memory reference is unchanged since the
      // last committed persist *and* that still exists on disk. The adapter
      // keeps refs stable for untouched messages, so this is the common case
      // during streaming (only the trailing assistant message mutates).
      const prevEntry = snapshot?.get(id)
      if (prevEntry !== undefined && prevEntry.ref === m && existingIds.has(id)) {
        continue
      }

      // `metadata` may carry usage/cost info plus team-routing fields
      // (senderId/senderKind). The latter are hoisted into top-level columns
      // so we can index by senderId for fast lookups.
      const meta = (m as { metadata?: Record<string, unknown> }).metadata
      const senderId = typeof meta?.senderId === "string" ? meta.senderId : undefined
      const senderKindRaw = meta?.senderKind
      const senderKind =
        senderKindRaw === "user" || senderKindRaw === "assistant" || senderKindRaw === "system"
          ? senderKindRaw
          : undefined
      // Strip the routing keys from metadata so we don't persist them twice.
      let strippedMeta: Record<string, unknown> | undefined = meta
      if (meta && (senderId !== undefined || senderKind !== undefined)) {
        const copy = { ...meta }
        delete copy.senderId
        delete copy.senderKind
        strippedMeta = Object.keys(copy).length > 0 ? copy : undefined
      }
      rows.push({
        id,
        sessionId,
        projectId,
        role: m.role,
        parts: m.parts,
        senderId,
        senderKind,
        metadata: strippedMeta,
        createdAt,
      })
      // Track new user-role messages so we can fan out the chat-message
      // trigger after the write commits.
      if (!existingIds.has(id) && m.role === "user") {
        newUserMessageIds.push(id)
      }
    }

    const toDelete: string[] = []
    for (const id of existingIds) {
      if (!incomingIds.has(id)) toDelete.push(id)
    }

    if (toDelete.length > 0) {
      await db.messages.bulkDelete(toDelete)
    }
    if (rows.length > 0) {
      await db.messages.bulkPut(rows)
    }
  })

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
      await db.sessions.update(sessionId, {
        lastMessagePreview: previewOf(previewSource.parts),
        lastMessageAt: previewSource.createdAt,
      })
    }
  }

  if (newUserMessageIds.length > 0) {
    // Fire-and-forget so persistence is never blocked by the workflow
    // subsystem. Each user-message arrival is its own trigger event so a
    // workflow scoped to the session/character fans out once per message.
    void dispatchChatMessageTriggers(sessionId, newUserMessageIds).catch(() => {
      // Swallow — the trigger fan-out is best-effort and must not surface
      // to the chat send pipeline.
    })
  }
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
  newUserMessageIds: string[]
): Promise<void> {
  // Lazy-load the workflow runtime so messages.ts stays cheap to import
  // from db-only callers. Eager static imports here pull the orchestrator,
  // hooks system and trigger registries into every test that touches the
  // Dexie schema and previously caused 1+ GB worker memory spikes.
  const [{ dispatchTrigger }, { findMatchingWorkflows }, audit] = await Promise.all([
    import("@/lib/workflow/runtime/trigger-bridge"),
    import("@/lib/workflow/runtime/trigger-subscriptions"),
    import("@/lib/chat/trigger-audit-ring"),
  ])

  const session = await getDb().sessions.get(sessionId)
  const characterId = session?.characterId
  const matches = findMatchingWorkflows("trigger.chat.message", {
    characterId,
    sessionId,
  })
  if (matches.length === 0) return

  const originAt = Date.now()
  await Promise.all(
    newUserMessageIds.flatMap((messageId) =>
      matches.map((match) =>
        dispatchTrigger({
          workflowId: match.workflowId,
          kind: "trigger.chat.message",
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
  await getDb().messages.where("sessionId").equals(sessionId).delete()
  invalidatePersistSnapshot(sessionId)
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
  const merged: Record<string, unknown> = { ...(row.metadata ?? {}), ...patch }
  delete merged.senderId
  delete merged.senderKind
  delete merged.sessionId
  await db.messages.update(messageId, {
    metadata: Object.keys(merged).length > 0 ? merged : undefined,
  })
  // The row changed out-of-band from the persist snapshot; drop it so the next
  // `persistMessages` re-derives existence/createdAt from disk.
  invalidatePersistSnapshot(sessionId)
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
  await db.transaction("rw", db.messages, async () => {
    const ids = await db.messages
      .where("[sessionId+createdAt]")
      .between([sessionId, lowerBound], [sessionId, Number.MAX_SAFE_INTEGER])
      .primaryKeys()
    if (ids.length > 0) {
      await db.messages.bulkDelete(ids as string[])
    }
  })
  // The on-disk row set changed out-of-band from `persistMessages`; drop the
  // cache so the next persist re-derives existence/createdAt from Dexie.
  invalidatePersistSnapshot(sessionId)
}
