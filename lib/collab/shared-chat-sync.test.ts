import type { SessionEvent, SharedSession } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { CollabError } from "./client"
import {
  connectSharedSessionStream,
  listAndCacheSharedSessions,
  syncSharedSession,
} from "./shared-chat-sync"
import type { PlatformWebSocketHandlers } from "@/lib/network/platform-websocket"

const dbFixture = createDbTestFixture()

const session: SharedSession = {
  id: "shared_1",
  orgId: "org_1",
  workspaceId: "workspace_1",
  title: "Shared thread",
  status: "active",
  createdBy: { kind: "human", id: "user_1" },
  createdAt: 1,
  updatedAt: 2,
  revision: 1,
  policyRevision: 3,
}

const messageEvent: SessionEvent = {
  id: "event_1",
  sessionId: session.id,
  sequence: 1,
  kind: "message.created",
  actor: { kind: "human", id: "user_1", displayName: "Ada" },
  payload: {
    messageId: "message_1",
    role: "user",
    parts: [{ type: "text", text: "hello" }],
    createdAt: 10,
  },
  createdAt: 10,
  operationId: "operation_1",
}

function readerFor(...events: SessionEvent[]) {
  return {
    getSharedSession: jest.fn().mockResolvedValue(session),
    listSessionMembers: jest.fn().mockResolvedValue([
      {
        sessionId: session.id,
        userId: "user_1",
        role: "owner" as const,
        approver: true,
        guest: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ]),
    listSessionEvents: jest.fn().mockResolvedValue(events),
  }
}

describe("shared chat synchronization", () => {
  beforeAll(dbFixture.initialize)
  beforeEach(async () => {
    await dbFixture.restore()
  })
  afterAll(dbFixture.dispose)

  it("does not delete sibling sessions when refreshing one conversation", async () => {
    await getDb().collabChatSessions.put({ ...session, id: "sibling", fetchedAt: 1 })
    await syncSharedSession(readerFor(messageEvent), session.orgId, session.id)
    expect(await getDb().collabChatSessions.get("sibling")).toBeDefined()
  })

  it("rewrites only the changed message's media references across 10 corrections", async () => {
    const events = Array.from({ length: 20 }, (_, index) => ({
      ...messageEvent,
      id: `media-event-${index}`,
      sequence: index + 1,
      payload: {
        messageId: `media-message-${index}`,
        role: "user",
        parts: [{ type: "file", mediaType: "image/png", url: `cognia-media:hash-${index}` }],
      },
    }))
    await syncSharedSession(readerFor(...events), session.orgId, session.id)
    const put = jest.spyOn(getDb().messageMediaRefs, "bulkPut")
    const writes: number[] = []
    try {
      for (let index = 0; index < 10; index++) {
        put.mockClear()
        await syncSharedSession(
          readerFor({
            ...messageEvent,
            id: `correction-${index}`,
            sequence: 21 + index,
            kind: "message.corrected",
            payload: {
              targetMessageId: "media-message-0",
              parts: [
                { type: "file", mediaType: "image/png", url: `cognia-media:replacement-${index}` },
              ],
            },
          }),
          session.orgId,
          session.id
        )
        writes.push(put.mock.calls.reduce((count, [rows]) => count + rows.length, 0))
        const refs = await getDb().messageMediaRefs.toArray()
        expect(refs).toHaveLength(20)
        expect(refs.some((ref) => ref.hash === `replacement-${index}`)).toBe(true)
        expect(refs.some((ref) => ref.hash === "hash-19")).toBe(true)
      }
      expect(writes).toEqual(Array(10).fill(1))
    } finally {
      put.mockRestore()
    }
    await syncSharedSession(
      readerFor({
        ...messageEvent,
        id: "redaction",
        sequence: 31,
        kind: "message.redacted",
        payload: { targetMessageId: "media-message-0" },
      }),
      session.orgId,
      session.id
    )
    expect(await getDb().messageMediaRefs.count()).toBe(19)
    expect(await getDb().messageMediaRefs.where("hash").equals("replacement-9").count()).toBe(0)
  })

  it("does not scan messages or rewrite media references for metadata-only refreshes", async () => {
    await syncSharedSession(readerFor(messageEvent), session.orgId, session.id)
    const where = jest.spyOn(getDb().messages, "where")
    const put = jest.spyOn(getDb().messageMediaRefs, "bulkPut")
    try {
      for (let index = 0; index < 10; index++) {
        await syncSharedSession(
          readerFor({
            ...messageEvent,
            id: `metadata-${index}`,
            sequence: index + 2,
            kind: "run.queued",
            payload: { queueItemId: `queue-${index}` },
          }),
          session.orgId,
          session.id
        )
      }
      expect(where).not.toHaveBeenCalled()
      expect(put).not.toHaveBeenCalled()
      expect((await getDb().collabChatSyncStates.get(session.id))?.lastSequence).toBe(11)
    } finally {
      where.mockRestore()
      put.mockRestore()
    }
  })

  it("rolls back messages, references and events when replacement references fail to persist", async () => {
    const initial = {
      ...messageEvent,
      payload: {
        ...messageEvent.payload,
        parts: [{ type: "file", mediaType: "image/png", url: "cognia-media:original" }],
      },
    }
    await syncSharedSession(readerFor(initial), session.orgId, session.id)
    const before = await getDb().messages.toArray()
    const refs = await getDb().messageMediaRefs.toArray()
    const correction = {
      ...messageEvent,
      id: "replacement",
      sequence: 2,
      kind: "message.corrected" as const,
      payload: {
        targetMessageId: "message_1",
        parts: [{ type: "file", mediaType: "image/png", url: "cognia-media:replacement" }],
      },
    }
    const put = jest
      .spyOn(getDb().messageMediaRefs, "bulkPut")
      .mockRejectedValueOnce(new Error("storage unavailable"))
    try {
      await expect(
        syncSharedSession(readerFor(correction), session.orgId, session.id)
      ).rejects.toThrow("storage unavailable")
      expect(await getDb().messages.toArray()).toEqual(before)
      expect(await getDb().messageMediaRefs.toArray()).toEqual(refs)
      expect(await getDb().collabChatEvents.count()).toBe(1)
      expect((await getDb().sessions.get("shared:shared_1"))?.collaboration?.syncCursor).toBe(1)
    } finally {
      put.mockRestore()
    }
    await syncSharedSession(readerFor(correction), session.orgId, session.id)
    expect((await getDb().messageMediaRefs.toArray())[0].hash).toBe("replacement")
  })

  it("preserves a connection established while a history pull was in flight", async () => {
    await getDb().collabChatSyncStates.put({
      sessionId: session.id,
      orgId: session.orgId,
      lastSequence: 0,
      policyRevision: 3,
      connected: false,
      updatedAt: 1,
    })
    const reader = readerFor(messageEvent)
    reader.getSharedSession.mockImplementation(async () => {
      await getDb().collabChatSyncStates.update(session.id, { connected: true })
      return session
    })
    await syncSharedSession(reader, session.orgId, session.id)
    expect((await getDb().collabChatSyncStates.get(session.id))?.connected).toBe(true)
  })

  it("notifies the executor only after newly queued events commit", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
    const dispatchEvent = jest.fn()
    Object.defineProperty(globalThis, "window", { configurable: true, value: { dispatchEvent } })
    try {
      const reader = readerFor({
        ...messageEvent,
        kind: "run.queued",
        payload: { queueItemId: "request" },
      })
      const result = await syncSharedSession(reader, session.orgId, session.id)
      expect(dispatchEvent).toHaveBeenCalledTimes(1)
      expect(dispatchEvent.mock.calls[0][0]).toMatchObject({
        type: "cognia:shared-queue-updated",
        detail: { sessionId: result.localSessionId },
      })
      expect((await getDb().sessions.get(result.localSessionId))?.collaboration?.syncCursor).toBe(1)
      await syncSharedSession(reader, session.orgId, session.id)
      expect(dispatchEvent).toHaveBeenCalledTimes(1)
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "window", descriptor)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })

  it("downloads scoped attachments before committing their message projection", async () => {
    const event = {
      ...messageEvent,
      payload: {
        ...messageEvent.payload,
        parts: [{ type: "file", mediaType: "text/plain", url: "cognia://shared-attachment/file" }],
      },
    }
    const client = {
      ...readerFor(event),
      createSessionAttachmentDownloadTicket: jest.fn().mockResolvedValue({
        attachment: {
          id: "file",
          sessionId: session.id,
          status: "available",
          mediaType: "text/plain",
          byteLength: 5,
          sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        },
        ticket: "ticket",
      }),
      downloadSessionAttachment: jest.fn().mockResolvedValue(new Blob(["hello"])),
    }
    await syncSharedSession(client, session.orgId, session.id)
    expect((await getDb().messages.toArray())[0].parts).toEqual([
      { type: "file", mediaType: "text/plain", url: "data:text/plain;base64,aGVsbG8=" },
    ])
  })

  it("does not advance a cursor when an attachment cannot be downloaded", async () => {
    const event = {
      ...messageEvent,
      payload: {
        ...messageEvent.payload,
        parts: [{ type: "file", mediaType: "text/plain", url: "cognia://shared-attachment/file" }],
      },
    }
    await expect(syncSharedSession(readerFor(event), session.orgId, session.id)).rejects.toThrow(
      "download is unavailable"
    )
    expect(await getDb().messages.count()).toBe(0)
  })

  it("replays from the applied projection when the old cache cursor ran ahead", async () => {
    await getDb().collabChatSyncStates.put({
      sessionId: session.id,
      orgId: session.orgId,
      lastSequence: 1,
      policyRevision: 3,
      connected: false,
      updatedAt: 1,
    })
    const client = readerFor(messageEvent)
    await syncSharedSession(client, session.orgId, session.id)
    expect(client.listSessionEvents).toHaveBeenCalledWith(session.orgId, session.id, 0)
  })

  it("does not advance past missing events", async () => {
    await expect(
      syncSharedSession(readerFor({ ...messageEvent, sequence: 2 }), session.orgId, session.id)
    ).rejects.toThrow("sequence gap")
    expect(await getDb().messages.count()).toBe(0)
    expect(await getDb().collabChatEvents.count()).toBe(0)
    expect(await getDb().sessions.count()).toBe(0)
  })

  it("drains paginated history before reporting synchronization complete", async () => {
    const events = Array.from({ length: 201 }, (_, i) => ({
      ...messageEvent,
      id: `event_${i}`,
      sequence: i + 1,
      payload: { ...messageEvent.payload, messageId: `m${i}` },
    }))
    const client = readerFor()
    client.listSessionEvents.mockImplementation(async (_org: string, _id: string, after: number) =>
      events.slice(after, after + 200)
    )
    const result = await syncSharedSession(client, session.orgId, session.id)
    expect(result.cursor).toBe(201)
    expect(await getDb().messages.count()).toBe(201)
  })

  it("rejects a nonadvancing history page without persisting it", async () => {
    const events = Array.from({ length: 200 }, (_, i) => ({
      ...messageEvent,
      id: `e${i}`,
      sequence: i + 1,
    }))
    await expect(
      syncSharedSession(readerFor(...events), session.orgId, session.id)
    ).rejects.toThrow("did not advance")
    expect(await getDb().messages.count()).toBe(0)
  })

  it("ignores duplicate events, applies correction/redaction, and preserves the author", async () => {
    const client = readerFor(messageEvent)
    await syncSharedSession(client, session.orgId, session.id)
    client.listSessionEvents.mockResolvedValue([
      messageEvent,
      {
        ...messageEvent,
        id: "correct",
        sequence: 2,
        kind: "message.corrected",
        payload: { targetMessageId: "message_1", parts: [{ type: "text", text: "updated" }] },
      },
    ])
    await syncSharedSession(client, session.orgId, session.id)
    const corrected = await getDb().messages.where("sessionId").equals("shared:shared_1").first()
    expect(corrected?.parts).toEqual([{ type: "text", text: "updated" }])
    expect(corrected?.collaboration?.version).toBe(2)
    client.listSessionEvents.mockResolvedValue([
      {
        ...messageEvent,
        id: "redact",
        sequence: 3,
        kind: "message.redacted",
        payload: { targetMessageId: "message_1" },
      },
    ])
    await syncSharedSession(client, session.orgId, session.id)
    expect((await getDb().messages.get(corrected!.id))?.parts).toEqual([])
  })

  it("does not apply a response after the caller aborts", async () => {
    const abort = new AbortController()
    const client = readerFor(messageEvent)
    client.listSessionEvents.mockImplementation(async () => {
      abort.abort()
      return [messageEvent]
    })
    await expect(
      syncSharedSession(client, session.orgId, session.id, { signal: abort.signal })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(await getDb().sessions.count()).toBe(0)
  })

  it("checks workspace list scope and isolates endpoint caches", async () => {
    const client = {
      baseUrl: "https://one.example",
      listSharedSessions: jest.fn().mockResolvedValue([session]),
    }
    await listAndCacheSharedSessions(client, session.orgId, session.workspaceId)
    await listAndCacheSharedSessions(
      { ...client, baseUrl: "https://two.example" },
      session.orgId,
      session.workspaceId
    )
    expect(await getDb().collabChatSessions.count()).toBe(2)
    await expect(listAndCacheSharedSessions(client, "wrong", session.workspaceId)).rejects.toThrow(
      "scope mismatch"
    )
  })

  it("purges an inactive conversation removed from the complete authorized list", async () => {
    const client = {
      ...readerFor(messageEvent),
      baseUrl: "https://one.example",
      listSharedSessions: jest.fn().mockResolvedValue([]),
    }
    await syncSharedSession(client, session.orgId, session.id)
    await listAndCacheSharedSessions(client, session.orgId, session.workspaceId)
    expect(await getDb().messages.count()).toBe(0)
    expect(await getDb().sessions.count()).toBe(0)
  })

  it("retains the last applied state when a transient request fails", async () => {
    const client = readerFor(messageEvent)
    await syncSharedSession(client, session.orgId, session.id)
    client.getSharedSession.mockRejectedValue(new Error("offline"))
    await expect(syncSharedSession(client, session.orgId, session.id)).rejects.toThrow("offline")
    expect(await getDb().messages.count()).toBe(1)
    expect(await getDb().collabChatSyncStates.get(session.id)).toMatchObject({
      lastSequence: 1,
      connected: false,
      lastError: "offline",
    })
  })

  it.each([
    { payload: null },
    { payload: { messageId: "", role: "invalid", parts: null } },
    {
      payload: {
        role: "system",
        parts: [],
        createdAt: "invalid",
        author: { id: "system", kind: "system" },
      },
    },
    { payload: { role: "user", parts: [], author: { id: 1, kind: "human" } } },
    { payload: { role: "user", parts: [], author: "invalid" } },
    { payload: { role: "user", parts: [], author: { id: "user_1", kind: "human" } } },
  ])(
    "handles legacy and malformed message payloads without inventing identity: %j",
    async (patch) => {
      const result = await syncSharedSession(
        readerFor({ ...messageEvent, ...patch } as SessionEvent),
        session.orgId,
        session.id
      )
      expect(result.cursor).toBe(1)
    }
  )

  it.each([{ sessionId: "another" }, { sequence: -1 }, { sequence: 1.5 }])(
    "rejects invalid event scope or sequence: %j",
    async (patch) => {
      await expect(
        syncSharedSession(readerFor({ ...messageEvent, ...patch }), session.orgId, session.id)
      ).rejects.toThrow("Invalid shared session event")
    }
  )

  it("rejects a response belonging to another organization", async () => {
    const client = readerFor()
    client.getSharedSession.mockResolvedValue({ ...session, orgId: "other" })
    await expect(syncSharedSession(client, session.orgId, session.id)).rejects.toThrow(
      "scope mismatch"
    )
  })

  it("rejects members returned for another session", async () => {
    const client = readerFor()
    client.listSessionMembers.mockResolvedValue([{ sessionId: "other" }])
    await expect(syncSharedSession(client, session.orgId, session.id)).rejects.toThrow(
      "member scope mismatch"
    )
  })

  it("ignores corrections without a same-session target or valid parts", async () => {
    await syncSharedSession(readerFor(messageEvent), session.orgId, session.id)
    await syncSharedSession(
      readerFor(
        { ...messageEvent, id: "c", sequence: 2, kind: "message.corrected", payload: {} },
        { ...messageEvent, id: "r", sequence: 3, kind: "message.redacted", payload: {} },
        {
          ...messageEvent,
          id: "r2",
          sequence: 4,
          kind: "message.redacted",
          payload: { targetMessageId: "absent" },
        },
        {
          ...messageEvent,
          id: "c2",
          sequence: 5,
          kind: "message.corrected",
          payload: { targetMessageId: "message_1" },
        }
      ),
      session.orgId,
      session.id
    )
    expect(await getDb().messages.count()).toBe(1)
  })

  it("serializes overlapping pulls so stale responses cannot regress the cursor", async () => {
    const client = readerFor(messageEvent)
    const results = await Promise.all([
      syncSharedSession(client, session.orgId, session.id),
      syncSharedSession(client, session.orgId, session.id),
    ])
    expect(results.map((result) => result.cursor)).toEqual([1, 1])
    expect(client.listSessionEvents).toHaveBeenNthCalledWith(2, session.orgId, session.id, 1)
  })

  it("updates legacy local message ids without copying or losing author metadata", async () => {
    await getDb().sessions.put({
      id: "legacy",
      title: "old",
      kind: "direct",
      createdAt: 1,
      updatedAt: 1,
      collaboration: {
        orgId: session.orgId,
        sessionId: session.id,
        workspaceId: session.workspaceId,
        policyRevision: 1,
        syncCursor: 0,
      },
    })
    await getDb().messages.bulkPut([
      { id: "message_1", sessionId: "legacy", role: "user", parts: [], createdAt: 1 },
      { id: "correct-legacy", sessionId: "legacy", role: "user", parts: [], createdAt: 1 },
      { id: "redact-legacy", sessionId: "legacy", role: "user", parts: [], createdAt: 1 },
      {
        id: "ahead",
        sessionId: "legacy",
        role: "user",
        parts: [],
        createdAt: 1,
        collaboration: {
          author: messageEvent.actor,
          sourceEventId: "ahead",
          eventSequence: 100,
          version: 5,
        },
      },
    ])
    await syncSharedSession(
      readerFor(
        messageEvent,
        {
          ...messageEvent,
          sequence: 2,
          id: "correct",
          kind: "message.corrected",
          payload: { targetMessageId: "correct-legacy", parts: [] },
        },
        {
          ...messageEvent,
          sequence: 3,
          id: "redact",
          kind: "message.redacted",
          payload: { targetMessageId: "redact-legacy" },
        },
        {
          ...messageEvent,
          sequence: 4,
          id: "ahead-create",
          payload: { ...messageEvent.payload, messageId: "ahead" },
        },
        {
          ...messageEvent,
          sequence: 5,
          id: "ahead-correct",
          kind: "message.corrected",
          payload: { targetMessageId: "ahead", parts: [] },
        },
        {
          ...messageEvent,
          sequence: 6,
          id: "ahead-redact",
          kind: "message.redacted",
          payload: { targetMessageId: "ahead" },
        }
      ),
      session.orgId,
      session.id
    )
    expect(await getDb().messages.count()).toBe(4)
    expect((await getDb().messages.get("correct-legacy"))?.collaboration?.author).toEqual(
      messageEvent.actor
    )
    expect((await getDb().messages.get("ahead"))?.collaboration?.version).toBe(5)
  })

  it("uses network and foreground recovery listeners and removes them on close", async () => {
    const windowTarget = new EventTarget()
    const documentTarget = Object.assign(new EventTarget(), { visibilityState: "visible" })
    Object.defineProperty(globalThis, "window", { configurable: true, value: windowTarget })
    Object.defineProperty(globalThis, "document", { configurable: true, value: documentTarget })
    const client = {
      ...readerFor(),
      openSessionStream: jest.fn(async () => ({
        id: "socket",
        kind: "browser" as const,
        close: jest.fn(async () => {}),
        send: jest.fn(async () => {}),
      })),
    }
    const stream = await connectSharedSessionStream(client, session.orgId, session.id)
    try {
      documentTarget.visibilityState = "hidden"
      documentTarget.dispatchEvent(new Event("visibilitychange"))
      expect(client.getSharedSession).toHaveBeenCalledTimes(2)
      documentTarget.visibilityState = "visible"
      windowTarget.dispatchEvent(new Event("online"))
      for (let i = 0; i < 100 && client.getSharedSession.mock.calls.length < 3; i++)
        await new Promise((resolve) => setTimeout(resolve, 2))
      expect(client.getSharedSession).toHaveBeenCalledTimes(3)
    } finally {
      stream.close()
      Reflect.deleteProperty(globalThis, "window")
      Reflect.deleteProperty(globalThis, "document")
    }
  })

  it("closes a socket when post-subscription catch-up fails", async () => {
    const close = jest.fn(async () => {})
    const client = {
      ...readerFor(),
      openSessionStream: jest.fn(async () => ({
        id: "socket",
        kind: "browser" as const,
        close,
        send: jest.fn(async () => {}),
      })),
    }
    client.getSharedSession.mockResolvedValueOnce(session).mockRejectedValue("lost connection")
    const stream = await connectSharedSessionStream(client, session.orgId, session.id)
    expect(close).toHaveBeenCalled()
    expect(stream.socket).toBeNull()
    stream.close()
  })

  it("purges cached history when stream authorization is revoked after the initial pull", async () => {
    const client = {
      ...readerFor(messageEvent),
      openSessionStream: jest.fn().mockRejectedValue(new CollabError(403, "revoked")),
    }
    const stream = await connectSharedSessionStream(client, session.orgId, session.id)
    try {
      expect(await getDb().sessions.count()).toBe(0)
      expect(await getDb().messages.count()).toBe(0)
      expect(await getDb().collabChatSyncStates.count()).toBe(0)
    } finally {
      stream.close()
    }
  })

  it("does not mark a socket connected if it closes during its handshake", async () => {
    const close = jest.fn(async () => {})
    const client = {
      ...readerFor(),
      openSessionStream: jest.fn(
        async (_org: string, _id: string, handlers: PlatformWebSocketHandlers) => {
          handlers.onClose?.({ code: 1006, reason: null })
          return { id: "socket", kind: "browser" as const, close, send: jest.fn(async () => {}) }
        }
      ),
    }
    const stream = await connectSharedSessionStream(client, session.orgId, session.id)
    expect(stream.socket).toBeNull()
    expect(close).toHaveBeenCalled()
    stream.close()
  })

  it("closes an in-flight socket when the session lifecycle aborts", async () => {
    const abort = new AbortController()
    const close = jest.fn(async () => {})
    const client = {
      ...readerFor(),
      openSessionStream: jest.fn(async () => {
        abort.abort()
        return { id: "late", kind: "browser" as const, close, send: jest.fn(async () => {}) }
      }),
    }
    const stream = await connectSharedSessionStream(client, session.orgId, session.id, {
      signal: abort.signal,
    })
    expect(close).toHaveBeenCalledTimes(1)
    expect(stream.socket).toBeNull()
    stream.close()
  })

  it("does not start an already aborted subscription", async () => {
    const signal = AbortSignal.abort()
    const client = { ...readerFor(), openSessionStream: jest.fn() }
    const stream = await connectSharedSessionStream(client, session.orgId, session.id, { signal })
    expect(client.getSharedSession).not.toHaveBeenCalled()
    stream.close()
  })

  it("refreshes on notifications and stops after a confirmed revocation", async () => {
    let handlers: PlatformWebSocketHandlers = {}
    const close = jest.fn(async () => {})
    const client = {
      ...readerFor(messageEvent),
      openSessionStream: jest.fn(
        async (_org: string, _id: string, callbacks: PlatformWebSocketHandlers) => {
          handlers = callbacks
          return { id: "socket", kind: "browser" as const, close, send: jest.fn(async () => {}) }
        }
      ),
    }
    const stream = await connectSharedSessionStream(client, session.orgId, session.id)
    client.getSharedSession.mockRejectedValue(new CollabError(403, "revoked"))
    handlers.onMessage?.("notification")
    for (let i = 0; i < 100 && !close.mock.calls.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 2))
    expect(close).toHaveBeenCalled()
    expect(await getDb().collabChatSyncStates.get(session.id)).toBeUndefined()
    handlers.onClose?.({ code: 1000, reason: null })
    stream.close()
  })

  it("returns a closable controller after a transient initial failure", async () => {
    const client = { ...readerFor(), openSessionStream: jest.fn() }
    client.getSharedSession.mockRejectedValue(new Error("offline"))
    const stream = await connectSharedSessionStream(client, session.orgId, session.id)
    expect(stream.socket).toBeNull()
    stream.close()
  })

  it("catches up after subscription and reconnects after an unexpected close", async () => {
    let handlers: PlatformWebSocketHandlers = {}
    const close = jest.fn(async () => {})
    const client = {
      ...readerFor(messageEvent),
      openSessionStream: jest.fn(
        async (_org: string, _id: string, callbacks: PlatformWebSocketHandlers) => {
          handlers = callbacks
          return { id: "socket", kind: "browser" as const, close, send: jest.fn(async () => {}) }
        }
      ),
    }
    const stream = await connectSharedSessionStream(client, session.orgId, session.id)
    expect(client.listSessionEvents).toHaveBeenCalledTimes(2)
    expect(await getDb().collabChatSyncStates.get(session.id)).toMatchObject({ connected: true })
    // Capture only reconnect scheduling: fake timers would also trap IndexedDB.
    let reconnect: (() => void) | undefined
    const schedule = jest.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      reconnect = fn
      return 123 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout)
    handlers.onClose?.({ code: 1006, reason: null })
    schedule.mockRestore()
    expect(reconnect).toBeDefined()
    reconnect!()
    for (let i = 0; i < 100 && client.openSessionStream.mock.calls.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    expect(client.openSessionStream).toHaveBeenCalledTimes(2)
    stream.close()
  })

  // Deterministic request budget; elapsed time is not a performance assertion.
  it.each(Array.from({ length: 10 }, (_, index) => index + 1))(
    "coalesces 50 stream notifications without losing a late event (sample %i)",
    async () => {
      let handlers: PlatformWebSocketHandlers = {}
      const client = {
        ...readerFor(),
        openSessionStream: jest.fn(
          async (_org: string, _id: string, callbacks: PlatformWebSocketHandlers) => {
            handlers = callbacks
            return {
              id: "burst",
              kind: "browser" as const,
              close: jest.fn(async () => {}),
              send: jest.fn(async () => {}),
            }
          }
        ),
      }
      const stream = await connectSharedSessionStream(client, session.orgId, session.id)
      client.listSessionEvents.mockClear()
      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      let release!: (events: SessionEvent[]) => void
      client.listSessionEvents.mockImplementationOnce(() => {
        entered()
        return new Promise<SessionEvent[]>((resolve) => {
          release = resolve
        })
      })
      try {
        handlers.onMessage?.("notification")
        await started
        client.listSessionEvents.mockResolvedValue([messageEvent])
        for (let index = 0; index < 49; index++) handlers.onMessage?.("notification")
        release([])
        let previousCount = 0
        let quiet = 0
        for (let attempt = 0; attempt < 500 && quiet < 10; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 10))
          const count = client.listSessionEvents.mock.calls.length
          quiet = count === previousCount ? quiet + 1 : 0
          previousCount = count
        }
        expect((await getDb().collabChatSyncStates.get(session.id))?.lastSequence).toBe(1)
        expect(
          (await getDb().messages.where("sessionId").equals("shared:shared_1").first())?.parts
        ).toEqual(messageEvent.payload.parts)
        expect(client.listSessionEvents).toHaveBeenCalledTimes(2)
      } finally {
        stream.close()
      }
    }
  )

  it.each(["close", "abort"])(
    "discards an in-flight refresh and trailing pulse after %s",
    async (mode) => {
      let handlers: PlatformWebSocketHandlers = {}
      const client = {
        ...readerFor(),
        openSessionStream: jest.fn(
          async (_org: string, _id: string, callbacks: PlatformWebSocketHandlers) => {
            handlers = callbacks
            return {
              id: "shutdown",
              kind: "browser" as const,
              close: jest.fn(async () => {}),
              send: jest.fn(async () => {}),
            }
          }
        ),
      }
      const abort = new AbortController()
      const stream = await connectSharedSessionStream(client, session.orgId, session.id, {
        signal: abort.signal,
      })
      client.listSessionEvents.mockClear()
      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      let release!: (events: SessionEvent[]) => void
      client.listSessionEvents.mockImplementationOnce(() => {
        entered()
        return new Promise<SessionEvent[]>((resolve) => {
          release = resolve
        })
      })
      handlers.onMessage?.("notification")
      await started
      handlers.onMessage?.("notification")
      if (mode === "close") stream.close()
      else abort.abort()
      release([messageEvent])
      // Join the session's serialized sync lane to observe settled persistence.
      await syncSharedSession(readerFor(), session.orgId, session.id)
      expect(await getDb().messages.count()).toBe(0)
      expect(client.listSessionEvents).toHaveBeenCalledTimes(1)
      expect(stream.socket).toBeNull()
      stream.close()
    }
  )

  it("does not mark a socket connected when it closes during post-connect catch-up", async () => {
    let handlers: PlatformWebSocketHandlers = {}
    const client = {
      ...readerFor(),
      openSessionStream: jest.fn(
        async (_org: string, _id: string, callbacks: PlatformWebSocketHandlers) => {
          handlers = callbacks
          return {
            id: "closed-catchup",
            kind: "browser" as const,
            close: jest.fn(async () => {}),
            send: jest.fn(async () => {}),
          }
        }
      ),
    }
    client.listSessionEvents.mockResolvedValueOnce([]).mockImplementationOnce(async () => {
      handlers.onClose?.({ code: 1006, reason: null })
      return []
    })
    const stream = await connectSharedSessionStream(client, session.orgId, session.id)
    try {
      expect(stream.socket).toBeNull()
      expect((await getDb().collabChatSyncStates.get(session.id))?.connected).toBe(false)
    } finally {
      stream.close()
    }
  })

  it("reschedules reconnect when its timer fires before catch-up finishes", async () => {
    let handlers: PlatformWebSocketHandlers = {}
    const reconnects: Array<() => void> = []
    const originalTimer = globalThis.setTimeout
    const timer = jest.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
      delay?: number
    ) => {
      if (delay !== undefined && delay >= 400 && delay <= 36_000) {
        reconnects.push(callback)
        return 123 as unknown as ReturnType<typeof setTimeout>
      }
      return originalTimer(callback, delay)
    }) as typeof setTimeout)
    const client = {
      ...readerFor(),
      openSessionStream: jest.fn(
        async (_org: string, _id: string, callbacks: PlatformWebSocketHandlers) => {
          handlers = callbacks
          return {
            id: "slow-catchup",
            kind: "browser" as const,
            close: jest.fn(async () => {}),
            send: jest.fn(async () => {}),
          }
        }
      ),
    }
    client.listSessionEvents.mockResolvedValueOnce([]).mockImplementationOnce(async () => {
      handlers.onClose?.({ code: 1006, reason: null })
      reconnects[0]()
      return []
    })
    try {
      const stream = await connectSharedSessionStream(client, session.orgId, session.id)
      try {
        expect(stream.socket).toBeNull()
        expect(reconnects).toHaveLength(2)
      } finally {
        stream.close()
      }
    } finally {
      timer.mockRestore()
    }
  })

  it("recovers during a pending refresh and ignores notifications from the old socket", async () => {
    const connections: PlatformWebSocketHandlers[] = []
    const client = {
      ...readerFor(),
      openSessionStream: jest.fn(
        async (_org: string, _id: string, callbacks: PlatformWebSocketHandlers) => {
          connections.push(callbacks)
          return {
            id: `connection-${connections.length}`,
            kind: "browser" as const,
            close: jest.fn(async () => {}),
            send: jest.fn(async () => {}),
          }
        }
      ),
    }
    const stream = await connectSharedSessionStream(client, session.orgId, session.id)
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: (events: SessionEvent[]) => void
    client.listSessionEvents.mockImplementationOnce(() => {
      entered()
      return new Promise<SessionEvent[]>((resolve) => {
        release = resolve
      })
    })
    try {
      connections[0].onMessage?.("notification")
      await started
      let reconnect!: () => void
      const timer = jest.spyOn(globalThis, "setTimeout").mockImplementation(((
        callback: () => void
      ) => {
        reconnect = callback
        return 123 as unknown as ReturnType<typeof setTimeout>
      }) as typeof setTimeout)
      try {
        connections[0].onClose?.({ code: 1006, reason: null })
      } finally {
        timer.mockRestore()
      }
      reconnect()
      client.listSessionEvents.mockResolvedValue([messageEvent])
      release([])
      for (let attempt = 0; attempt < 500 && stream.socket?.id !== "connection-2"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
      expect(stream.socket?.id).toBe("connection-2")
      await syncSharedSession(readerFor(messageEvent), session.orgId, session.id)
      const pulls = client.listSessionEvents.mock.calls.length
      connections[0].onMessage?.("stale notification")
      connections[0].onClose?.({ code: 1006, reason: null })
      await syncSharedSession(readerFor(messageEvent), session.orgId, session.id)
      expect(client.listSessionEvents).toHaveBeenCalledTimes(pulls)
      const correction = {
        ...messageEvent,
        id: "new-socket-event",
        sequence: 2,
        kind: "message.corrected" as const,
        payload: { targetMessageId: "message_1", parts: [{ type: "text", text: "latest" }] },
      }
      client.listSessionEvents.mockResolvedValue([correction])
      connections[1].onMessage?.("new notification")
      await syncSharedSession(readerFor(), session.orgId, session.id)
      expect((await getDb().messages.toArray())[0].parts).toEqual(correction.payload.parts)
    } finally {
      stream.close()
    }
  })

  it("never corrects a message in another session", async () => {
    await getDb().messages.put({
      id: "other-message",
      sessionId: "private",
      role: "user",
      parts: [{ type: "text", text: "private" }],
      createdAt: 1,
    })
    await syncSharedSession(
      readerFor({
        ...messageEvent,
        kind: "message.corrected",
        payload: {
          targetMessageId: "other-message",
          parts: [{ type: "text", text: "tampered" }],
        },
      }),
      session.orgId,
      session.id
    )
    expect((await getDb().messages.get("other-message"))?.parts).toEqual([
      { type: "text", text: "private" },
    ])
  })

  it("isolates equal message and session ids from different collaboration endpoints", async () => {
    const first = await syncSharedSession(
      { ...readerFor(messageEvent), baseUrl: "https://one.example" },
      session.orgId,
      session.id
    )
    const second = await syncSharedSession(
      { ...readerFor(messageEvent), baseUrl: "https://two.example" },
      session.orgId,
      session.id
    )
    expect(first.localSessionId).not.toBe(second.localSessionId)
    expect(await getDb().messages.where("sessionId").equals(first.localSessionId).count()).toBe(1)
    expect(await getDb().messages.where("sessionId").equals(second.localSessionId).count()).toBe(1)
  })

  it("projects server events once and advances the durable cursor", async () => {
    const client = {
      getSharedSession: jest.fn().mockResolvedValue(session),
      listSessionMembers: jest.fn().mockResolvedValue([
        {
          sessionId: session.id,
          userId: "user_1",
          role: "owner",
          approver: true,
          guest: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      listSessionEvents: jest.fn().mockResolvedValue([messageEvent]),
    }

    const first = await syncSharedSession(client, session.orgId, session.id)
    await syncSharedSession(client, session.orgId, session.id)

    expect(first.localSessionId).toBe("shared:shared_1")
    expect(client.listSessionEvents).toHaveBeenNthCalledWith(1, session.orgId, session.id, 0)
    expect(client.listSessionEvents).toHaveBeenNthCalledWith(2, session.orgId, session.id, 1)
    expect(
      await getDb().messages.where("sessionId").equals("shared:shared_1").first()
    ).toMatchObject({
      sessionId: "shared:shared_1",
      collaboration: { sourceEventId: "event_1", eventSequence: 1, version: 1 },
    })
    expect((await getDb().collabChatSyncStates.get(session.id))?.lastSequence).toBe(1)
  })

  // `event.actor` is the only value the server authenticated. The payload is
  // written by whoever appended the event, so a member could otherwise claim
  // another member's identity and have every mirror render it as theirs.
  it("refuses a payload author that claims a different person than the actor", async () => {
    const client = readerFor({
      ...messageEvent,
      actor: { kind: "human", id: "user_2", displayName: "Mallory" },
      payload: {
        ...(messageEvent.payload as Record<string, unknown>),
        author: { kind: "human", id: "user_1", displayName: "Ada" },
      },
    })

    await syncSharedSession(client, session.orgId, session.id)

    expect(
      await getDb().messages.where("sessionId").equals("shared:shared_1").first()
    ).toMatchObject({
      senderId: "user_2",
      collaboration: { author: { kind: "human", id: "user_2" } },
    })
  })

  // The reason the payload can carry an author at all: an imported transcript's
  // assistant turns must not project as the human who ran the import. Those
  // kinds name no person, so honouring them impersonates nobody.
  it("keeps a non-human payload author so imported transcripts keep their shape", async () => {
    const client = readerFor({
      ...messageEvent,
      payload: {
        ...(messageEvent.payload as Record<string, unknown>),
        role: "assistant",
        author: { kind: "agent", id: "run:abc" },
      },
    })

    await syncSharedSession(client, session.orgId, session.id)

    expect(
      await getDb().messages.where("sessionId").equals("shared:shared_1").first()
    ).toMatchObject({
      senderId: "run:abc",
      collaboration: { author: { kind: "agent", id: "run:abc" } },
    })
  })

  it("purges the local projection when the server hides a revoked session", async () => {
    await getDb().sessions.put({
      id: "shared:shared_1",
      projectId: session.workspaceId,
      title: session.title,
      kind: "direct",
      createdAt: 1,
      updatedAt: 1,
      collaboration: {
        orgId: session.orgId,
        workspaceId: session.workspaceId,
        sessionId: session.id,
        policyRevision: 1,
        syncCursor: 1,
      },
    })
    await getDb().messages.put({
      id: "message_1",
      sessionId: "shared:shared_1",
      projectId: session.workspaceId,
      role: "user",
      parts: [{ type: "text", text: "private" }],
      createdAt: 1,
    })
    await getDb().collabChatSessions.put({ ...session, fetchedAt: 1 })

    const client = {
      getSharedSession: jest.fn().mockRejectedValue(new CollabError(404, "not found")),
      listSessionMembers: jest.fn(),
      listSessionEvents: jest.fn(),
    }

    await expect(syncSharedSession(client, session.orgId, session.id)).rejects.toMatchObject({
      status: 404,
    })
    expect(await getDb().sessions.get("shared:shared_1")).toBeUndefined()
    expect(await getDb().messages.get("message_1")).toBeUndefined()
    expect(await getDb().collabChatSessions.get(session.id)).toBeUndefined()
  })

  it("projects the payload's reference metadata onto the local row", async () => {
    const metadata = {
      mentions: [{ kind: "entity", id: "session:source_a", label: "Sprint planning" }],
      promptPreamble: {
        sections: ["references"],
        references: [{ kind: "entity", entityKind: "session", title: "Sprint planning" }],
      },
    }
    await syncSharedSession(
      readerFor({
        ...messageEvent,
        payload: { ...(messageEvent.payload as Record<string, unknown>), metadata },
      }),
      session.orgId,
      session.id
    )
    expect(
      (await getDb().messages.where("sessionId").equals("shared:shared_1").first())?.metadata
    ).toMatchObject(metadata)
  })

  it("drops malformed and non-reference keys from the payload metadata", async () => {
    // Remote input any member could shape: only `mentions`/`promptPreamble`
    // survive, each entry re-validated, and a malformed entry reads as absent.
    await syncSharedSession(
      readerFor({
        ...messageEvent,
        payload: {
          ...(messageEvent.payload as Record<string, unknown>),
          metadata: {
            mentions: [
              { kind: "entity", id: "session:source_a" },
              { kind: "bogus-kind", id: "x" },
              "garbage",
            ],
            promptPreamble: { not: "a summary" },
            steer: { entryId: "forged" },
          },
        },
      }),
      session.orgId,
      session.id
    )
    const row = await getDb().messages.where("sessionId").equals("shared:shared_1").first()
    expect(row?.metadata).toEqual({
      mentions: [{ kind: "entity", id: "session:source_a" }],
    })
  })

  it("keeps the row's existing metadata when a correction carries none", async () => {
    await syncSharedSession(
      readerFor({
        ...messageEvent,
        payload: {
          ...(messageEvent.payload as Record<string, unknown>),
          metadata: { mentions: [{ kind: "entity", id: "session:source_a" }] },
        },
      }),
      session.orgId,
      session.id
    )
    await syncSharedSession(
      readerFor({
        ...messageEvent,
        id: "event_2",
        sequence: 2,
        kind: "message.corrected",
        payload: {
          targetMessageId: "message_1",
          parts: [{ type: "text", text: "edited" }],
        },
      }),
      session.orgId,
      session.id
    )
    const row = await getDb().messages.where("sessionId").equals("shared:shared_1").first()
    expect(row?.parts).toEqual([{ type: "text", text: "edited" }])
    expect(row?.metadata).toMatchObject({
      mentions: [{ kind: "entity", id: "session:source_a" }],
    })
  })

  it("strips reference metadata when the message is redacted", async () => {
    // Redaction removes the shared content — and the citations naming the
    // referenced conversation (incl. its title) are part of that content.
    await syncSharedSession(
      readerFor({
        ...messageEvent,
        payload: {
          ...(messageEvent.payload as Record<string, unknown>),
          metadata: {
            mentions: [{ kind: "entity", id: "session:source_a", label: "Sprint planning" }],
            promptPreamble: {
              sections: ["references"],
              references: [{ kind: "entity", entityKind: "session", title: "Sprint planning" }],
            },
          },
        },
      }),
      session.orgId,
      session.id
    )
    await syncSharedSession(
      readerFor({
        ...messageEvent,
        id: "event_2",
        sequence: 2,
        kind: "message.redacted",
        payload: { targetMessageId: "message_1" },
      }),
      session.orgId,
      session.id
    )
    const row = await getDb().messages.where("sessionId").equals("shared:shared_1").first()
    expect(row?.parts).toEqual([])
    expect(row?.metadata).toBeUndefined()
  })
})
