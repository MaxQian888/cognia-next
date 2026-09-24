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
      teamId: "team1",
      lastMessagePreview: "Last answer",
      lastMessageAt: 2,
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
        teamId: "team1",
        lastMessagePreview: "Last answer",
        lastMessageAt: 2,
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

  it("keeps explicit turns complete and unique across single-turn pages", async () => {
    await getDb().messages.bulkPut(
      Array.from({ length: 9 }, (_, index) => ({
        id: `message-${index}`,
        sessionId: "s1",
        turnKey: `explicit-${Math.floor(index / 3)}`,
        role: index % 3 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `message ${index}` }],
        createdAt: index + 1,
      })) as never[]
    )

    let cursor: string | undefined
    for (const turn of [2, 1, 0]) {
      const page = await readTranscriptTimeline({ sessionId: "s1", limit: 1, cursor })
      expect(page.items).toHaveLength(1)
      expect(page.items[0]).toMatchObject({
        itemKey: `explicit-${turn}`,
        userMessages: [{ id: `message-${turn * 3}` }],
        finalResponse: { id: `message-${turn * 3 + 2}` },
        collapsed: { messageCount: 3 },
      })
      expect(page.hasMore).toBe(turn > 0)
      cursor = page.nextCursor
    }
  })

  it("does not consume system items excluded by the page limit", async () => {
    await getDb().messages.bulkPut(
      ["system", "system", "user", "assistant"].map((role, index) => ({
        id: `message-${index}`,
        sessionId: "s1",
        role,
        parts: [{ type: "text", text: role }],
        createdAt: index + 1,
      })) as never[]
    )
    const newest = await readTranscriptTimeline({ sessionId: "s1", limit: 1 })
    const middle = await readTranscriptTimeline({
      sessionId: "s1",
      limit: 1,
      cursor: newest.nextCursor,
    })
    const oldest = await readTranscriptTimeline({
      sessionId: "s1",
      limit: 1,
      cursor: middle.nextCursor,
    })
    expect(newest.items.map((item) => item.itemKey)).toEqual(["turn:message-2"])
    expect(middle.items.map((item) => item.itemKey)).toEqual(["system:message-1"])
    expect(middle.hasMore).toBe(true)
    expect(oldest.items.map((item) => item.itemKey)).toEqual(["system:message-0"])
    expect(oldest.hasMore).toBe(false)
  })

  it("finishes an explicit turn across scan chunks and preserves equal-timestamp index order", async () => {
    await getDb().messages.bulkPut(
      Array.from({ length: 202 }, (_, index) => ({
        id: `message-${String(index).padStart(3, "0")}`,
        sessionId: "s1",
        turnKey: index === 0 ? "older" : "newest",
        role: index <= 1 ? "user" : "assistant",
        parts: [{ type: "text", text: `message ${index}` }],
        createdAt: 1,
      })) as never[]
    )
    const page = await readTranscriptTimeline({ sessionId: "s1", limit: 1 })
    expect(page.items[0]).toMatchObject({
      itemKey: "newest",
      userMessages: [{ id: "message-001" }],
      finalResponse: { id: "message-201" },
      collapsed: { messageCount: 201 },
    })
    const older = await readTranscriptTimeline({
      sessionId: "s1",
      limit: 1,
      cursor: page.nextCursor,
    })
    expect(older.items.map((item) => item.itemKey)).toEqual(["older"])
    expect(older.hasMore).toBe(false)
  })

  it("returns only complete turns at the scan cap and refuses an oversized single turn", async () => {
    const rows = Array.from({ length: 2_003 }, (_, index) => ({
      id: `message-${index}`,
      sessionId: "s1",
      turnKey: index < 2_001 ? "oversized" : "newest",
      role: index === 0 || index === 2_001 ? "user" : "assistant",
      parts: [{ type: "text", text: "message" }],
      createdAt: index + 1,
    })).reverse()
    // Keep the cap check deterministic without fake-indexeddb's expensive
    // reverse cursor emulation. Smaller tests above exercise actual DB order.
    const reads: number[] = []
    const collection = {
      between: () => collection,
      reverse: () => collection,
      offset: (offset: number) => ({
        first: async () => rows[offset],
        limit: (limit: number) => ({
          toArray: async () => {
            const page = rows.slice(offset, offset + limit)
            reads.push(page.length)
            return page
          },
        }),
      }),
    }
    const query = jest.spyOn(getDb().messages, "where").mockReturnValue(collection as never)
    try {
      const page = await readTranscriptTimeline({ sessionId: "s1", limit: 2 })
      expect(page.items).toHaveLength(1)
      expect(page.items[0]).toMatchObject({ itemKey: "newest", collapsed: { messageCount: 2 } })
      expect(page.hasMore).toBe(true)
      expect(reads).toEqual(Array(10).fill(200))
      reads.length = 0
      await expect(
        readTranscriptTimeline({ sessionId: "s1", cursor: page.nextCursor })
      ).rejects.toMatchObject({ code: "INVALID_PARAMS" })
      expect(reads).toEqual(Array(10).fill(200))
    } finally {
      query.mockRestore()
    }
  })

  it("paginates a system-only history beyond the scan cap without losing entries", async () => {
    const rows = Array.from({ length: 2_001 }, (_, index) => ({
      id: `system-${index}`,
      sessionId: "s1",
      role: "system",
      parts: [],
      createdAt: index + 1,
    })).reverse()
    const collection = {
      between: () => collection,
      reverse: () => collection,
      offset: (offset: number) => ({
        first: async () => rows[offset],
        limit: (limit: number) => ({ toArray: async () => rows.slice(offset, offset + limit) }),
      }),
    }
    const query = jest.spyOn(getDb().messages, "where").mockReturnValue(collection as never)
    try {
      const seen: string[] = []
      let cursor: string | undefined
      do {
        const page = await readTranscriptTimeline({ sessionId: "s1", limit: 100, cursor })
        expect(page.items.length).toBeLessThanOrEqual(100)
        seen.unshift(...page.items.map((item) => item.itemKey))
        cursor = page.nextCursor
        expect(page.hasMore).toBe(Boolean(cursor))
      } while (cursor)
      expect(seen).toEqual(Array.from({ length: 2_001 }, (_, index) => `system:system-${index}`))
    } finally {
      query.mockRestore()
    }
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

  it("starts implicit details at the requested anchor when timestamps tie", async () => {
    await getDb().messages.bulkPut([
      { id: "a-old", sessionId: "s1", role: "assistant", parts: [], createdAt: 1 },
      { id: "b-user", sessionId: "s1", role: "user", parts: [], createdAt: 1 },
      { id: "c-answer", sessionId: "s1", role: "assistant", parts: [], createdAt: 2 },
    ] as never[])
    const page = await readTranscriptTurnMessages({
      sessionId: "s1",
      turnKey: "turn:b-user",
      revision: 4,
      detailRevision: 4,
    })
    expect(page.messages.map((message) => message.id)).toEqual(["b-user", "c-answer"])
  })

  it("stops reading implicit details before later turns", async () => {
    await getDb().messages.bulkPut(
      Array.from({ length: 52 }, (_, index) => ({
        id: `message-${index}`,
        sessionId: "s1",
        role: index % 2 === 0 ? "user" : "assistant",
        parts: [],
        createdAt: index + 1,
      })) as never[]
    )
    const read = jest.fn((message) => message)
    getDb().messages.hook("reading", read)
    try {
      const page = await readTranscriptTurnMessages({
        sessionId: "s1",
        turnKey: "turn:message-0",
        revision: 4,
        detailRevision: 4,
      })
      expect(page.messages.map((message) => message.id)).toEqual(["message-0", "message-1"])
      expect(read).toHaveBeenCalledTimes(3)
    } finally {
      getDb().messages.hook("reading").unsubscribe(read)
    }
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

  it.each([
    ["transcript-capabilities", {}, false],
    ["session-timeline", { sessionId: "s1" }, false],
    ["session-timeline", { sessionId: "missing" }, true],
    [
      "session-turn-messages",
      { sessionId: "s1", turnKey: "explicit", revision: 4, detailRevision: 4 },
      false,
    ],
    [
      "session-turn-messages",
      { sessionId: "s1", turnKey: "missing", revision: 4, detailRevision: 4 },
      true,
    ],
    ["message-get-by-session", { sessionId: "s1" }, false],
    ["message-get-by-session", { sessionId: "missing" }, true],
    ["message-send", { sessionId: "s1", content: "question" }, false],
    ["message-send", { sessionId: "s1", content: "" }, true],
  ])(
    "answers %s bridge requests and preserves error envelopes (%j)",
    async (event, payload, fails) => {
      await getDb().messages.put({
        id: "explicit-user",
        sessionId: "s1",
        turnKey: "explicit",
        role: "user",
        parts: [],
        createdAt: 1,
      } as never)
      const handlers: Record<string, (event: { payload: unknown }) => void> = {}
      let resolve!: (value: unknown) => void
      const response = new Promise((done) => {
        resolve = done
      })
      const stop = await installDesktopMessageSource({
        forceReinstall: true,
        bridge: {
          listen: jest.fn(async (name, handler) => {
            handlers[name] = handler as never
            return () => {}
          }),
          invoke: jest.fn(async (_name, args) => {
            resolve(args)
            return undefined as never
          }),
          respondMedia,
        },
      })
      try {
        handlers[`companion://${event}-request`]({
          payload: { requestId: "round-trip", ...payload },
        })
        await expect(response).resolves.toMatchObject({
          requestId: "round-trip",
          error: fails ? expect.any(String) : null,
          result: fails ? null : expect.anything(),
        })
      } finally {
        stop()
      }
    }
  )

  it("paginates explicit detail by message count and validates the cursor", async () => {
    await getDb().messages.bulkPut(
      Array.from({ length: 3 }, (_, index) => ({
        id: `detail-${index}`,
        sessionId: "s1",
        turnKey: "explicit",
        role: index === 0 ? "user" : "assistant",
        parts: [],
        createdAt: index + 1,
      })) as never[]
    )
    const request = {
      sessionId: "s1",
      turnKey: "explicit",
      revision: 4,
      detailRevision: 4,
      limit: 2,
    }
    const first = await readTranscriptTurnMessages(request)
    expect(first.messages.map((message) => message.id)).toEqual(["detail-0", "detail-1"])
    expect(first.total).toBe(3)
    const second = await readTranscriptTurnMessages({ ...request, cursor: first.nextCursor })
    expect(second.messages.map((message) => message.id)).toEqual(["detail-2"])
    expect(second.hasMore).toBe(false)
    await expect(
      readTranscriptTurnMessages({ ...request, cursor: "invalid" })
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" })
    await expect(
      readTranscriptTimeline({ sessionId: "s1", cursor: "invalid" })
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" })
    await expect(
      readTranscriptTimeline({ sessionId: "s1", direction: "forward" })
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" })
  })

  it("applies the serialized byte budget before adding another detail message", async () => {
    await getDb().messages.bulkPut(
      Array.from({ length: 2 }, (_, index) => ({
        id: `large-${index}`,
        sessionId: "s1",
        turnKey: "large",
        role: "assistant",
        parts: [{ type: "text", text: "x".repeat(1_100_000) }],
        createdAt: index + 1,
      })) as never[]
    )
    const page = await readTranscriptTurnMessages({
      sessionId: "s1",
      turnKey: "large",
      revision: 4,
      detailRevision: 4,
    })
    expect(page.messages).toHaveLength(1)
    expect(page.hasMore).toBe(true)
    await getDb().messages.update("large-0", {
      parts: [{ type: "text", text: "x".repeat(2_100_000) }],
    } as never)
    await expect(
      readTranscriptTurnMessages({
        sessionId: "s1",
        turnKey: "large",
        revision: 4,
        detailRevision: 4,
      })
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" })
  })

  it.each(["turn:", "turn:missing", "turn:other-session"])(
    "rejects unavailable implicit anchors: %s",
    async (turnKey) => {
      await getDb().messages.put({
        id: "other-session",
        sessionId: "other",
        role: "user",
        parts: [],
        createdAt: 1,
      } as never)
      await expect(
        readTranscriptTurnMessages({ sessionId: "s1", turnKey, revision: 4, detailRevision: 4 })
      ).rejects.toMatchObject({ code: "TURN_NOT_FOUND" })
    }
  )

  it("keeps sender and branch metadata and stops an implicit turn before an explicit turn", async () => {
    await getDb().sessions.update("s1", { activeBranchByGroup: { group: "answer" } } as never)
    await getDb().messages.bulkPut([
      { id: "user", sessionId: "s1", role: "user", parts: [], createdAt: 1 },
      {
        id: "answer",
        sessionId: "s1",
        role: "assistant",
        parts: [],
        createdAt: 2,
        senderId: "agent",
        senderKind: "assistant",
        metadata: { branchGroupId: "group", branchIndex: 1 },
      },
      { id: "next", sessionId: "s1", turnKey: "explicit", role: "user", parts: [], createdAt: 3 },
    ] as never[])
    const page = await readTranscriptTurnMessages({
      sessionId: "s1",
      turnKey: "turn:user",
      revision: 4,
      detailRevision: 4,
    })
    expect(page.messages.map((message) => message.id)).toEqual(["user", "answer"])
    expect(page.messages[1]).toMatchObject({
      senderId: "agent",
      senderKind: "assistant",
      metadata: { branchGroupId: "group" },
    })
    const timeline = await readTranscriptTimeline({ sessionId: "s1" })
    expect(timeline.items[0]).toMatchObject({
      branchSummary: { groups: [{ selectedMessageId: "answer" }] },
    })
  })

  it.each([
    ["bad-hash", "canonical", "INVALID_PARAMS"],
    ["a".repeat(64), "bad-variant", "INVALID_PARAMS"],
    ["a".repeat(64), "original", "MEDIA_NOT_FOUND"],
    ["a".repeat(64), "thumbnail", null],
  ])("responds to media lookup %s/%s", async (hash, variant, error) => {
    const media = {
      hash: "a".repeat(64),
      mediaType: "image/png",
      width: 1,
      height: 1,
      blob: new Blob([new Uint8Array([1])], { type: "image/png" }),
      byteSize: 1,
      createdAt: 1,
      lastUsedAt: 1,
    }
    await putMessageMedia(media)
    // fake-indexeddb cannot preserve jsdom Blob identity through cloning.
    if (variant === "thumbnail") mockGetMessageMedia.mockResolvedValueOnce(media)
    await getDb().messageMediaRefs.put({
      messageId: "media",
      sessionId: "s1",
      hash: "a".repeat(64),
    })
    let handler!: (event: { payload: unknown }) => void
    let resolve!: (response: MediaResponse) => void
    const response = new Promise<MediaResponse>((done) => {
      resolve = done
    })
    const stop = await installDesktopMessageSource({
      forceReinstall: true,
      bridge: {
        listen: jest.fn(async (name, callback) => {
          if (name === "companion://session-media-request") handler = callback as never
          return () => {}
        }),
        invoke: jest.fn(async () => undefined as never),
        respondMedia: async (value) => {
          resolve(value)
        },
      },
    })
    try {
      handler({ payload: { requestId: "media", sessionId: "s1", hash, variant } })
      const result = await response
      expect(result.error ?? null).toBe(error)
      expect(result.bytes.byteLength).toBe(error ? 0 : 1)
    } finally {
      stop()
    }
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

it("contains native unregister rejections for all message-source channels", async () => {
  const failures: Promise<void>[] = []
  const spies: jest.SpyInstance[] = []
  const off = jest.fn(() => {
    const failure = Promise.reject<void>(new TypeError("listeners[eventId].handlerId"))
    failures.push(failure)
    spies.push(jest.spyOn(failure, "catch"))
    return failure
  })
  const stop = await installDesktopMessageSource({
    forceReinstall: true,
    bridge: {
      listen: async () => off,
      invoke: jest.fn().mockResolvedValue(undefined),
      respondMedia,
    },
  })
  stop()
  const attached = spies.map((spy) => spy.mock.calls.length)
  await Promise.all(failures.map((failure) => failure.catch(() => {})))
  expect(attached).toEqual(Array(9).fill(1))
})
