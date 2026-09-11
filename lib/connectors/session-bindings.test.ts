/**
 * Tests for lib/connectors/session-bindings.ts — IM conversation ↔ ChatSession
 * binding lookups (control-plane multi-session).
 */

import {
  migrateLegacyConversationListState,
  resolveConversationLinkSession,
  findSessionByConversationKey,
  listSessionsByConversationKey,
  findActiveSessionForConversation,
  createPlatformSession,
  refreshPlatformSessionBinding,
  listSiblingConversations,
} from "./session-bindings"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import type { ChatSession } from "@cognia/agent-config-types"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

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
    conversationAddress: {
      conversationKey: KEY,
      platform: "telegram",
      adapterId: "tg-1",
      scopeKind: "private",
      containerId: "42",
    },
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
    expect(session.platformBinding?.deliveryTarget?.sourceMessageId).toBe("m1")
    const stored = await getDb().sessions.get(session.id)
    expect(stored?.platformConversationKey).toBe(KEY)
  })

  it("refreshes the delivery anchor on every later inbound message", async () => {
    const session = await createPlatformSession(makeEvent(), "char_1")
    const next = makeEvent()
    next.messageId = "m2"
    next.timestamp = 2_000
    next.conversationRef = {
      ...next.conversationRef,
      threadRootMessageId: "m2",
    }

    const refreshed = await refreshPlatformSessionBinding(session, next)
    expect(refreshed.platformBinding?.deliveryTarget?.sourceMessageId).toBe("m2")
    expect((await getDb().sessions.get(session.id))?.platformBinding?.conversationRef).toEqual(
      next.conversationRef
    )
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

describe("resolveConversationLinkSession", () => {
  it("honors the remote active session instead of choosing the newest", async () => {
    const db = getDb()
    await db.sessions.bulkAdd([imSession("old", 1), imSession("new", 2)])
    await db.conversationOverrides.add({
      id: "o",
      conversationKey: KEY,
      sessionId: "old",
      activeSessionId: "old",
      createdAt: 1,
      updatedAt: 1,
    })
    expect((await resolveConversationLinkSession(KEY))?.id).toBe("old")
  })
  it("opens an explicit historical session and rejects another conversation", async () => {
    await getDb().sessions.bulkAdd([
      imSession("old", 1),
      imSession("new", 2),
      imSession("other", 3, "telegram:tg-1:99"),
    ])
    expect((await resolveConversationLinkSession(KEY, { sessionId: "old" }))?.id).toBe("old")
    expect(await resolveConversationLinkSession(KEY, { sessionId: "other" })).toBeUndefined()
    expect(await resolveConversationLinkSession(KEY, { sessionId: "deleted" })).toBeUndefined()
  })
  it("resolves a message to its owner and rejects contradictory explicit targets", async () => {
    await getDb().sessions.bulkAdd([imSession("old", 1), imSession("new", 2)])
    await getDb().messages.add({ id: "m", sessionId: "old", role: "user", parts: [], createdAt: 1 })
    expect((await resolveConversationLinkSession(KEY, { messageId: "m" }))?.id).toBe("old")
    expect(
      (await resolveConversationLinkSession(KEY, { sessionId: "old", messageId: "m" }))?.id
    ).toBe("old")
    expect(
      await resolveConversationLinkSession(KEY, { sessionId: "new", messageId: "m" })
    ).toBeUndefined()
    expect(
      await resolveConversationLinkSession("telegram:tg-1:99", { messageId: "m" })
    ).toBeUndefined()
    expect(await resolveConversationLinkSession(KEY, { messageId: "deleted" })).toBeUndefined()
  })
})

describe("legacy conversation list state", () => {
  it("preserves old Inbox preferences once and never resurrects a canonical clear", async () => {
    const db = getDb()
    await db.sessions.add(imSession("s", 2))
    await db.conversationOverrides.add({
      id: "o",
      conversationKey: KEY,
      sessionId: "s",
      createdAt: 1,
      updatedAt: 3,
      pinned: true,
      archived: true,
      lastReadAt: 1,
    })
    await db.messages.add({
      id: "legacy-in",
      sessionId: "s",
      role: "user",
      parts: [],
      createdAt: 2,
      metadata: {
        platformMessage: {
          platform: "telegram",
          adapterId: "tg-1",
          conversationKey: KEY,
          messageId: "remote",
          sender: { remoteUserId: "human" },
        },
      },
    } as never)
    await migrateLegacyConversationListState()
    expect(await db.sessions.get("s")).toMatchObject({ pinned: true, archivedAt: 3 })
    expect(await db.sessionState.get("s")).toMatchObject({ lastReadAt: 1, unreadCount: 1 })
    expect(await db.conversationOverrides.get("o")).not.toHaveProperty("pinned")
    await db.sessions
      .where("id")
      .equals("s")
      .modify((session) => {
        session.pinned = false
        delete session.archivedAt
      })
    await db.sessionState.update("s", { unreadCount: 0, lastReadAt: 4 })
    await migrateLegacyConversationListState()
    expect(await db.sessions.get("s")).toMatchObject({ pinned: false })
    expect(await db.sessions.get("s")).not.toHaveProperty("archivedAt")
    expect(await db.sessionState.get("s")).toMatchObject({ unreadCount: 0, lastReadAt: 4 })
  })
  it("preserves existing canonical false and explicit mutation scopes", async () => {
    const db = getDb()
    await db.sessions.bulkAdd([{ ...imSession("s", 2), pinned: false }, imSession("other", 1)])
    await db.conversationOverrides.add({
      id: "o",
      conversationKey: KEY,
      sessionId: "s",
      createdAt: 1,
      updatedAt: 3,
      pinned: true,
    })
    await migrateLegacyConversationListState()
    expect((await db.sessions.get("s"))?.pinned).toBe(false)
    await db.conversationOverrides.update("o", { pinned: false, archived: true })
    await migrateLegacyConversationListState({
      conversationKey: KEY,
      sessionId: "s",
      overwrite: true,
    })
    expect(await db.sessions.get("s")).toMatchObject({
      pinned: false,
      archivedAt: expect.any(Number),
    })
    expect(await db.sessions.get("other")).not.toHaveProperty("archivedAt")
  })
})

it("initializes real inbound unread for a legacy IM session without any override", async () => {
  const db = getDb()
  await db.sessions.add(imSession("no-override", 1))
  await db.messages.bulkAdd([
    {
      id: "remote",
      sessionId: "no-override",
      role: "user",
      createdAt: 2,
      parts: [],
      metadata: { platformMessage: { messageId: "remote" } },
    },
    { id: "local", sessionId: "no-override", role: "user", createdAt: 2, parts: [] },
    { id: "assistant", sessionId: "no-override", role: "assistant", createdAt: 2, parts: [] },
  ] as never[])
  await migrateLegacyConversationListState()
  expect(await db.sessionState.get("no-override")).toMatchObject({ unreadCount: 1 })
})
