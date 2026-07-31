/** @jest-environment jsdom */
/**
 * Tests for the v49 inbox-connectors MCP handlers.
 *
 * The send handler delegates to `runConnectorDigestTurn`, which is exercised
 * end-to-end in `lib/connectors/scheduled-outbound.test.ts`. Here we mock
 * that dependency to verify the handler's pre-flight (session lookup,
 * structured error shape) and that the read handlers fold Dexie state into
 * the projected DTOs correctly.
 */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import {
  connectorsListAdapters,
  connectorsListConversations,
  connectorsGetAudit,
  connectorsExportAudit,
  connectorsListDrafts,
  connectorsSendMessage,
  __TESTING__,
} from "./connectors"

const mockRunDigest = jest.fn()
jest.mock("@/lib/connectors/scheduled-outbound", () => ({
  runConnectorDigestTurn: (...args: unknown[]) => mockRunDigest(...args),
}))

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  mockRunDigest.mockReset()
}, 30_000)

async function seedAdapter(): Promise<void> {
  await getDb().adapterInstances.put({
    id: "tg-1",
    type: "telegram",
    displayName: "My TG Bot",
    enabled: true,
    transportMode: "longpoll",
    settings: {},
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["tg-1:botToken"] },
    trigger: {
      rules: [{ kind: "private-default" }],
      blockers: [],
      storeUnmatchedInDraftMode: false,
    },
    defaultMode: "auto",
    lastWhoamiAt: 999,
    createdAt: 0,
    updatedAt: 0,
  })
}

async function seedConversation(opts: {
  sessionId: string
  conversationKey: string
  title: string
  pinned?: boolean
  archived?: boolean
  unread?: boolean
}): Promise<void> {
  const db = getDb()
  const now = Date.now()
  await db.sessions.put({
    id: opts.sessionId,
    title: opts.title,
    modelId: "claude-sonnet-4-6",
    providerId: "anthropic",
    systemPrompt: "",
    kind: "direct",
    platformBinding: {
      platform: "telegram",
      adapterId: "tg-1",
      conversationKey: opts.conversationKey,
    },
    createdAt: now,
    updatedAt: now,
  } as unknown as Parameters<typeof db.sessions.put>[0])
  await db.conversationOverrides.put({
    id: `co-${opts.sessionId}`,
    conversationKey: opts.conversationKey,
    sessionId: opts.sessionId,
    pinned: opts.pinned,
    archived: opts.archived,
    lastReadAt: opts.unread ? 0 : now + 1_000,
    createdAt: now,
    updatedAt: now,
  })
}

describe("connectorsListAdapters", () => {
  it("returns the registered adapters projected to summary shape", async () => {
    await seedAdapter()
    const { adapters } = await connectorsListAdapters()
    expect(adapters).toHaveLength(1)
    expect(adapters[0]).toMatchObject({
      id: "tg-1",
      type: "telegram",
      displayName: "My TG Bot",
      enabled: true,
      defaultMode: "auto",
      lastWhoamiAt: 999,
    })
  })

  it("returns an empty array when no adapters are registered", async () => {
    const { adapters } = await connectorsListAdapters()
    expect(adapters).toEqual([])
  })
})

describe("connectorsListConversations", () => {
  beforeEach(async () => {
    await seedAdapter()
    await seedConversation({
      sessionId: "s1",
      conversationKey: "telegram:tg-1:c1",
      title: "Pinned + unread",
      pinned: true,
      unread: true,
    })
    await seedConversation({
      sessionId: "s2",
      conversationKey: "telegram:tg-1:c2",
      title: "Archived",
      archived: true,
    })
    await seedConversation({
      sessionId: "s3",
      conversationKey: "telegram:tg-1:c3",
      title: "Plain",
    })
  })

  it("returns every conversation by default, sorted newest-first", async () => {
    const { conversations } = await connectorsListConversations()
    expect(conversations).toHaveLength(3)
    expect(conversations.map((c) => c.title)).toContain("Pinned + unread")
  })

  it("filters by adapterId", async () => {
    const { conversations } = await connectorsListConversations({ adapterId: "tg-1" })
    expect(conversations.every((c) => c.adapterId === "tg-1")).toBe(true)
    const { conversations: other } = await connectorsListConversations({ adapterId: "missing" })
    expect(other).toEqual([])
  })

  it("pinnedOnly excludes non-pinned conversations", async () => {
    const { conversations } = await connectorsListConversations({ pinnedOnly: true })
    expect(conversations).toHaveLength(1)
    expect(conversations[0].sessionId).toBe("s1")
  })

  it("unreadOnly excludes already-read conversations", async () => {
    const { conversations } = await connectorsListConversations({ unreadOnly: true })
    expect(conversations.map((c) => c.sessionId)).toEqual(["s1"])
  })

  it("archived: false excludes archived; archived: true keeps only archived", async () => {
    const { conversations: notArchived } = await connectorsListConversations({
      archived: false,
    })
    expect(notArchived.map((c) => c.sessionId).sort()).toEqual(["s1", "s3"])
    const { conversations: archivedOnly } = await connectorsListConversations({
      archived: true,
    })
    expect(archivedOnly.map((c) => c.sessionId)).toEqual(["s2"])
  })

  it("limit clamps to [1, 200]", async () => {
    const { conversations: clampedLow } = await connectorsListConversations({ limit: 0 as never })
    expect(clampedLow.length).toBeGreaterThan(0)
    const { conversations: capped } = await connectorsListConversations({ limit: 1 })
    expect(capped).toHaveLength(1)
  })
})

describe("connectorsGetAudit", () => {
  beforeEach(async () => {
    await seedAdapter()
    await getDb().connectorAudit.bulkPut([
      { id: "a1", adapterId: "tg-1", kind: "delivery.success", at: 100, conversationKey: "k1" },
      { id: "a2", adapterId: "tg-1", kind: "delivery.error", at: 200, conversationKey: "k2" },
      { id: "a3", adapterId: "dc-1", kind: "delivery.success", at: 150 },
    ])
  })

  it("returns newest-first by default", async () => {
    const { rows } = await connectorsGetAudit({})
    expect(rows[0].id).toBe("a2")
  })

  it("filters by adapterId", async () => {
    const { rows } = await connectorsGetAudit({ adapterId: "dc-1" })
    expect(rows.map((r) => r.id)).toEqual(["a3"])
  })

  it("filters by conversationKey after the index hit", async () => {
    const { rows } = await connectorsGetAudit({ adapterId: "tg-1", conversationKey: "k1" })
    expect(rows.map((r) => r.id)).toEqual(["a1"])
  })

  it("limit clamps to [1, 500]", async () => {
    const { rows } = await connectorsGetAudit({ limit: 1 })
    expect(rows).toHaveLength(1)
  })
})

describe("connectorsExportAudit", () => {
  beforeEach(async () => {
    await seedAdapter()
    await getDb().connectorAudit.put({
      id: "x",
      adapterId: "tg-1",
      kind: "delivery.success",
      at: 100,
      conversationKey: "k1",
    })
  })

  it("returns CSV body with header row", async () => {
    const out = await connectorsExportAudit({ format: "csv" })
    expect(out.format).toBe("csv")
    expect(out.body.split("\n")[0]).toBe(
      "at,adapterId,kind,reason,conversationKey,idempotencyKey,message,fields"
    )
    expect(out.rowCount).toBe(1)
  })

  it("returns JSON body that parses back to the rows", async () => {
    const out = await connectorsExportAudit({ format: "json" })
    expect(out.format).toBe("json")
    expect(JSON.parse(out.body)).toHaveLength(1)
  })
})

describe("connectorsListDrafts", () => {
  it("returns drafts with a 240-char text preview", async () => {
    const longText = "x".repeat(500)
    await getDb().connectorDrafts.put({
      id: "d1",
      conversationKey: "telegram:tg-1:c1",
      sessionId: "s1",
      segments: [{ type: "text", text: longText }],
      status: "pending",
      createdAt: 1000,
    })
    const { drafts } = await connectorsListDrafts()
    expect(drafts).toHaveLength(1)
    expect(drafts[0].textPreview.length).toBeLessThanOrEqual(240)
  })

  it("extractTextPreview handles markdown segments", () => {
    expect(__TESTING__.extractTextPreview([{ type: "markdown", md: "**bold**" }])).toBe("**bold**")
  })
})

describe("connectorsSendMessage", () => {
  it("returns session_missing when no bound ChatSession exists", async () => {
    const out = await connectorsSendMessage({
      adapterId: "tg-1",
      conversationKey: "telegram:tg-1:ghost",
      prompt: "hello",
    })
    expect(out.ok).toBe(false)
    expect(out.reason).toBe("session_missing")
    expect(mockRunDigest).not.toHaveBeenCalled()
  })

  it("delegates to runConnectorDigestTurn when the session exists", async () => {
    await seedConversation({
      sessionId: "s-send",
      conversationKey: "telegram:tg-1:csend",
      title: "Send target",
    })
    mockRunDigest.mockResolvedValueOnce({ success: true, output: { messageId: "m1" } })
    const out = await connectorsSendMessage({
      adapterId: "tg-1",
      conversationKey: "telegram:tg-1:csend",
      prompt: "hi",
    })
    expect(out.ok).toBe(true)
    expect(out.detail).toEqual({ messageId: "m1" })
    expect(mockRunDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "tg-1",
        conversationKey: "telegram:tg-1:csend",
        prompt: "hi",
        sourceTaskId: "external-bridge",
      })
    )
  })

  it("propagates digest errors as a structured ok:false response", async () => {
    await seedConversation({
      sessionId: "s-err",
      conversationKey: "telegram:tg-1:cerr",
      title: "Err target",
    })
    mockRunDigest.mockResolvedValueOnce({ success: false, error: "pii_blocked" })
    const out = await connectorsSendMessage({
      adapterId: "tg-1",
      conversationKey: "telegram:tg-1:cerr",
      prompt: "leak alice@example.com",
    })
    expect(out.ok).toBe(false)
    expect(out.reason).toBe("pii_blocked")
  })
})

describe("clamp", () => {
  it("clamps to [min, max]", () => {
    expect(__TESTING__.clamp(0, 1, 10)).toBe(1)
    expect(__TESTING__.clamp(15, 1, 10)).toBe(10)
    expect(__TESTING__.clamp(5, 1, 10)).toBe(5)
  })
})
