/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

import { getDb } from "@/lib/db/schema"

import {
  __resetInstalledForTests,
  installDesktopMessageSource,
  persistIncomingMessage,
  readMessagesPage,
  readSessionPage,
} from "./desktop-message-source"

describe("readSessionPage", () => {
  beforeEach(async () => {
    __resetInstalledForTests()
    await getDb().sessions.clear()
    await getDb().messages.clear()
  })

  it("returns sessions ordered by updatedAt desc with a total count", async () => {
    const db = getDb()
    await db.sessions.bulkPut([
      { id: "s1", title: "old", kind: "direct", createdAt: 0, updatedAt: 1 } as never,
      { id: "s2", title: "mid", kind: "direct", createdAt: 0, updatedAt: 5 } as never,
      { id: "s3", title: "new", kind: "direct", createdAt: 0, updatedAt: 10 } as never,
    ])
    const page = await readSessionPage(10, 0)
    expect(page.rows.map((r) => r.id)).toEqual(["s3", "s2", "s1"])
    expect(page.total).toBe(3)
    expect(page.next_offset).toBeUndefined()
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

  it("filters by before cursor", async () => {
    const db = getDb()
    await db.sessions.bulkPut([
      { id: "old", title: "o", kind: "direct", createdAt: 0, updatedAt: 1 } as never,
      { id: "mid", title: "m", kind: "direct", createdAt: 0, updatedAt: 5 } as never,
      { id: "new", title: "n", kind: "direct", createdAt: 0, updatedAt: 10 } as never,
    ])
    const page = await readSessionPage(10, 0, 5)
    expect(page.rows.map((r) => r.id)).toEqual(["old"])
    expect(page.total).toBe(1)
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
      bridge: { listen, invoke },
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
      bridge: { listen, invoke },
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
      bridge: { listen, invoke },
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
      bridge: { listen, invoke },
      forceReinstall: true,
    })

    const db = getDb()
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
      bridge: { listen, invoke },
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
        total: 2,
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
      bridge: { listen, invoke },
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
      bridge: { listen, invoke },
      forceReinstall: true,
    })
    const teardown2 = await installDesktopMessageSource({
      bridge: { listen, invoke },
      forceReinstall: false,
    })
    teardown2()
    teardown1()
    // The second listen/listen/listen triple did NOT fire.
    expect(listen).toHaveBeenCalledTimes(5)
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
      bridge: { listen, invoke },
      forceReinstall: true,
    })
    // 3 listeners registered.
    expect(listen).toHaveBeenCalledTimes(5)

    // Second call with forceReinstall: false short-circuits — no extra listens.
    const teardown2 = await installDesktopMessageSource({
      bridge: { listen, invoke },
      forceReinstall: false,
    })
    expect(listen).toHaveBeenCalledTimes(5)

    teardown2()
    teardown1()
  })
})

describe("readMessagesPage", () => {
  beforeEach(async () => {
    __resetInstalledForTests()
    await getDb().messages.clear()
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
    expect(page.total).toBe(3)
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

  it("returns an empty page for a session with no messages", async () => {
    const page = await readMessagesPage("ghost")
    expect(page.rows).toEqual([])
    expect(page.total).toBe(0)
    expect(page.next_offset).toBeUndefined()
  })
})

describe("persistIncomingMessage", () => {
  beforeEach(async () => {
    __resetInstalledForTests()
    await getDb().messages.clear()
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
