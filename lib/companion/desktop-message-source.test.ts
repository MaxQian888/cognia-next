/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

import type { MediaResponse } from "@/lib/headless/types"
import { messageRepository } from "@/lib/db"
import { getDb } from "@/lib/db/schema"
import * as messageMedia from "@/lib/db/message-media"
import { putMessageMedia } from "@/lib/db/message-media"

jest.mock("@/lib/db/message-media", () => {
  const actual = jest.requireActual("@/lib/db/message-media")
  return {
    ...actual,
    getMessageMedia: jest.fn((...args: unknown[]) => actual.getMessageMedia(...args)),
  }
})

const mockGetMessageMedia = jest.mocked(messageMedia.getMessageMedia)

import {
  __resetInstalledForTests,
  installDesktopMessageSource,
  persistIncomingMessage,
  readMessagesPage,
  readSessionPage,
  readTranscriptTimeline,
  readTranscriptTurnMessages,
} from "./desktop-message-source"

// Most of these tests never exercise the media path; they only have to
// satisfy `RuntimeBridge`, whose `respondMedia` is required precisely so a
// bridge that cannot answer media cannot be passed off as one that can.
const respondMedia = jest.fn(async () => {})

async function putExposedSession(id: string): Promise<void> {
  await getDb().sessions.put({
    id,
    title: id,
    kind: "direct",
    createdAt: 1,
    updatedAt: 1,
  } as never)
}

describe("readSessionPage", () => {
  beforeEach(async () => {
    __resetInstalledForTests()
    await getDb().sessions.clear()
    await getDb().messages.clear()
  })

  it("returns sessions ordered by updatedAt desc without an unbounded total scan", async () => {
    const db = getDb()
    await db.sessions.bulkPut([
      { id: "s1", title: "old", kind: "direct", createdAt: 0, updatedAt: 1 } as never,
      { id: "s2", title: "mid", kind: "direct", createdAt: 0, updatedAt: 5 } as never,
      { id: "s3", title: "new", kind: "direct", createdAt: 0, updatedAt: 10 } as never,
    ])
    const page = await readSessionPage(10, 0)
    expect(page.rows.map((r) => r.id)).toEqual(["s3", "s2", "s1"])
    expect(page.total).toBeUndefined()
    expect(page.has_more).toBe(false)
    expect(page.next_offset).toBeUndefined()
  })

  it("projects transport rows without heavyweight execution-only session fields", async () => {
    const db = getDb()
    await db.sessions.put({
      id: "s-heavy",
      title: "Heavy",
      kind: "direct",
      projectId: "p1",
      characterId: "c1",
      systemPrompt: "x".repeat(64 * 1024),
      scratchpad: "y".repeat(64 * 1024),
      branchSeed: { kind: "transcript", content: "z".repeat(64 * 1024) },
      createdAt: 1,
      updatedAt: 2,
    } as never)

    const page = await readSessionPage(10, 0)

    expect(page.rows).toEqual([
      {
        id: "s-heavy",
        title: "Heavy",
        kind: "direct",
        projectId: "p1",
        characterId: "c1",
        createdAt: 1,
        updatedAt: 2,
      },
    ])
    expect(JSON.stringify(page).length).toBeLessThan(1024)
  })

  it("does not expose embedded resource sessions to the companion connector", async () => {
    const db = getDb()
    await db.sessions.bulkPut([
      { id: "visible", title: "Visible", kind: "direct", createdAt: 0, updatedAt: 1 } as never,
      {
        id: "embedded",
        title: "Embedded",
        kind: "resource-workbench",
        visibility: "embedded",
        createdAt: 0,
        updatedAt: 2,
      } as never,
    ])

    const page = await readSessionPage(10, 0)
    expect(page.rows.map((row) => row.id)).toEqual(["visible"])
    expect(page.has_more).toBe(false)
  })

  it("paginates with limit + offset and reports next_offset", async () => {
    const db = getDb()
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`,
      title: `t${i}`,
      kind: "direct",
      createdAt: 0,
      updatedAt: i,
    })) as never[]
    await db.sessions.bulkPut(rows)

    const page1 = await readSessionPage(2, 0)
    expect(page1.rows.map((r) => r.id)).toEqual(["s4", "s3"])
    expect(page1.next_offset).toBe(2)

    const page2 = await readSessionPage(2, 2)
    expect(page2.rows.map((r) => r.id)).toEqual(["s2", "s1"])
    expect(page2.next_offset).toBe(4)

    const page3 = await readSessionPage(2, 4)
    expect(page3.rows.map((r) => r.id)).toEqual(["s0"])
    expect(page3.next_offset).toBeUndefined()
  })

  it("caps an oversized page request", async () => {
    const db = getDb()
    await db.sessions.bulkPut(
      Array.from({ length: 205 }, (_, i) => ({
        id: `s${i}`,
        title: `t${i}`,
        kind: "direct",
        createdAt: 0,
        updatedAt: i,
      })) as never[]
    )

    const page = await readSessionPage(10_000, 0)

    expect(page.rows).toHaveLength(200)
    expect(page.has_more).toBe(true)
    expect(page.next_offset).toBe(200)
  })

  it("filters by before cursor", async () => {
    const db = getDb()
    await db.sessions.bulkPut([
      { id: "old", title: "o", kind: "direct", createdAt: 0, updatedAt: 1 } as never,
      { id: "mid", title: "m", kind: "direct", createdAt: 0, updatedAt: 5 } as never,
      { id: "new", title: "n", kind: "direct", createdAt: 0, updatedAt: 10 } as never,
    ])
    const page = await readSessionPage(10, 0, 5)
    expect(page.rows.map((r) => r.id)).toEqual(["old"])
    expect(page.has_more).toBe(false)
  })

  it("rejects a non-positive limit", async () => {
    await expect(readSessionPage(0, 0)).rejects.toThrow(/limit/)
    await expect(readSessionPage(-1, 0)).rejects.toThrow(/limit/)
  })

  it("rejects a negative offset", async () => {
    await expect(readSessionPage(10, -1)).rejects.toThrow(/offset/)
  })
})

describe("installDesktopMessageSource — update", () => {
  beforeEach(async () => {
    __resetInstalledForTests()
    const db = getDb()
    await db.messages.clear()
    await db.sessions.clear()
    await putExposedSession("s1")
  })

  it("calls update on a message-update-request and reports success", async () => {
    type Listener = (e: { payload: unknown }) => void
    const handlers: Record<string, Listener> = {}
    const listen = jest.fn(async (event: string, h: Listener) => {
      handlers[event] = h
      return () => {}
    })
    const invoke = jest.fn(async () => ({}))

    await installDesktopMessageSource({
      bridge: { listen, invoke, respondMedia },
      forceReinstall: true,
    })

    // Seed a message.
    const db = getDb()
    await db.messages.put({
      id: "m1",
      sessionId: "s1",
      role: "user",
      parts: [{ type: "text", text: "old" }],
      createdAt: 1,
    } as never)

    handlers["companion://message-update-request"]({
      payload: {
        requestId: "rid-u",
        kind: "update",
        sessionId: "s1",
        messageId: "m1",
        updates: { content: "new" },
      },
    })

    await new Promise((r) => setTimeout(r, 10))

    expect(invoke).toHaveBeenCalledWith("companion_message_response", {
      requestId: "rid-u",
      result: null,
      error: null,
    })

    const after = await db.messages.get("m1")
    const txt = (after?.parts?.[0] as { text?: string } | undefined)?.text
    expect(txt).toBe("new")
  })

  it("reports an error when update throws", async () => {
    type Listener = (e: { payload: unknown }) => void
    const handlers: Record<string, Listener> = {}
    const listen = jest.fn(async (event: string, h: Listener) => {
      handlers[event] = h
      return () => {}
    })
    const invoke = jest.fn(async () => ({}))

    await installDesktopMessageSource({
      bridge: { listen, invoke, respondMedia },
      forceReinstall: true,
    })

    // Force the repository to throw by passing an `updates` shape that
    // breaks Dexie. Easiest path: stub the underlying table.
    const db = getDb()
    const original = db.messages.get.bind(db.messages)
    db.messages.get = (() => {
      throw new Error("dexie offline")
    }) as unknown as typeof db.messages.get

    handlers["companion://message-update-request"]({
      payload: {
        requestId: "rid-err",
        kind: "update",
        sessionId: "s1",
        messageId: "m1",
        updates: { content: "x" },
      },
    })

    await new Promise((r) => setTimeout(r, 10))

    expect(invoke).toHaveBeenCalledWith("companion_message_response", {
      requestId: "rid-err",
      result: null,
      error: expect.stringContaining("dexie offline"),
    })

    db.messages.get = original
  })
})

describe("installDesktopMessageSource — delete", () => {
  beforeEach(async () => {
    __resetInstalledForTests()
    await getDb().messages.clear()
    await getDb().sessions.clear()
    await putExposedSession("s1")
  })

  it("deletes the message and reports success", async () => {
    type Listener = (e: { payload: unknown }) => void
    const handlers: Record<string, Listener> = {}
    const listen = jest.fn(async (event: string, h: Listener) => {
      handlers[event] = h
      return () => {}
    })
    const invoke = jest.fn(async () => ({}))

    await installDesktopMessageSource({
      bridge: { listen, invoke, respondMedia },
      forceReinstall: true,
    })

    const db = getDb()
    await db.messages.put({
      id: "m1",
      sessionId: "s1",
      role: "user",
      parts: [],
      createdAt: 1,
    } as never)

    handlers["companion://message-delete-request"]({
      payload: { requestId: "rid-d", kind: "delete", sessionId: "s1", messageId: "m1" },
    })

    await new Promise((r) => setTimeout(r, 10))

    expect(await db.messages.get("m1")).toBeUndefined()
    expect(invoke).toHaveBeenCalledWith("companion_message_response", {
      requestId: "rid-d",
      result: null,
      error: null,
    })
  })

  it("reports error on delete failure", async () => {
    type Listener = (e: { payload: unknown }) => void
    const handlers: Record<string, Listener> = {}
    const listen = jest.fn(async (event: string, h: Listener) => {
      handlers[event] = h
      return () => {}
    })
    const invoke = jest.fn(async () => ({}))

    await installDesktopMessageSource({
      bridge: { listen, invoke, respondMedia },
      forceReinstall: true,
    })

    const db = getDb()
    await db.messages.put({
      id: "m1",
      sessionId: "s1",
      role: "user",
      parts: [],
      createdAt: 1,
    } as never)
    const original = db.messages.delete.bind(db.messages)
    db.messages.delete = (() => {
      throw new Error("write blocked")
    }) as unknown as typeof db.messages.delete

    handlers["companion://message-delete-request"]({
      payload: { requestId: "rid-de", kind: "delete", sessionId: "s1", messageId: "m1" },
    })
    await new Promise((r) => setTimeout(r, 10))

    expect(invoke).toHaveBeenCalledWith("companion_message_response", {
      requestId: "rid-de",
      result: null,
      error: expect.stringContaining("write blocked"),
    })

    db.messages.delete = original
  })
})

describe("installDesktopMessageSource — session_list", () => {
  beforeEach(async () => {
    __resetInstalledForTests()
    await getDb().sessions.clear()
  })

  it("returns a paginated session page", async () => {
    type Listener = (e: { payload: unknown }) => void
    const handlers: Record<string, Listener> = {}
    const listen = jest.fn(async (event: string, h: Listener) => {
      handlers[event] = h
      return () => {}
    })
    const invoke = jest.fn(async () => ({}))

    await installDesktopMessageSource({
      bridge: { listen, invoke, respondMedia },
      forceReinstall: true,
    })

    const db = getDb()
    await db.sessions.bulkPut([
      { id: "s1", title: "a", kind: "direct", createdAt: 0, updatedAt: 1 } as never,
      { id: "s2", title: "b", kind: "direct", createdAt: 0, updatedAt: 2 } as never,
    ])

    handlers["companion://session-list-request"]({
      payload: { requestId: "rid-l", kind: "session_list", limit: 10, offset: 0 },
    })

    await new Promise((r) => setTimeout(r, 10))

    expect(invoke).toHaveBeenCalledWith("companion_message_response", {
      requestId: "rid-l",
      result: expect.objectContaining({
        rows: expect.arrayContaining([expect.objectContaining({ id: "s2" })]),
        has_more: false,
      }),
      error: null,
    })
  })

  it("reports error on invalid limit", async () => {
    type Listener = (e: { payload: unknown }) => void
    const handlers: Record<string, Listener> = {}
    const listen = jest.fn(async (event: string, h: Listener) => {
      handlers[event] = h
      return () => {}
    })
    const invoke = jest.fn(async () => ({}))

    await installDesktopMessageSource({
      bridge: { listen, invoke, respondMedia },
      forceReinstall: true,
    })

    handlers["companion://session-list-request"]({
      payload: { requestId: "rid-bad", kind: "session_list", limit: 0, offset: 0 },
    })

    await new Promise((r) => setTimeout(r, 10))

    expect(invoke).toHaveBeenCalledWith("companion_message_response", {
      requestId: "rid-bad",
      result: null,
      error: expect.stringContaining("limit"),
    })
  })
})

describe("install guard", () => {
  beforeEach(() => __resetInstalledForTests())

  it("second call returns a no-op when already installed", async () => {
    type Listener = (e: { payload: unknown }) => void
    const handlers: Record<string, Listener> = {}
    const listen = jest.fn(async (event: string, h: Listener) => {
      handlers[event] = h
      return () => {}
    })
    const invoke = jest.fn(async () => ({}))

    const teardown1 = await installDesktopMessageSource({
      bridge: { listen, invoke, respondMedia },
      forceReinstall: true,
    })
    const teardown2 = await installDesktopMessageSource({
      bridge: { listen, invoke, respondMedia },
      forceReinstall: false,
    })
    teardown2()
    teardown1()
    // The second listener set did NOT fire.
    expect(listen).toHaveBeenCalledTimes(9)
  })

  it("forceReinstall: false short-circuits when already installed", async () => {
    type Listener = (e: { payload: unknown }) => void
    const handlers: Record<string, Listener> = {}
    const listen = jest.fn(async (event: string, h: Listener) => {
      handlers[event] = h
      return () => {}
    })
    const invoke = jest.fn(async () => ({}))

    const teardown1 = await installDesktopMessageSource({
      bridge: { listen, invoke, respondMedia },
      forceReinstall: true,
    })
    // All bridge listeners registered once.
    expect(listen).toHaveBeenCalledTimes(9)

    // Second call with forceReinstall: false short-circuits — no extra listens.
    const teardown2 = await installDesktopMessageSource({
      bridge: { listen, invoke, respondMedia },
      forceReinstall: false,
    })
    expect(listen).toHaveBeenCalledTimes(9)

    teardown2()
    teardown1()
  })
})

describe("readMessagesPage", () => {
  beforeEach(async () => {
    __resetInstalledForTests()
    await getDb().messages.clear()
    await getDb().sessions.clear()
    await putExposedSession("s1")
  })

  it("returns messages in createdAt-ascending order for the session", async () => {
    const db = getDb()
    await db.messages.bulkPut([
      {
        id: "m3",
        sessionId: "s1",
        role: "user",
        parts: [{ type: "text", text: "third" }],
        createdAt: 30,
      },
      {
        id: "m1",
        sessionId: "s1",
        role: "user",
        parts: [{ type: "text", text: "first" }],
        createdAt: 10,
      },
      {
        id: "m2",
        sessionId: "s1",
        role: "assistant",
        parts: [{ type: "text", text: "second" }],
        createdAt: 20,
      },
      {
        id: "x",
        sessionId: "other",
        role: "user",
        parts: [{ type: "text", text: "elsewhere" }],
        createdAt: 0,
      },
    ] as never)

    const page = await readMessagesPage("s1")
    expect(page.rows.map((r) => r.id)).toEqual(["m1", "m2", "m3"])
    expect(page.total).toBeUndefined()
    expect(page.next_offset).toBeUndefined()
  })

  it("paginates with limit + offset and reports next_offset", async () => {
    const db = getDb()
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      sessionId: "s1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: `t${i}` }],
      createdAt: i,
    }))
    await db.messages.bulkPut(rows as never)

    const page1 = await readMessagesPage("s1", 2, 0)
    expect(page1.rows.map((r) => r.id)).toEqual(["m0", "m1"])
    expect(page1.next_offset).toBe(2)

    const page2 = await readMessagesPage("s1", 2, 2)
    expect(page2.rows.map((r) => r.id)).toEqual(["m2", "m3"])
    expect(page2.next_offset).toBe(4)

    const page3 = await readMessagesPage("s1", 2, 4)
    expect(page3.rows.map((r) => r.id)).toEqual(["m4"])
    expect(page3.next_offset).toBeUndefined()
  })

  it("uses a bounded indexed query instead of materializing the full session history", async () => {
    const db = getDb()
    await db.messages.bulkPut(
      Array.from({ length: 10 }, (_, i) => ({
        id: `m${i}`,
        sessionId: "s1",
        role: "user",
        parts: [{ type: "text", text: String(i) }],
        createdAt: i + 1,
      })) as never[]
    )
    const fullMaterialization = jest
      .spyOn(messageRepository, "getBySessionId")
      .mockRejectedValue(new Error("full materialization must not run"))

    try {
      const page = await readMessagesPage("s1", 2, 0)

      expect(fullMaterialization).not.toHaveBeenCalled()
      expect(page.rows).toHaveLength(2)
      expect(page.rows[0]).toEqual(
        expect.objectContaining({ id: "m0", sessionId: "s1", createdAt: 1 })
      )
    } finally {
      fullMaterialization.mockRestore()
    }
  })

  it("returns an empty page for a session with no messages", async () => {
    await putExposedSession("ghost")
    const page = await readMessagesPage("ghost")
    expect(page.rows).toEqual([])
    expect(page.total).toBeUndefined()
    expect(page.next_offset).toBeUndefined()
  })

  it("expands media refs only on the bounded legacy message page", async () => {
    await putExposedSession("legacy-session")
    const hash = "c".repeat(64)
    await getDb().messages.put({
      id: "legacy-media",
      sessionId: "legacy-session",
      role: "assistant",
      parts: [{ type: "file", url: `cognia-media:${hash}`, mediaType: "image/png" }],
      createdAt: 1,
    } as never)
    mockGetMessageMedia.mockResolvedValueOnce({
      hash,
      mediaType: "image/png",
      width: 1,
      height: 1,
      blob: {
        arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
      } as Blob,
      byteSize: 3,
      createdAt: 1,
      lastUsedAt: 1,
    })

    const page = await readMessagesPage("legacy-session", 1, 0)

    expect((page.rows[0]?.parts[0] as { url?: string }).url).toBe("data:image/png;base64,AQID")
  })
})

describe("persistIncomingMessage", () => {
  beforeEach(async () => {
    __resetInstalledForTests()
    await getDb().messages.clear()
    await getDb().sessions.clear()
    await putExposedSession("s1")
  })

  it("creates a user message in Dexie and returns its id", async () => {
    const out = await persistIncomingMessage("s1", "hello from phone", undefined)
    expect(out.message_id).toMatch(/^[0-9a-z]+$/)

    const row = await getDb().messages.get(out.message_id)
    expect(row?.sessionId).toBe("s1")
    expect(row?.role).toBe("user")
    const text = (row?.parts?.[0] as { text?: string } | undefined)?.text
    expect(text).toBe("hello from phone")
  })

  it("honors explicit assistant role", async () => {
    const out = await persistIncomingMessage("s1", "from assistant", "assistant")
    const row = await getDb().messages.get(out.message_id)
    expect(row?.role).toBe("assistant")
  })

  it("rejects empty content", async () => {
    await expect(persistIncomingMessage("s1", "", undefined)).rejects.toThrow(/content/)
  })

  it("rejects empty sessionId", async () => {
    await expect(persistIncomingMessage("", "x", undefined)).rejects.toThrow(/sessionId/)
  })
})

describe("transcript bridge projections", () => {
  beforeEach(async () => {
    __resetInstalledForTests()
    await getDb().messages.clear()
    await getDb().sessions.clear()
    await getDb().sessions.put({
      id: "s1",
      title: "Transcript",
      kind: "direct",
      transcriptRevision: 4,
      createdAt: 1,
      updatedAt: 1,
    } as never)
  })

  // A paired browser owns the conversations it starts, so a session this brain
  // has never stored is not a malformed request. Answering `INVALID_PARAMS`
  // gave the client nothing to act on and it rendered the refusal instead of
  // its own transcript.
  it("names an unknown session absent rather than malformed", async () => {
    await expect(readTranscriptTimeline({ sessionId: "never-here" })).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    })
  })

  it("still refuses a session it holds but does not expose on this channel", async () => {
    await getDb().sessions.put({
      id: "embedded",
      title: "Embedded",
      kind: "workflow-editor",
      visibility: "embedded",
      createdAt: 1,
      updatedAt: 1,
    } as never)

    await expect(readTranscriptTimeline({ sessionId: "embedded" })).rejects.toMatchObject({
      code: "INVALID_PARAMS",
    })
  })

  it("reads newest turns through the index and binds the backward cursor to revision", async () => {
    await getDb().messages.bulkPut(
      Array.from({ length: 6 }, (_, index) => ({
        id: `${index % 2 === 0 ? "u" : "a"}${index}`,
        sessionId: "s1",
        role: index % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `message ${index}` }],
        createdAt: index + 1,
      })) as never[]
    )

    const newest = await readTranscriptTimeline({ sessionId: "s1", limit: 2 })

    expect(newest.revision).toBe(4)
    expect(newest.items.map((item) => item.itemKey)).toEqual(["turn:u2", "turn:u4"])
    expect(newest.hasMore).toBe(true)
    expect(newest.nextCursor).toBeDefined()

    const older = await readTranscriptTimeline({
      sessionId: "s1",
      limit: 2,
      cursor: newest.nextCursor,
    })
    expect(older.items.map((item) => item.itemKey)).toEqual(["turn:u0"])
  })

  it("still returns a bounded page when the resumable summary index cannot be written", async () => {
    await getDb().messages.bulkPut([
      {
        id: "u-index",
        sessionId: "s1",
        role: "user",
        parts: [{ type: "text", text: "question" }],
        createdAt: 1,
      },
      {
        id: "a-index",
        sessionId: "s1",
        role: "assistant",
        parts: [{ type: "text", text: "answer" }],
        createdAt: 2,
      },
    ] as never[])
    const indexWrite = jest
      .spyOn(getDb().chatTurnSummaries, "bulkPut")
      .mockRejectedValueOnce(new Error("quota exceeded"))

    try {
      const page = await readTranscriptTimeline({ sessionId: "s1", limit: 1 })

      expect(page.items.map((item) => item.itemKey)).toEqual(["turn:u-index"])
    } finally {
      indexWrite.mockRestore()
    }
  })

  it("pages one turn detail without returning messages from the next turn", async () => {
    await getDb().messages.bulkPut([
      {
        id: "u1",
        sessionId: "s1",
        role: "user",
        parts: [{ type: "text", text: "question" }],
        createdAt: 1,
      },
      {
        id: "a1",
        sessionId: "s1",
        role: "assistant",
        parts: [{ type: "text", text: "answer" }],
        createdAt: 2,
      },
      {
        id: "u2",
        sessionId: "s1",
        role: "user",
        parts: [{ type: "text", text: "next" }],
        createdAt: 3,
      },
    ] as never[])

    const page = await readTranscriptTurnMessages({
      sessionId: "s1",
      turnKey: "turn:u1",
      revision: 4,
      detailRevision: 4,
    })

    expect(page.messages.map((message) => message.id)).toEqual(["u1", "a1"])
    expect(page.hasMore).toBe(false)
    expect(page.approximateBytes).toBeLessThanOrEqual(2 * 1024 * 1024)
  })

  it("rejects detail reads from a stale session revision", async () => {
    await expect(
      readTranscriptTurnMessages({
        sessionId: "s1",
        turnKey: "turn:u1",
        revision: 3,
        detailRevision: 3,
      })
    ).rejects.toMatchObject({ code: "TRANSCRIPT_STALE" })
  })

  it("serves authorized session media through a raw invoke body", async () => {
    const hash = "a".repeat(64)
    await putMessageMedia({
      hash,
      mediaType: "image/png",
      width: 1,
      height: 1,
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      byteSize: 3,
      createdAt: 1,
      lastUsedAt: 1,
    })
    mockGetMessageMedia.mockResolvedValueOnce({
      hash,
      mediaType: "image/png",
      width: 1,
      height: 1,
      blob: {
        type: "image/png",
        arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
      } as unknown as Blob,
      byteSize: 3,
      createdAt: 1,
      lastUsedAt: 1,
    })
    await getDb().messageMediaRefs.put({ messageId: "m1", sessionId: "s1", hash })
    type Listener = (event: { payload: unknown }) => void
    const handlers: Record<string, Listener> = {}
    let resolveMedia: ((value: MediaResponse) => void) | undefined
    const answered = new Promise<MediaResponse>((resolve) => {
      resolveMedia = resolve
    })
    await installDesktopMessageSource({
      forceReinstall: true,
      bridge: {
        listen: jest.fn(async (event: string, handler: Listener) => {
          handlers[event] = handler
          return () => {}
        }),
        invoke: jest.fn(async () => undefined),
        respondMedia: async () => {},
        respondMedia: jest.fn(async (response: MediaResponse) => {
          resolveMedia?.(response)
        }),
      },
    })

    handlers["companion://session-media-request"]({
      payload: {
        requestId: "media-rid",
        kind: "session_media",
        sessionId: "s1",
        hash,
        variant: "canonical",
      },
    })

    // A typed answer, not an `invoke` with the bytes in the args slot. That
    // shape type-checked against a locally-declared three-parameter interface
    // and silently dropped both the bytes and the headers on the headless
    // bridge, where `invoke` takes two.
    await expect(answered).resolves.toEqual({
      requestId: "media-rid",
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "image/png",
      etag: `"${hash}:canonical"`,
    })
  })

  it("denies media hashes that are not referenced by the requested session", async () => {
    const hash = "b".repeat(64)
    type Listener = (event: { payload: unknown }) => void
    const handlers: Record<string, Listener> = {}
    let resolveMedia: ((value: MediaResponse) => void) | undefined
    const answered = new Promise<MediaResponse>((resolve) => {
      resolveMedia = resolve
    })
    await installDesktopMessageSource({
      forceReinstall: true,
      bridge: {
        listen: jest.fn(async (event: string, handler: Listener) => {
          handlers[event] = handler
          return () => {}
        }),
        invoke: jest.fn(async () => undefined),
        respondMedia: async () => {},
        respondMedia: jest.fn(async (response: MediaResponse) => {
          resolveMedia?.(response)
        }),
      },
    })

    handlers["companion://session-media-request"]({
      payload: {
        requestId: "denied-rid",
        kind: "session_media",
        sessionId: "s1",
        hash,
        variant: "canonical",
      },
    })
    const answer = await answered

    expect(answer.bytes).toEqual(new Uint8Array())
    expect(answer.error).toBe("MEDIA_NOT_FOUND")
  })
})
