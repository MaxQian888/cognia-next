/** @jest-environment jsdom */
/**
 * Tests for lib/connectors/session-bindings.ts — IM conversation ↔ ChatSession
 * binding lookups (control-plane multi-session).
 */

import "fake-indexeddb/auto"
import {
  findSessionByConversationKey,
  listSessionsByConversationKey,
  findActiveSessionForConversation,
  createPlatformSession,
  listSiblingConversations,
} from "./session-bindings"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { ChatSession } from "@/lib/claude/types"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

const KEY = "telegram:tg-1:42"

function imSession(id: string, updatedAt: number, key = KEY): ChatSession {
  return {
    id,
    title: id,
    kind: "direct",
    platformBinding: {
      platform: "telegram",
      adapterId: "tg-1",
      conversationKey: key,
      conversationRef: { platform: "telegram", adapterId: "tg-1" },
    },
    platformConversationKey: key,
    createdAt: 0,
    updatedAt,
  }
}

function makeEvent(): NormalizedInboundEvent {
  return {
    platform: "telegram",
    adapterId: "tg-1",
    conversationKey: KEY,
    conversationRef: { platform: "telegram", adapterId: "tg-1" },
    kind: "message",
    messageId: "m1",
    sender: { remoteUserId: "u1", displayName: "Alice" },
    channel: { kind: "private", name: "Alice" },
    plainText: "hi",
    segments: [{ type: "text", text: "hi" }],
    raw: {},
  } as unknown as NormalizedInboundEvent
}

describe("session-bindings", () => {
  it("createPlatformSession sets platformConversationKey + binding", async () => {
    const session = await createPlatformSession(makeEvent(), "char_1")
    expect(session.platformConversationKey).toBe(KEY)
    expect(session.platformBinding?.conversationKey).toBe(KEY)
    expect(session.characterId).toBe("char_1")
    const stored = await getDb().sessions.get(session.id)
    expect(stored?.platformConversationKey).toBe(KEY)
  })

  it("findSessionByConversationKey returns the most-recently-updated match", async () => {
    await getDb().sessions.bulkAdd([imSession("s-old", 100), imSession("s-new", 200)])
    const found = await findSessionByConversationKey(KEY)
    expect(found?.id).toBe("s-new")
  })

  it("findSessionByConversationKey returns undefined when none bound", async () => {
    expect(await findSessionByConversationKey("nope:x:1")).toBeUndefined()
  })

  it("findSessionByConversationKey falls back to a legacy un-indexed row", async () => {
    // Legacy row: has platformBinding but no denormalized index column.
    await getDb().sessions.add({
      id: "s-legacy",
      title: "legacy",
      kind: "direct",
      platformBinding: {
        platform: "telegram",
        adapterId: "tg-1",
        conversationKey: KEY,
        conversationRef: { platform: "telegram", adapterId: "tg-1" },
      },
      createdAt: 0,
      updatedAt: 5,
    } as ChatSession)
    const found = await findSessionByConversationKey(KEY)
    expect(found?.id).toBe("s-legacy")
  })

  it("listSessionsByConversationKey returns all bound sessions newest-first", async () => {
    await getDb().sessions.bulkAdd([
      imSession("s-a", 100),
      imSession("s-b", 300),
      imSession("s-c", 200),
      imSession("other", 999, "telegram:tg-1:99"),
    ])
    const list = await listSessionsByConversationKey(KEY)
    expect(list.map((s) => s.id)).toEqual(["s-b", "s-c", "s-a"])
  })

  it("findActiveSessionForConversation honors activeSessionId", async () => {
    await getDb().sessions.bulkAdd([imSession("s-a", 300), imSession("s-b", 100)])
    const active = await findActiveSessionForConversation(KEY, { activeSessionId: "s-b" })
    expect(active?.id).toBe("s-b")
  })

  it("findActiveSessionForConversation falls back to newest when activeSessionId stale", async () => {
    await getDb().sessions.bulkAdd([imSession("s-a", 300), imSession("s-b", 100)])
    const active = await findActiveSessionForConversation(KEY, { activeSessionId: "gone" })
    expect(active?.id).toBe("s-a")
  })

  it("findActiveSessionForConversation falls back to newest with no override", async () => {
    await getDb().sessions.bulkAdd([imSession("s-a", 100), imSession("s-b", 300)])
    const active = await findActiveSessionForConversation(KEY, undefined)
    expect(active?.id).toBe("s-b")
  })

  it("findActiveSessionForConversation returns undefined when nothing bound", async () => {
    expect(await findActiveSessionForConversation(KEY, undefined)).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// listSiblingConversations (W5 multi-bot same-group collaboration)
// ─────────────────────────────────────────────────────────────────────────────

describe("listSiblingConversations", () => {
  it("returns conversations bound to the same remote chat via OTHER adapters", async () => {
    await getDb().sessions.bulkAdd([
      imSession("s-own", 100, "telegram:tg-1:42"),
      imSession("s-sib", 200, "telegram:tg-2:42"),
    ])
    const siblings = await listSiblingConversations(KEY)
    expect(siblings).toEqual([
      { adapterId: "tg-2", conversationKey: "telegram:tg-2:42", sessionId: "s-sib" },
    ])
  })

  it("excludes the origin's own adapter, other chats, and other platforms", async () => {
    await getDb().sessions.bulkAdd([
      imSession("s-own", 100, "telegram:tg-1:42"), // own adapter → excluded
      imSession("s-other-chat", 100, "telegram:tg-2:99"), // different remote chat
      imSession("s-other-platform", 100, "lark:tg-2:42"), // different platform
    ])
    expect(await listSiblingConversations(KEY)).toEqual([])
  })

  it("excludes thread-scoped (4-part) sibling keys", async () => {
    await getDb().sessions.bulkAdd([imSession("s-thread", 100, "telegram:tg-2:42:thread-7")])
    expect(await listSiblingConversations(KEY)).toEqual([])
  })

  it("dedupes multiple sessions per sibling conversation, keeping the newest", async () => {
    await getDb().sessions.bulkAdd([
      imSession("s-old", 100, "telegram:tg-2:42"),
      imSession("s-new", 300, "telegram:tg-2:42"),
      imSession("s-third-bot", 200, "telegram:tg-3:42"),
    ])
    const siblings = await listSiblingConversations(KEY)
    expect(siblings).toHaveLength(2)
    expect(siblings.find((s) => s.adapterId === "tg-2")?.sessionId).toBe("s-new")
    expect(siblings.find((s) => s.adapterId === "tg-3")?.sessionId).toBe("s-third-bot")
  })

  it("ignores sessions with unparseable keys and returns [] for an invalid origin", async () => {
    await getDb().sessions.add({
      ...imSession("s-bad", 100),
      platformConversationKey: "garbage",
    } as ChatSession)
    expect(await listSiblingConversations(KEY)).toEqual([])
    expect(await listSiblingConversations("not-a-key")).toEqual([])
  })
})
