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
  sharedChatCacheKey,
} from "@/lib/db/collab-chat-mirror"
import type { PlatformWebSocket } from "@/lib/network/platform-websocket"
import { CollabError, type CollabClient } from "./client"
import { assertSharedChatClientEnabled } from "./shared-chat-feature"
import { resolveSharedAttachmentParts } from "./shared-chat-conversion"
import { normalizeStoredMessageMedia } from "@/lib/chat/media/normalize-message-media"
import { messageMediaRefRows } from "@/lib/db/message-media-refs"

type SharedChatReader = Pick<
  CollabClient,
  "getSharedSession" | "listSessionMembers" | "listSessionEvents"
> & { readonly baseUrl?: string } & Partial<
    Pick<CollabClient, "createSessionAttachmentDownloadTicket" | "downloadSessionAttachment">
  >

type SharedChatRealtimeClient = SharedChatReader & Pick<CollabClient, "openSessionStream">

export interface SharedChatSyncResult {
  session: SharedSession
  members: SessionMembership[]
  events: SessionEvent[]
  localSessionId: string
  cursor: number
}

export interface SharedChatSyncOptions {
  signal?: AbortSignal
}

export { sharedChatCacheKey } from "@/lib/db/collab-chat-mirror"

function assertCurrent(db: ReturnType<typeof getDb>, signal?: AbortSignal): void {
  if (signal?.aborted || getDb() !== db)
    throw new DOMException("Shared sync cancelled", "AbortError")
}

async function findLocalProjection(
  sharedSessionId: string,
  orgId?: string,
  endpoint?: string
): Promise<ChatSession | undefined> {
  return getDb()
    .sessions.filter((row) => {
      const binding = row.collaboration
      return (
        binding?.sessionId === sharedSessionId &&
        (!orgId || binding.orgId === orgId) &&
        (binding.endpoint ?? "") === (endpoint ?? "")
      )
    })
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

async function ensureLocalProjection(
  remote: SharedSession,
  endpoint?: string
): Promise<ChatSession> {
  const existing = await findLocalProjection(remote.id, remote.orgId, endpoint)
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
    id: `shared:${sharedChatCacheKey(remote.orgId, remote.id, endpoint)}`,
    projectId: remote.workspaceId,
    title: remote.title,
    kind: "direct",
    createdAt: remote.createdAt,
    updatedAt: remote.updatedAt,
    collaboration: {
      ...(endpoint ? { endpoint } : {}),
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

  await db.transaction("rw", db.sessions, db.messages, db.messageMediaRefs, async () => {
    const orderedEvents = [...events].sort((a, b) => a.sequence - b.sequence)
    const changesMessages = orderedEvents.some(
      (event) =>
        event.sequence > cursor &&
        (event.kind === "message.created" ||
          event.kind === "message.corrected" ||
          event.kind === "message.redacted")
    )
    const messages = new Map(
      (changesMessages
        ? await db.messages.where("sessionId").equals(localSession.id).toArray()
        : []
      ).map((message) => [message.collaboration?.remoteMessageId ?? message.id, message])
    )
    const changedMessages = new Map<string, StoredMessage>()
    const staleReferenceIds = new Set<string>()
    for (const event of orderedEvents) {
      if (
        event.sessionId !== remote.id ||
        !Number.isSafeInteger(event.sequence) ||
        event.sequence < 1
      ) {
        throw new Error("Invalid shared session event scope or sequence")
      }
      if (event.sequence <= cursor) continue
      if (event.sequence !== cursor + 1) throw new Error("Shared session event sequence gap")
      const payload = eventPayload(event)

      if (event.kind === "message.created") {
        const remoteMessageId = payloadString(payload, "messageId") ?? event.id
        const prior = messages.get(remoteMessageId)
        const messageId =
          prior?.id ?? `${localSession.id}:message:${JSON.stringify(remoteMessageId)}`
        const role = payloadRole(payload)
        const parts = payloadParts(payload)
        if (role && parts) {
          const author = payloadAuthor(payload, event.actor)
          const existing = prior
          if ((existing?.collaboration?.eventSequence ?? 0) < event.sequence) {
            const projected: StoredMessage = {
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
                remoteMessageId,
                author,
                sourceEventId: event.id,
                eventSequence: event.sequence,
                version: existing?.collaboration?.version ?? 1,
              },
            }
            await db.messages.put(projected)
            messages.set(remoteMessageId, projected)
            changedMessages.set(projected.id, projected)
            if (existing) staleReferenceIds.add(projected.id)
          }
        }
      } else if (event.kind === "message.corrected") {
        const targetId = payloadString(payload, "targetMessageId")
        const parts = payloadParts(payload)
        const target = targetId ? messages.get(targetId) : undefined
        if (target && parts && (target.collaboration?.eventSequence ?? 0) < event.sequence) {
          const projected: StoredMessage = {
            ...target,
            parts,
            collaboration: {
              remoteMessageId: target.collaboration?.remoteMessageId ?? targetId,
              author: target.collaboration?.author ?? event.actor,
              sourceEventId: event.id,
              eventSequence: event.sequence,
              version: (target.collaboration?.version ?? 1) + 1,
            },
          }
          await db.messages.put(projected)
          messages.set(targetId!, projected)
          changedMessages.set(projected.id, projected)
          staleReferenceIds.add(projected.id)
        }
      } else if (event.kind === "message.redacted") {
        const targetId = payloadString(payload, "targetMessageId")
        const target = targetId ? messages.get(targetId) : undefined
        if (target && (target.collaboration?.eventSequence ?? 0) < event.sequence) {
          const projected: StoredMessage = {
            ...target,
            parts: [],
            collaboration: {
              remoteMessageId: target.collaboration?.remoteMessageId ?? targetId,
              author: target.collaboration?.author ?? event.actor,
              sourceEventId: event.id,
              eventSequence: event.sequence,
              version: (target.collaboration?.version ?? 1) + 1,
              redactedAt: event.createdAt,
              redactedBy: event.actor,
            },
          }
          await db.messages.put(projected)
          messages.set(targetId!, projected)
          changedMessages.set(projected.id, projected)
          staleReferenceIds.add(projected.id)
        }
      }
      cursor = Math.max(cursor, event.sequence)
    }

    await db.sessions.update(localSession.id, {
      collaboration: {
        ...(localSession.collaboration?.endpoint
          ? { endpoint: localSession.collaboration.endpoint }
          : {}),
        orgId: remote.orgId,
        workspaceId: remote.workspaceId,
        sessionId: remote.id,
        policyRevision: remote.policyRevision,
        syncCursor: cursor,
      },
      updatedAt: events.reduce((at, event) => Math.max(at, event.createdAt), remote.updatedAt),
    })
    for (const messageId of staleReferenceIds) {
      await db.messageMediaRefs
        .where("messageId")
        .equals(messageId)
        .and((reference) => reference.sessionId === localSession.id)
        .delete()
    }
    const references = [...changedMessages.values()].flatMap((message) =>
      messageMediaRefRows(message.id, localSession.id, message.parts)
    )
    if (references.length) await db.messageMediaRefs.bulkPut(references)
  })
  return cursor
}

async function purgeLocalProjection(
  sharedSessionId: string,
  orgId?: string,
  endpoint?: string
): Promise<void> {
  const db = getDb()
  const local = await findLocalProjection(sharedSessionId, orgId, endpoint)
  if (!local) return
  const messageIds = await db.messages.where("sessionId").equals(local.id).primaryKeys()
  if (messageIds.length) {
    await db.messageMediaRefs
      .where("messageId")
      .anyOf(messageIds as string[])
      .delete()
    await db.messages.bulkDelete(messageIds as string[])
  }
  await db.sessions.delete(local.id)
}

export async function purgeRevokedSharedSession(
  sharedSessionId: string,
  orgId?: string,
  endpoint?: string
): Promise<void> {
  const db = getDb()
  await db.transaction(
    "rw",
    [
      db.sessions,
      db.messages,
      db.messageMediaRefs,
      db.collabChatSessions,
      db.collabChatMemberships,
      db.collabChatEvents,
      db.collabChatInvites,
      db.collabChatApprovals,
      db.collabChatSyncStates,
      db.collabChatAttachments,
    ],
    async () => {
      await purgeCollabChatSession(sharedChatCacheKey(orgId ?? "", sharedSessionId, endpoint))
      await purgeLocalProjection(sharedSessionId, orgId, endpoint)
    }
  )
}

export async function listAndCacheSharedSessions(
  client: Pick<CollabClient, "listSharedSessions"> & { readonly baseUrl?: string },
  orgId: string,
  workspaceId: string,
  options: SharedChatSyncOptions = {}
): Promise<SharedSession[]> {
  assertSharedChatClientEnabled()
  const db = getDb()
  const sessions = await client.listSharedSessions(orgId, workspaceId)
  assertCurrent(db, options.signal)
  if (sessions.some((row) => row.orgId !== orgId || row.workspaceId !== workspaceId)) {
    throw new Error("Shared session list scope mismatch")
  }
  const fetchedAt = Date.now()
  // Workspace slices from distinct endpoints must not replace each other.
  const scopeOrg = client.baseUrl ? sharedChatCacheKey(orgId, "", client.baseUrl) : orgId
  await replaceCollabChatSessions(
    scopeOrg,
    workspaceId,
    sessions.map((row) => ({
      ...row,
      id: sharedChatCacheKey(orgId, row.id, client.baseUrl),
      orgId: scopeOrg,
      fetchedAt,
    }))
  )
  const visible = new Set(sessions.map((session) => session.id))
  const projections = await db.sessions
    .filter((row) => {
      const binding = row.collaboration
      return (
        binding?.orgId === orgId &&
        binding.workspaceId === workspaceId &&
        (binding.endpoint ?? "") === (client.baseUrl ?? "") &&
        !visible.has(binding.sessionId)
      )
    })
    .toArray()
  for (const projection of projections) {
    assertCurrent(db, options.signal)
    await purgeRevokedSharedSession(projection.collaboration!.sessionId, orgId, client.baseUrl)
  }
  return sessions
}

const synchronizations = new Map<string, Promise<SharedChatSyncResult>>()

export function syncSharedSession(
  client: SharedChatReader,
  orgId: string,
  sharedSessionId: string,
  options: SharedChatSyncOptions = {}
): Promise<SharedChatSyncResult> {
  const db = getDb()
  const key = `${db.name}:${sharedChatCacheKey(orgId, sharedSessionId, client.baseUrl)}`
  const previous = synchronizations.get(key)
  const next = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => {
    assertCurrent(db, options.signal)
    return synchronize(client, orgId, sharedSessionId, options)
  })
  synchronizations.set(key, next)
  void next
    .finally(() => {
      if (synchronizations.get(key) === next) synchronizations.delete(key)
    })
    .catch(() => undefined)
  return next
}

async function synchronize(
  client: SharedChatReader,
  orgId: string,
  sharedSessionId: string,
  options: SharedChatSyncOptions
): Promise<SharedChatSyncResult> {
  assertSharedChatClientEnabled()
  const db = getDb()
  const endpoint = client.baseUrl
  const key = sharedChatCacheKey(orgId, sharedSessionId, endpoint)
  const previous = await db.collabChatSyncStates.get(key)
  // The projection is the authority for the applied cursor, including recovery
  // from older versions that advanced the event cache before projecting it.
  const projection = await findLocalProjection(sharedSessionId, orgId, endpoint)
  const applied = projection?.collaboration?.syncCursor ?? 0
  try {
    const remote = await client.getSharedSession(orgId, sharedSessionId)
    if (remote.id !== sharedSessionId || remote.orgId !== orgId)
      throw new Error("Shared session scope mismatch")
    const [members, events] = await Promise.all([
      client.listSessionMembers(orgId, sharedSessionId),
      client.listSessionEvents(orgId, sharedSessionId, applied),
    ])
    // The service returns at most 200 events by default. Drain every page;
    // opening a stream is not proof that historical events were delivered.
    let page = events
    for (let count = 1; page.length === 200; count++) {
      assertCurrent(db, options.signal)
      if (count >= 10_000) throw new Error("Shared session history page limit exceeded")
      const after = page.at(-1)!.sequence
      page = await client.listSessionEvents(orgId, sharedSessionId, after)
      if (page.length && page[0].sequence <= after)
        throw new Error("Shared session history cursor did not advance")
      events.push(...page)
    }
    assertCurrent(db, options.signal)
    if (members.some((member) => member.sessionId !== sharedSessionId))
      throw new Error("Shared member scope mismatch")
    const projectedEvents: SessionEvent[] = []
    for (const event of events) {
      const parts = payloadParts(eventPayload(event))
      if (
        !parts?.some(
          (part) =>
            part.type === "file" &&
            typeof part.url === "string" &&
            part.url.startsWith("cognia://shared-attachment/")
        )
      ) {
        projectedEvents.push(event)
        continue
      }
      if (!client.createSessionAttachmentDownloadTicket || !client.downloadSessionAttachment) {
        throw new Error("Shared attachment download is unavailable")
      }
      assertCurrent(db, options.signal)
      const resolved = await resolveSharedAttachmentParts(
        client as CollabClient,
        orgId,
        sharedSessionId,
        parts
      )
      assertCurrent(db, options.signal)
      const normalized = await normalizeStoredMessageMedia({
        id: event.id,
        sessionId: sharedSessionId,
        role: payloadRole(eventPayload(event)) ?? "assistant",
        parts: resolved,
        createdAt: event.createdAt,
      })
      projectedEvents.push({ ...event, payload: { ...event.payload, parts: normalized.parts } })
    }
    const fetchedAt = Date.now()
    const result = await db.transaction(
      "rw",
      [
        db.sessions,
        db.messages,
        db.messageMediaRefs,
        db.collabChatSessions,
        db.collabChatMemberships,
        db.collabChatEvents,
        db.collabChatSyncStates,
      ],
      async () => {
        assertCurrent(db, options.signal)
        await db.collabChatSessions.put({
          ...remote,
          id: key,
          orgId: endpoint ? sharedChatCacheKey(orgId, "", endpoint) : orgId,
          fetchedAt,
        })
        await replaceCollabChatMembers(
          orgId,
          key,
          members.map((row) => ({ ...row, sessionId: key, orgId, fetchedAt }))
        )
        await appendCollabChatEvents(
          events.map((event) => ({
            ...event,
            id: `${key}:event:${event.id}`,
            sessionId: key,
            orgId,
            fetchedAt,
          }))
        )
        const local = await ensureLocalProjection(remote, endpoint)
        const cursor = await projectEvents(local, remote, projectedEvents)
        await putCollabChatSyncState({
          sessionId: key,
          orgId,
          lastSequence: cursor,
          policyRevision: remote.policyRevision,
          // The socket may have connected while the network pull was pending.
          connected: (await db.collabChatSyncStates.get(key))?.connected ?? false,
          updatedAt: fetchedAt,
        })
        assertCurrent(db, options.signal)
        return { session: remote, members, events, localSessionId: local.id, cursor }
      }
    )
    if (
      typeof window !== "undefined" &&
      events.some(
        (event) =>
          event.sequence > applied &&
          (event.kind === "run.queued" || event.kind === "run.completed")
      )
    ) {
      window.dispatchEvent(
        new CustomEvent("cognia:shared-queue-updated", {
          detail: { sessionId: result.localSessionId },
        })
      )
    }
    return result
  } catch (error) {
    assertCurrent(db, options.signal)
    if (error instanceof CollabError && (error.status === 403 || error.status === 404)) {
      await purgeRevokedSharedSession(sharedSessionId, orgId, endpoint)
    } else {
      await putCollabChatSyncState({
        sessionId: key,
        orgId,
        lastSequence: applied,
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
  readonly socket: PlatformWebSocket | null
  close(): void
}

export async function connectSharedSessionStream(
  client: SharedChatRealtimeClient,
  orgId: string,
  sharedSessionId: string,
  options: SharedChatSyncOptions = {}
): Promise<SharedChatStreamController> {
  assertSharedChatClientEnabled()
  const db = getDb()
  const key = sharedChatCacheKey(orgId, sharedSessionId, client.baseUrl)
  let stopped = false
  let socket: PlatformWebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let attempt = 0
  let connecting = false
  let generation = 0
  let refreshing = false
  let refreshRequested = false
  const abort = new AbortController()
  const syncOptions = { signal: abort.signal }

  const updateConnection = async (connected: boolean, lastError?: string) => {
    if (getDb() !== db) return
    // Update only connection fields atomically: a stale read/put could roll back
    // a concurrently committed cursor or recreate a revoked session's state.
    await db.collabChatSyncStates.update(key, { connected, lastError, updatedAt: Date.now() })
  }
  const schedule = () => {
    if (stopped || timer !== undefined) return
    const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt++, 6)) * (0.8 + Math.random() * 0.4)
    timer = setTimeout(() => {
      timer = undefined
      void connect()
    }, delay)
  }
  const fail = async (error: unknown) => {
    if (stopped) return
    if (error instanceof CollabError && [401, 403, 404].includes(error.status)) {
      close()
      if (error.status === 403 || error.status === 404) {
        assertCurrent(db, options.signal)
        await purgeRevokedSharedSession(sharedSessionId, orgId, client.baseUrl)
      }
      return
    }
    if (socket) {
      ++generation
      void socket.close()
      socket = null
    }
    await updateConnection(false, error instanceof Error ? error.message : String(error))
    schedule()
  }
  const refresh = () => {
    if (stopped) return
    refreshRequested = true
    if (refreshing || connecting) return
    refreshing = true
    void (async () => {
      try {
        // Notifications invalidate a cursor; they are not individual work items.
        // A pulse during a pull requires one trailing pull, never an unbounded queue.
        while (refreshRequested && !stopped && socket) {
          refreshRequested = false
          await syncSharedSession(client, orgId, sharedSessionId, syncOptions)
        }
      } catch (error) {
        refreshRequested = false
        await fail(error)
      } finally {
        refreshing = false
      }
    })()
  }
  const connect = async () => {
    if (stopped || connecting) return
    connecting = true
    const currentGeneration = ++generation
    try {
      await syncSharedSession(client, orgId, sharedSessionId, syncOptions)
      if (stopped) return
      let closedDuringOpen = false
      const opened = await client.openSessionStream(orgId, sharedSessionId, {
        onMessage: () => {
          if (currentGeneration === generation) refresh()
        },
        onClose: () => {
          if (stopped || currentGeneration !== generation) return
          closedDuringOpen = true
          socket = null
          void updateConnection(false)
          schedule()
        },
      })
      if (stopped || closedDuringOpen || currentGeneration !== generation) {
        void opened.close()
        return
      }
      socket = opened
      // An event can commit after the first pull and before subscription.
      await syncSharedSession(client, orgId, sharedSessionId, syncOptions)
      if (stopped || closedDuringOpen || currentGeneration !== generation || socket !== opened)
        return
      attempt = 0
      await updateConnection(true)
    } catch (error) {
      if (socket) {
        ++generation
        void socket.close()
        socket = null
      }
      await fail(error)
    } finally {
      connecting = false
      if (socket && refreshRequested) refresh()
      // A retry timer can fire while the old catch-up still holds this guard.
      if (!stopped && !socket && timer === undefined) schedule()
    }
  }
  const recover = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (socket) refresh()
    else void connect()
  }
  function close() {
    if (stopped) return
    stopped = true
    refreshRequested = false
    abort.abort()
    ++generation
    if (timer !== undefined) clearTimeout(timer)
    void socket?.close()
    socket = null
    options.signal?.removeEventListener("abort", close)
    if (typeof window !== "undefined") window.removeEventListener("online", recover)
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", recover)
    void updateConnection(false)
  }
  options.signal?.addEventListener("abort", close, { once: true })
  if (options.signal?.aborted) close()
  if (!stopped) {
    if (typeof window !== "undefined") window.addEventListener("online", recover)
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", recover)
    await connect()
  }
  return {
    get socket() {
      return socket
    },
    close,
  }
}
