import { getDb, withDbReopenRetry } from "./schema"

export const SESSION_PEER_MESSAGE_AUTHORITY = "untrusted_agent_message" as const
export const DEFAULT_SESSION_PEER_MESSAGE_TTL_MS = 5 * 60 * 1000

export type SessionPeerMessageIntent = "note" | "trigger_turn"
export type SessionPeerMessageOrigin = "agent" | "user"
export type SessionPeerMessageStatus =
  "queued" | "held" | "delivered" | "refused" | "expired" | "target_unavailable"

export interface SessionPeerMessageRow {
  id: string
  senderSessionId: string
  receiverSessionId: string
  content: string
  intent: SessionPeerMessageIntent
  origin: SessionPeerMessageOrigin
  authority: typeof SESSION_PEER_MESSAGE_AUTHORITY
  status: SessionPeerMessageStatus
  createdAt: number
  updatedAt: number
  expiresAt: number
  deliveredAt?: number
  decidedAt?: number
  statusReason?: string
}

export interface CreateSessionPeerMessageInput {
  id?: string
  senderSessionId: string
  receiverSessionId: string
  content: string
  intent: SessionPeerMessageIntent
  origin: SessionPeerMessageOrigin
  createdAt?: number
  expiresAt?: number
}

const TERMINAL_STATUSES = new Set<SessionPeerMessageStatus>([
  "delivered",
  "refused",
  "expired",
  "target_unavailable",
])

const ALLOWED_TRANSITIONS: Record<
  SessionPeerMessageStatus,
  ReadonlySet<SessionPeerMessageStatus>
> = {
  queued: new Set(["held", "delivered", "refused", "expired", "target_unavailable"]),
  held: new Set(["queued", "delivered", "refused", "expired", "target_unavailable"]),
  delivered: new Set(),
  refused: new Set(),
  expired: new Set(),
  target_unavailable: new Set(),
}

function messageId(now: number): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `session-peer-${now}-${Math.random().toString(36).slice(2, 10)}`
  }
}

export async function createSessionPeerMessage(
  input: CreateSessionPeerMessageInput
): Promise<SessionPeerMessageRow> {
  const senderSessionId = input.senderSessionId.trim()
  const receiverSessionId = input.receiverSessionId.trim()
  const content = input.content.trim()
  if (!senderSessionId) throw new Error("A sender session is required")
  if (!receiverSessionId) throw new Error("A receiver session is required")
  if (senderSessionId === receiverSessionId) throw new Error("A session cannot message itself")
  if (!content) throw new Error("A session peer message cannot be empty")

  const createdAt = input.createdAt ?? Date.now()
  const expiresAt = input.expiresAt ?? createdAt + DEFAULT_SESSION_PEER_MESSAGE_TTL_MS
  if (!Number.isFinite(expiresAt) || expiresAt <= createdAt) {
    throw new Error("A session peer message must expire after it is created")
  }

  const row: SessionPeerMessageRow = {
    id: input.id ?? messageId(createdAt),
    senderSessionId,
    receiverSessionId,
    content,
    intent: input.intent,
    origin: input.origin,
    authority: SESSION_PEER_MESSAGE_AUTHORITY,
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    expiresAt,
  }
  await withDbReopenRetry(() => getDb().sessionPeerMessages.add(row))
  return row
}

export async function getSessionPeerMessage(
  id: string
): Promise<SessionPeerMessageRow | undefined> {
  return withDbReopenRetry(() => getDb().sessionPeerMessages.get(id))
}

async function listBySession(
  index: "receiverSessionId" | "senderSessionId",
  sessionId: string,
  limit: number
): Promise<SessionPeerMessageRow[]> {
  if (limit <= 0) return []
  return withDbReopenRetry(() =>
    getDb()
      .sessionPeerMessages.where(index)
      .equals(sessionId)
      .sortBy("createdAt")
      .then((rows) => rows.reverse().slice(0, limit))
  )
}

export function listSessionInbox(
  receiverSessionId: string,
  limit = 100
): Promise<SessionPeerMessageRow[]> {
  return listBySession("receiverSessionId", receiverSessionId, limit)
}

export function listSessionOutbox(
  senderSessionId: string,
  limit = 100
): Promise<SessionPeerMessageRow[]> {
  return listBySession("senderSessionId", senderSessionId, limit)
}

export async function transitionSessionPeerMessage(
  id: string,
  status: SessionPeerMessageStatus,
  updatedAt = Date.now(),
  statusReason?: string
): Promise<SessionPeerMessageRow> {
  return withDbReopenRetry(async () => {
    const db = getDb()
    return db.transaction("rw", db.sessionPeerMessages, async () => {
      const current = await db.sessionPeerMessages.get(id)
      if (!current) throw new Error(`Session peer message ${id} was not found`)
      if (current.status === status) return current
      if (!ALLOWED_TRANSITIONS[current.status].has(status)) {
        throw new Error(
          `Cannot transition session peer message ${id} from ${current.status} to ${status}`
        )
      }
      const patch: Partial<SessionPeerMessageRow> = {
        status,
        updatedAt,
        ...(statusReason ? { statusReason } : {}),
        ...(status === "delivered" ? { deliveredAt: updatedAt } : {}),
        ...(status === "held" || status === "refused" ? { decidedAt: updatedAt } : {}),
      }
      await db.sessionPeerMessages.update(id, patch)
      return { ...current, ...patch }
    })
  })
}

export async function expireSessionPeerMessages(now = Date.now()): Promise<number> {
  return withDbReopenRetry(async () => {
    const db = getDb()
    let changed = 0
    await db.transaction("rw", db.sessionPeerMessages, async () => {
      await db.sessionPeerMessages
        .where("expiresAt")
        .belowOrEqual(now)
        .modify((row) => {
          if (TERMINAL_STATUSES.has(row.status)) return
          row.status = "expired"
          row.updatedAt = now
          row.statusReason = "Message expired before delivery"
          changed += 1
        })
    })
    return changed
  })
}

export async function listPendingSessionInbox(
  receiverSessionId: string
): Promise<SessionPeerMessageRow[]> {
  const db = getDb()
  const rows = await withDbReopenRetry(() =>
    db.sessionPeerMessages
      .where("[receiverSessionId+status]")
      .anyOf([
        [receiverSessionId, "queued"],
        [receiverSessionId, "held"],
      ])
      .toArray()
  )
  return rows.sort((a, b) => a.createdAt - b.createdAt)
}

export async function enforceSessionInboxCapacity(
  receiverSessionId: string,
  capacity: number,
  now = Date.now()
): Promise<number> {
  if (capacity < 0 || !Number.isInteger(capacity)) {
    throw new Error("Session inbox capacity must be a non-negative integer")
  }
  const pending = await listPendingSessionInbox(receiverSessionId)
  const overflow = pending.slice(0, Math.max(0, pending.length - capacity))
  for (const row of overflow) {
    await transitionSessionPeerMessage(row.id, "expired", now, "Receiver inbox capacity exceeded")
  }
  return overflow.length
}
