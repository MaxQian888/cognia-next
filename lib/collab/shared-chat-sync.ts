import type {
  AuthorRef,
  ChatSession,
  SessionEvent,
  SessionMembership,
  SharedSession,
  StoredMessage,
} from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import {
  appendCollabChatEvents,
  purgeCollabChatSession,
  putCollabChatSyncState,
  replaceCollabChatMembers,
  replaceCollabChatSessions,
} from "@/lib/db/collab-chat-mirror"
import type { PlatformWebSocket } from "@/lib/network/platform-websocket"
import { CollabError, type CollabClient } from "./client"
import { assertSharedChatClientEnabled } from "./shared-chat-feature"

type SharedChatReader = Pick<
  CollabClient,
  "getSharedSession" | "listSessionMembers" | "listSessionEvents"
>

type SharedChatRealtimeClient = SharedChatReader & Pick<CollabClient, "openSessionStream">

export interface SharedChatSyncResult {
  session: SharedSession
  members: SessionMembership[]
  events: SessionEvent[]
  localSessionId: string
  cursor: number
}

function projectedSessionId(sharedSessionId: string): string {
  return `shared:${sharedSessionId}`
}

async function findLocalProjection(sharedSessionId: string): Promise<ChatSession | undefined> {
  return getDb()
    .sessions.filter((row) => row.collaboration?.sessionId === sharedSessionId)
    .first()
}

function eventPayload(event: SessionEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" ? event.payload : {}
}

function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function payloadParts(payload: Record<string, unknown>): StoredMessage["parts"] | undefined {
  return Array.isArray(payload.parts) ? (payload.parts as StoredMessage["parts"]) : undefined
}

function payloadRole(payload: Record<string, unknown>): StoredMessage["role"] | undefined {
  const role = payload.role
  return role === "user" || role === "assistant" || role === "system" ? role : undefined
}

function payloadCreatedAt(payload: Record<string, unknown>, fallback: number): number {
  const value = payload.createdAt
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

/** Author kinds that name a PERSON, and can therefore be impersonated. */
const HUMAN_AUTHOR_KINDS: AuthorRef["kind"][] = ["human", "guest"]
const AUTHOR_KINDS: AuthorRef["kind"][] = [
  ...HUMAN_AUTHOR_KINDS,
  "agent",
  "app",
  "connector",
  "system",
]

/**
 * Resolve a projected message's author, with `event.actor` — the only value the
 * server authenticated — as the authority.
 *
 * The payload carries an author at all so an IMPORTED transcript keeps its
 * shape: an assistant turn must project as `kind: "agent"`, not as the human
 * who ran the import. Those kinds name no person, so honouring them cannot
 * impersonate anyone, and `event.actor` still records who submitted the event.
 *
 * A payload that claims a HUMAN identity is only honoured when it names the
 * authenticated actor. Without that check any member could append an event
 * whose payload said `{kind: "human", id: "<another member's userId>"}` and
 * have every other member's mirror render the message as authored by them.
 */
function payloadAuthor(payload: Record<string, unknown>, actor: AuthorRef): AuthorRef {
  const value = payload.author
  if (!value || typeof value !== "object") return actor
  const candidate = value as Partial<AuthorRef>
  if (typeof candidate.id !== "string" || !AUTHOR_KINDS.includes(candidate.kind as never)) {
    return actor
  }
  const claimed = candidate as AuthorRef
  if (HUMAN_AUTHOR_KINDS.includes(claimed.kind) && claimed.id !== actor.id) return actor
  return claimed
}

async function ensureLocalProjection(remote: SharedSession): Promise<ChatSession> {
  const existing = await findLocalProjection(remote.id)
  if (existing) {
    await getDb().sessions.update(existing.id, {
      title: remote.title,
      projectId: remote.workspaceId,
      collaboration: {
        ...existing.collaboration!,
        policyRevision: remote.policyRevision,
      },
      updatedAt: remote.updatedAt,
    })
    return (await getDb().sessions.get(existing.id))!
  }

  const row: ChatSession = {
    id: projectedSessionId(remote.id),
    projectId: remote.workspaceId,
    title: remote.title,
    kind: "direct",
    createdAt: remote.createdAt,
    updatedAt: remote.updatedAt,
    collaboration: {
      orgId: remote.orgId,
      workspaceId: remote.workspaceId,
      sessionId: remote.id,
      policyRevision: remote.policyRevision,
      syncCursor: 0,
    },
  }
  await getDb().sessions.put(row)
  return row
}

async function projectEvents(
  localSession: ChatSession,
  remote: SharedSession,
  events: readonly SessionEvent[]
): Promise<number> {
  const db = getDb()
  let cursor = localSession.collaboration?.syncCursor ?? 0

  await db.transaction("rw", db.sessions, db.messages, async () => {
    for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
      if (event.sequence <= cursor) continue
      const payload = eventPayload(event)

      if (event.kind === "message.created") {
        const messageId = payloadString(payload, "messageId") ?? event.id
        const role = payloadRole(payload)
        const parts = payloadParts(payload)
        if (role && parts) {
          const author = payloadAuthor(payload, event.actor)
          const existing = await db.messages.get(messageId)
          if ((existing?.collaboration?.eventSequence ?? 0) < event.sequence) {
            await db.messages.put({
              id: messageId,
              sessionId: localSession.id,
              projectId: remote.workspaceId,
              role,
              parts,
              senderId: author.id,
              senderKind:
                role === "assistant" ? "assistant" : role === "system" ? "system" : "user",
              createdAt: existing?.createdAt ?? payloadCreatedAt(payload, event.createdAt),
              collaboration: {
                author,
                sourceEventId: event.id,
                eventSequence: event.sequence,
                version: existing?.collaboration?.version ?? 1,
              },
            })
          }
        }
      } else if (event.kind === "message.corrected") {
        const targetId = payloadString(payload, "targetMessageId")
        const parts = payloadParts(payload)
        const target = targetId ? await db.messages.get(targetId) : undefined
        if (target && parts && (target.collaboration?.eventSequence ?? 0) < event.sequence) {
          await db.messages.update(target.id, {
            parts,
            collaboration: {
              author: target.collaboration?.author ?? event.actor,
              sourceEventId: event.id,
              eventSequence: event.sequence,
              version: (target.collaboration?.version ?? 1) + 1,
            },
          })
        }
      } else if (event.kind === "message.redacted") {
        const targetId = payloadString(payload, "targetMessageId")
        const target = targetId ? await db.messages.get(targetId) : undefined
        if (target && (target.collaboration?.eventSequence ?? 0) < event.sequence) {
          await db.messages.update(target.id, {
            parts: [],
            collaboration: {
              author: target.collaboration?.author ?? event.actor,
              sourceEventId: event.id,
              eventSequence: event.sequence,
              version: (target.collaboration?.version ?? 1) + 1,
              redactedAt: event.createdAt,
              redactedBy: event.actor,
            },
          })
        }
      }
      cursor = Math.max(cursor, event.sequence)
    }

    await db.sessions.update(localSession.id, {
      collaboration: {
        orgId: remote.orgId,
        workspaceId: remote.workspaceId,
        sessionId: remote.id,
        policyRevision: remote.policyRevision,
        syncCursor: cursor,
      },
      updatedAt: Math.max(remote.updatedAt, Date.now()),
    })
  })
  return cursor
}

async function purgeLocalProjection(sharedSessionId: string): Promise<void> {
  const db = getDb()
  const local = await findLocalProjection(sharedSessionId)
  if (!local) return
  await db.transaction("rw", db.sessions, db.messages, db.messageMediaRefs, async () => {
    const messageIds = await db.messages.where("sessionId").equals(local.id).primaryKeys()
    if (messageIds.length > 0) {
      await db.messageMediaRefs
        .where("messageId")
        .anyOf(messageIds as string[])
        .delete()
      await db.messages.bulkDelete(messageIds as string[])
    }
    await db.sessions.delete(local.id)
  })
}

export async function purgeRevokedSharedSession(sharedSessionId: string): Promise<void> {
  await Promise.all([
    purgeCollabChatSession(sharedSessionId),
    purgeLocalProjection(sharedSessionId),
  ])
}

export async function listAndCacheSharedSessions(
  client: Pick<CollabClient, "listSharedSessions">,
  orgId: string,
  workspaceId: string
): Promise<SharedSession[]> {
  assertSharedChatClientEnabled()
  const sessions = await client.listSharedSessions(orgId, workspaceId)
  const fetchedAt = Date.now()
  await replaceCollabChatSessions(
    orgId,
    workspaceId,
    sessions.map((row) => ({ ...row, fetchedAt }))
  )
  return sessions
}

export async function syncSharedSession(
  client: SharedChatReader,
  orgId: string,
  sharedSessionId: string
): Promise<SharedChatSyncResult> {
  assertSharedChatClientEnabled()
  const db = getDb()
  const previous = await db.collabChatSyncStates.get(sharedSessionId)
  try {
    const remote = await client.getSharedSession(orgId, sharedSessionId)
    const [members, events] = await Promise.all([
      client.listSessionMembers(orgId, sharedSessionId),
      client.listSessionEvents(orgId, sharedSessionId, previous?.lastSequence ?? 0),
    ])
    const fetchedAt = Date.now()
    await replaceCollabChatSessions(remote.orgId, remote.workspaceId, [{ ...remote, fetchedAt }])
    await replaceCollabChatMembers(
      remote.orgId,
      remote.id,
      members.map((row) => ({ ...row, orgId: remote.orgId, fetchedAt }))
    )
    await appendCollabChatEvents(
      events.map((event) => ({ ...event, orgId: remote.orgId, fetchedAt }))
    )
    const local = await ensureLocalProjection(remote)
    const cursor = await projectEvents(local, remote, events)
    await putCollabChatSyncState({
      sessionId: remote.id,
      orgId: remote.orgId,
      lastSequence: cursor,
      policyRevision: remote.policyRevision,
      connected: previous?.connected ?? false,
      updatedAt: fetchedAt,
    })
    return { session: remote, members, events, localSessionId: local.id, cursor }
  } catch (error) {
    if (error instanceof CollabError && (error.status === 403 || error.status === 404)) {
      await purgeRevokedSharedSession(sharedSessionId)
    } else {
      await putCollabChatSyncState({
        sessionId: sharedSessionId,
        orgId,
        lastSequence: previous?.lastSequence ?? 0,
        policyRevision: previous?.policyRevision ?? 0,
        connected: false,
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: Date.now(),
      })
    }
    throw error
  }
}

export interface SharedChatStreamController {
  socket: PlatformWebSocket
  close(): void
}

export async function connectSharedSessionStream(
  client: SharedChatRealtimeClient,
  orgId: string,
  sharedSessionId: string
): Promise<SharedChatStreamController> {
  assertSharedChatClientEnabled()
  await syncSharedSession(client, orgId, sharedSessionId)
  let stopped = false
  let serial = Promise.resolve()

  const updateConnection = async (connected: boolean, lastError?: string) => {
    const current = await getDb().collabChatSyncStates.get(sharedSessionId)
    await putCollabChatSyncState({
      sessionId: sharedSessionId,
      orgId,
      lastSequence: current?.lastSequence ?? 0,
      policyRevision: current?.policyRevision ?? 0,
      connected,
      lastError,
      updatedAt: Date.now(),
    })
  }

  // Every write goes through `serial` so the connection flag cannot overtake an
  // event that arrived first. On the native transport the listeners exist
  // before the handshake, so a server that speaks immediately is delivered
  // before `openSessionStream` resolves.
  const socket = await client.openSessionStream(orgId, sharedSessionId, {
    onMessage: (data) => {
      serial = serial
        .then(async () => {
          const event = JSON.parse(data) as SessionEvent
          const state = await getDb().collabChatSyncStates.get(sharedSessionId)
          if (event.sequence !== (state?.lastSequence ?? 0) + 1) {
            await syncSharedSession(client, orgId, sharedSessionId)
            return
          }
          const remote = await client.getSharedSession(orgId, sharedSessionId)
          const local = await ensureLocalProjection(remote)
          await appendCollabChatEvents([{ ...event, orgId, fetchedAt: Date.now() }])
          await projectEvents(local, remote, [event])
        })
        .catch((error: unknown) =>
          updateConnection(false, error instanceof Error ? error.message : String(error))
        )
    },
    onClose: () => {
      if (stopped) return
      serial = serial.then(() => updateConnection(false))
    },
  })

  // The transport resolves on open, which is the event the DOM socket reported.
  if (!stopped) serial = serial.then(() => updateConnection(true))

  return {
    socket,
    close() {
      stopped = true
      void socket.close()
      void updateConnection(false)
    },
  }
}
