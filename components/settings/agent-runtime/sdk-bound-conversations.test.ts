import type { ChatSession } from "@cognia/agent-config-types"

import {
  chatLinksToSdkSession,
  countExposedConversations,
  filterSdkBoundConversations,
  linkedChatsFor,
  selectSdkBoundConversations,
  sessionLastActivity,
} from "./sdk-bound-conversations"

function session(partial: Partial<ChatSession> & { id: string }): ChatSession {
  return {
    title: partial.id,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  } as ChatSession
}

describe("countExposedConversations", () => {
  it("splits exposed conversations by archive state and skips embedded rows", () => {
    const counts = countExposedConversations([
      session({ id: "a" }),
      session({ id: "b", archivedAt: 5 }),
      session({ id: "c", archivedAt: undefined }),
      session({ id: "sub", kind: "subagent" }),
      session({ id: "wf", kind: "workflow-editor", archivedAt: 3 }),
      session({ id: "hidden", visibility: "embedded" }),
    ])
    expect(counts).toEqual({ active: 2, archived: 1 })
  })

  it("returns zeros for an empty table", () => {
    expect(countExposedConversations([])).toEqual({ active: 0, archived: 0 })
  })
})

describe("sessionLastActivity", () => {
  it("prefers the last message over the last write", () => {
    expect(sessionLastActivity({ lastMessageAt: 10, updatedAt: 99 })).toBe(10)
    expect(sessionLastActivity({ updatedAt: 99 })).toBe(99)
  })
})

describe("selectSdkBoundConversations", () => {
  it("keeps exposed rows with an SDK session id, newest activity first, archived included", () => {
    const rows = selectSdkBoundConversations([
      session({ id: "old", sdkSessionId: "sdk-old", updatedAt: 1 }),
      session({ id: "none", updatedAt: 50 }),
      session({ id: "blank", sdkSessionId: "", updatedAt: 60 }),
      session({ id: "new", sdkSessionId: "sdk-new", updatedAt: 5, lastMessageAt: 40 }),
      session({ id: "archived", sdkSessionId: "sdk-arch", updatedAt: 20, archivedAt: 21 }),
      session({ id: "sub", kind: "subagent", sdkSessionId: "sdk-sub", updatedAt: 90 }),
    ])
    expect(rows.map((row) => row.id)).toEqual(["new", "archived", "old"])
  })

  it("breaks activity ties by id so the order is stable", () => {
    const rows = selectSdkBoundConversations([
      session({ id: "b", sdkSessionId: "x", updatedAt: 1 }),
      session({ id: "a", sdkSessionId: "y", updatedAt: 1 }),
    ])
    expect(rows.map((row) => row.id)).toEqual(["a", "b"])
  })
})

describe("filterSdkBoundConversations", () => {
  const rows = [
    session({ id: "chat-1", title: "Fix auth", sdkSessionId: "sdk-aaa" }),
    session({ id: "chat-2", title: "New chat", sdkSessionId: "sdk-bbb" }),
  ]
  const titleOf = (row: ChatSession) => (row.title === "New chat" ? "Brand new" : row.title)

  it("matches the displayed title, the chat id and the SDK id", () => {
    expect(filterSdkBoundConversations(rows, "AUTH", titleOf).map((r) => r.id)).toEqual(["chat-1"])
    expect(filterSdkBoundConversations(rows, "brand", titleOf).map((r) => r.id)).toEqual(["chat-2"])
    expect(filterSdkBoundConversations(rows, "chat-2", titleOf).map((r) => r.id)).toEqual([
      "chat-2",
    ])
    expect(filterSdkBoundConversations(rows, "sdk-aaa", titleOf).map((r) => r.id)).toEqual([
      "chat-1",
    ])
  })

  it("keeps every row for a blank query and none for a miss", () => {
    expect(filterSdkBoundConversations(rows, "   ", titleOf)).toHaveLength(2)
    expect(filterSdkBoundConversations(rows, "zzz", titleOf)).toHaveLength(0)
  })
})

describe("chatLinksToSdkSession", () => {
  it("requires the same SDK session id", () => {
    expect(chatLinksToSdkSession({ sdkSessionId: "a" }, { sessionId: "b" })).toBe(false)
    expect(chatLinksToSdkSession({}, { sessionId: "b" })).toBe(false)
  })

  it("links a chat without recorded storage to every copy", () => {
    expect(chatLinksToSdkSession({ sdkSessionId: "a" }, { sessionId: "a" })).toBe(true)
    expect(
      chatLinksToSdkSession(
        { sdkSessionId: "a" },
        { sessionId: "a", storage: "host-sqlite", storageWorkspace: "/w" }
      )
    ).toBe(true)
  })

  it("matches the storage backend and, for the host store, its workspace", () => {
    const fileChat = { sdkSessionId: "a", sdkSessionStorage: { backend: "filesystem" as const } }
    const storeChat = {
      sdkSessionId: "a",
      sdkSessionStorage: { backend: "host-sqlite" as const, workspace: "/w" },
    }
    expect(chatLinksToSdkSession(fileChat, { sessionId: "a" })).toBe(true)
    expect(chatLinksToSdkSession(fileChat, { sessionId: "a", storage: "filesystem" })).toBe(true)
    expect(chatLinksToSdkSession(fileChat, { sessionId: "a", storage: "host-sqlite" })).toBe(false)
    expect(
      chatLinksToSdkSession(storeChat, {
        sessionId: "a",
        storage: "host-sqlite",
        storageWorkspace: "/w",
      })
    ).toBe(true)
    expect(
      chatLinksToSdkSession(storeChat, {
        sessionId: "a",
        storage: "host-sqlite",
        storageWorkspace: "/other",
      })
    ).toBe(false)
    expect(chatLinksToSdkSession(storeChat, { sessionId: "a", storage: "filesystem" })).toBe(false)
    expect(
      chatLinksToSdkSession(
        { sdkSessionId: "a", sdkSessionStorage: { backend: "host-sqlite" } },
        { sessionId: "a", storage: "host-sqlite" }
      )
    ).toBe(true)
  })
})

describe("linkedChatsFor", () => {
  it("returns every bound chat, embedded ones included, newest first", () => {
    const chats = [
      session({ id: "old", sdkSessionId: "a", updatedAt: 1 }),
      session({ id: "other", sdkSessionId: "b", updatedAt: 9 }),
      session({ id: "wf", kind: "workflow-editor", sdkSessionId: "a", updatedAt: 5 }),
    ]
    expect(linkedChatsFor(chats, { sessionId: "a" }).map((chat) => chat.id)).toEqual(["wf", "old"])
  })
})
