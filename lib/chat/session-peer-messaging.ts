import type { ChatSession } from "@cognia/agent-config-types"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import type { ChatStatus } from "@/stores/chat/chat-store"
import {
  createSessionPeerMessage,
  enforceSessionInboxCapacity,
  getSessionPeerMessage,
  listSessionInbox,
  listSessionOutbox,
  transitionSessionPeerMessage,
  type CreateSessionPeerMessageInput,
  type SessionPeerMessageRow,
  type SessionPeerMessageStatus,
} from "@/lib/db/session-peer-messages"
import { getSession, listSessions } from "@/lib/db/sessions"

export const SESSION_PEER_DUPLICATE_WINDOW_MS = 30_000
export const SESSION_PEER_RATE_WINDOW_MS = 60_000
export const SESSION_PEER_RATE_LIMIT = 10
export const SESSION_PEER_HELD_CAPACITY = 100
export const SESSION_PEER_ACCEPTED_CAPACITY = 50

export interface SendSessionPeerMessageInput extends Omit<
  CreateSessionPeerMessageInput,
  "id" | "createdAt" | "expiresAt"
> {
  id?: string
  ttlMs?: number
}

export interface SessionPeerMessagingDeps {
  listSessions: () => Promise<ChatSession[]>
  getSession: (id: string) => Promise<ChatSession | undefined>
  isReachable: (sessionId: string) => boolean
  getStatus: (sessionId: string) => ChatStatus
  createMessage: (input: CreateSessionPeerMessageInput) => Promise<SessionPeerMessageRow>
  getMessage: (id: string) => Promise<SessionPeerMessageRow | undefined>
  transitionMessage: (
    id: string,
    status: SessionPeerMessageStatus,
    updatedAt: number,
    statusReason?: string
  ) => Promise<SessionPeerMessageRow>
  listInbox: (receiverSessionId: string) => Promise<SessionPeerMessageRow[]>
  listOutbox: (senderSessionId: string) => Promise<SessionPeerMessageRow[]>
  enforceCapacity: (receiverSessionId: string, capacity: number, now?: number) => Promise<number>
  deliver: (message: SessionPeerMessageRow) => Promise<void>
  gateAgentMessage: (payload: unknown) => boolean
  now: () => number
}

interface SessionPeerRuntimeBinding {
  isReachable: (sessionId: string) => boolean
  getStatus: (sessionId: string) => ChatStatus
  deliver: (message: SessionPeerMessageRow) => Promise<void>
}

const runtimeBindings = new Map<symbol, SessionPeerRuntimeBinding>()

function activeRuntime(): SessionPeerRuntimeBinding | undefined {
  return [...runtimeBindings.values()].at(-1)
}

/** Bind the renderer chat runtime without making the persistence service import React. */
export function registerSessionPeerRuntime(runtime: SessionPeerRuntimeBinding): () => void {
  const token = Symbol("session-peer-runtime")
  runtimeBindings.set(token, runtime)
  return () => void runtimeBindings.delete(token)
}

function defaultDeps(): SessionPeerMessagingDeps {
  return {
    listSessions,
    getSession,
    isReachable: (sessionId) => activeRuntime()?.isReachable(sessionId) ?? false,
    getStatus: (sessionId) => activeRuntime()?.getStatus(sessionId) ?? "idle",
    createMessage: createSessionPeerMessage,
    getMessage: getSessionPeerMessage,
    transitionMessage: transitionSessionPeerMessage,
    listInbox: listSessionInbox,
    listOutbox: listSessionOutbox,
    enforceCapacity: enforceSessionInboxCapacity,
    deliver: async (message) => {
      const runtime = activeRuntime()
      if (!runtime) throw new Error("Session peer runtime is unavailable")
      await runtime.deliver(message)
    },
    gateAgentMessage: hasNoLeakingPiiDeep,
    now: Date.now,
  }
}

function isStandardPeer(session: ChatSession): boolean {
  return (
    session.visibility !== "embedded" &&
    session.kind !== "resource-workbench" &&
    !session.archivedAt
  )
}

export async function listReachableSessions(
  senderSessionId: string,
  deps: SessionPeerMessagingDeps = defaultDeps()
): Promise<ChatSession[]> {
  const sender = await deps.getSession(senderSessionId)
  if (!sender) return []
  return (await deps.listSessions()).filter(
    (candidate) =>
      candidate.id !== senderSessionId &&
      candidate.projectId === sender.projectId &&
      isStandardPeer(candidate) &&
      deps.isReachable(candidate.id)
  )
}

function isBusy(status: ChatStatus): boolean {
  return status === "streaming" || status === "awaiting_approval"
}

async function refuse(
  row: SessionPeerMessageRow,
  reason: string,
  deps: SessionPeerMessagingDeps
): Promise<SessionPeerMessageRow> {
  return deps.transitionMessage(row.id, "refused", deps.now(), reason)
}

async function deliver(
  row: SessionPeerMessageRow,
  deps: SessionPeerMessagingDeps
): Promise<SessionPeerMessageRow> {
  try {
    await deps.deliver(row)
    return deps.transitionMessage(row.id, "delivered", deps.now())
  } catch (error) {
    return deps.transitionMessage(
      row.id,
      "target_unavailable",
      deps.now(),
      error instanceof Error ? error.message : String(error)
    )
  }
}

export async function sendSessionPeerMessage(
  input: SendSessionPeerMessageInput,
  deps: SessionPeerMessagingDeps = defaultDeps()
): Promise<SessionPeerMessageRow> {
  const now = deps.now()
  if (
    input.origin === "agent" &&
    !deps.gateAgentMessage({
      receiverSessionId: input.receiverSessionId,
      content: input.content,
    })
  ) {
    throw new Error("Session message blocked by the PII redaction gate")
  }
  const [sender, receiver, prior] = await Promise.all([
    deps.getSession(input.senderSessionId),
    deps.getSession(input.receiverSessionId),
    deps.listOutbox(input.senderSessionId),
  ])
  const row = await deps.createMessage({
    ...input,
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? 5 * 60 * 1000),
  })

  if (!sender || !receiver || !deps.isReachable(input.receiverSessionId)) {
    return deps.transitionMessage(row.id, "target_unavailable", now, "Target session is not live")
  }
  if (sender.projectId !== receiver.projectId) {
    return refuse(row, "Cross-workspace session messaging is not allowed", deps)
  }

  const recent = prior.filter((message) => now - message.createdAt <= SESSION_PEER_RATE_WINDOW_MS)
  const duplicate = recent.some(
    (message) =>
      now - message.createdAt <= SESSION_PEER_DUPLICATE_WINDOW_MS &&
      message.receiverSessionId === row.receiverSessionId &&
      message.content === row.content
  )
  if (duplicate) return refuse(row, "Duplicate message", deps)
  if (recent.length >= SESSION_PEER_RATE_LIMIT) {
    return refuse(row, "Sender rate limit exceeded", deps)
  }

  const policy = receiver.crossSessionInboundPolicy ?? "hold"
  if (policy === "refuse") return refuse(row, "Receiver policy refused the message", deps)
  if (policy === "hold") {
    const held = await deps.transitionMessage(row.id, "held", now, "Awaiting receiver approval")
    await deps.enforceCapacity(receiver.id, SESSION_PEER_HELD_CAPACITY, now)
    return held
  }
  if (isBusy(deps.getStatus(receiver.id))) {
    await deps.enforceCapacity(receiver.id, SESSION_PEER_ACCEPTED_CAPACITY, now)
    return row
  }
  return deliver(row, deps)
}

export async function drainSessionPeerMessages(
  receiverSessionId: string,
  deps: SessionPeerMessagingDeps = defaultDeps()
): Promise<number> {
  if (!deps.isReachable(receiverSessionId) || isBusy(deps.getStatus(receiverSessionId))) return 0
  const receiver = await deps.getSession(receiverSessionId)
  if (!receiver) return 0
  const rows = (await deps.listInbox(receiverSessionId))
    .filter((row) => row.status === "queued")
    .sort((left, right) => left.createdAt - right.createdAt)
  let delivered = 0
  for (const row of rows) {
    if (row.expiresAt <= deps.now()) {
      await deps.transitionMessage(row.id, "expired", deps.now(), "Message expired before delivery")
      continue
    }
    const policy = receiver.crossSessionInboundPolicy ?? "hold"
    if (policy === "refuse") {
      await deps.transitionMessage(
        row.id,
        "refused",
        deps.now(),
        "Receiver policy refused the message"
      )
      continue
    }
    if (policy === "hold") {
      await deps.transitionMessage(row.id, "held", deps.now(), "Awaiting receiver approval")
      continue
    }
    if ((await deliver(row, deps)).status === "delivered") delivered += 1
  }
  return delivered
}

export async function decideHeldSessionPeerMessage(
  messageId: string,
  decision: "accept" | "refuse",
  receiverSessionId: string,
  deps: SessionPeerMessagingDeps = defaultDeps()
): Promise<SessionPeerMessageRow> {
  const row = await deps.getMessage(messageId)
  if (!row) throw new Error(`Session peer message ${messageId} was not found`)
  if (row.status !== "held") throw new Error(`Session peer message ${messageId} is not held`)
  if (row.receiverSessionId !== receiverSessionId) {
    throw new Error(`Session ${receiverSessionId} does not own peer message ${messageId}`)
  }
  if (decision === "refuse") return refuse(row, "Receiver refused the held message", deps)
  const queued = await deps.transitionMessage(row.id, "queued", deps.now())
  if (!deps.isReachable(row.receiverSessionId) || isBusy(deps.getStatus(row.receiverSessionId))) {
    return queued
  }
  return deliver(queued, deps)
}
