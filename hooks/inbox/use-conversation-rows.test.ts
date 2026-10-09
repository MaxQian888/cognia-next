/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import {
  CONVERSATION_PREVIEW_MAX,
  buildConversationRows,
  filterConversationSessions,
  loadConversationRows,
  needsPreviewFallback,
  useConversationRows,
} from "./use-conversation-rows"

let mockActiveProjectId: string | null = null
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: <T>(selector: (s: { activeProjectId: string | null }) => T): T =>
    selector({ activeProjectId: mockActiveProjectId }),
}))

function session(
  id: string,
  opts: Partial<ChatSession> & { adapterId?: string; platform?: string } = {}
): ChatSession {
  const { adapterId = "a1", platform = "telegram", ...rest } = opts
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    platformBinding: {
      adapterId,
      platform,
      conversationKey: `${platform}:${adapterId}:${id}`,
      conversationRef: { platform, adapterId },
    },
    ...rest,
  } as unknown as ChatSession
}

describe("filterConversationSessions", () => {
  const rows = [
    session("plain"),
    session("other-adapter", { adapterId: "a2" }),
    session("other-platform", { platform: "lark" }),
    session("project-a", { projectId: "A" } as Partial<ChatSession>),
    session("project-b", { projectId: "B" } as Partial<ChatSession>),
    { id: "unbound", title: "x", createdAt: 1, updatedAt: 1 } as unknown as ChatSession,
  ]
  const ids = (list: ChatSession[]) => list.map((s) => s.id)

  it("keeps only platform-bound sessions", () => {
    expect(ids(filterConversationSessions(rows, {}))).not.toContain("unbound")
  })

  it("isolates the active workspace but grandfathers sessions without one", () => {
    expect(ids(filterConversationSessions(rows, { activeProjectId: "A" }))).toEqual([
      "plain",
      "other-adapter",
      "other-platform",
      "project-a",
    ])
  })

  it("narrows to the adapter and platform scope", () => {
    expect(ids(filterConversationSessions(rows, { adapterId: "a2" }))).toEqual(["other-adapter"])
    expect(ids(filterConversationSessions(rows, { platformKind: "lark" }))).toEqual([
      "other-platform",
    ])
  })
})

describe("buildConversationRows", () => {
  it("uses the denormalized preview and joins overrides and unread counts", () => {
    const s = session("s1", { lastMessagePreview: "hi", lastMessageAt: 9 })
    const override = {
      conversationKey: "telegram:a1:s1",
      status: "pending",
    } as ConversationOverrideRow
    const [row] = buildConversationRows([s], [override], [{ sessionId: "s1", unreadCount: 3 }])
    expect(row).toMatchObject({
      override,
      unreadCount: 3,
      lastMessagePreview: "hi",
      lastMessageAt: 9,
    })
  })

  it("uses the fallback only for never-stamped sessions", () => {
    const stamped = session("stamped", { lastMessagePreview: "", lastMessageAt: 4 })
    const legacy = session("legacy")
    const rows = buildConversationRows(
      [stamped, legacy],
      [],
      [],
      new Map([
        ["stamped", { preview: "ignored", at: 99 }],
        ["legacy", { preview: "from messages", at: 7 }],
      ])
    )
    expect(rows[0]).toMatchObject({ lastMessagePreview: "", lastMessageAt: 4 })
    expect(rows[1]).toMatchObject({ lastMessagePreview: "from messages", lastMessageAt: 7 })
  })

  it("clamps a negative unread count to zero and caps the preview", () => {
    const s = session("s1", { lastMessagePreview: "x".repeat(500), lastMessageAt: 1 })
    const [row] = buildConversationRows([s], [], [{ sessionId: "s1", unreadCount: -2 }])
    expect(row!.unreadCount).toBe(0)
    expect(row!.lastMessagePreview).toHaveLength(CONVERSATION_PREVIEW_MAX)
  })

  it("flags only sessions without a stamped timestamp", () => {
    expect(needsPreviewFallback(session("a"))).toBe(true)
    expect(needsPreviewFallback(session("b", { lastMessageAt: 0 }))).toBe(false)
  })
})

describe("against Dexie", () => {
  const fixture = createDbTestFixture()
  beforeAll(fixture.initialize)
  beforeEach(async () => {
    await fixture.restore()
    mockActiveProjectId = null
  })
  afterAll(fixture.dispose)

  async function seed() {
    const db = getDb()
    await db.sessions.bulkPut([
      session("stamped", { lastMessagePreview: "stamped preview", lastMessageAt: 50 }),
      session("legacy", { adapterId: "a2" }),
      session("legacy-empty", { platform: "lark" }),
    ] as never)
    await db.messages.bulkPut([
      {
        id: "m-old",
        sessionId: "legacy",
        role: "user",
        parts: [{ type: "text", text: "older" }],
        createdAt: 10,
      },
      {
        id: "m-new",
        sessionId: "legacy",
        role: "user",
        parts: [{ type: "text", text: "newest legacy" }],
        createdAt: 20,
      },
      {
        // Must never be read: the stamped session's preview is authoritative.
        id: "m-stamped",
        sessionId: "stamped",
        role: "user",
        parts: [{ type: "text", text: "not this" }],
        createdAt: 60,
      },
    ] as never)
    await db.sessionState.put({ sessionId: "legacy", unreadCount: 2, lastReadAt: 0 })
  }

  it("loads rows, falling back to the message table only for legacy sessions", async () => {
    await seed()
    const rows = await loadConversationRows({})
    const byId = new Map(rows.map((row) => [row.session.id, row]))
    expect(byId.get("stamped")).toMatchObject({
      lastMessagePreview: "stamped preview",
      lastMessageAt: 50,
    })
    expect(byId.get("legacy")).toMatchObject({
      lastMessagePreview: "newest legacy",
      lastMessageAt: 20,
      unreadCount: 2,
    })
    expect(byId.get("legacy-empty")).toMatchObject({
      lastMessagePreview: undefined,
      lastMessageAt: undefined,
    })
  })

  it("applies the scope", async () => {
    await seed()
    const rows = await loadConversationRows({ adapterId: "a2" })
    expect(rows.map((row) => row.session.id)).toEqual(["legacy"])
  })

  it("serves the rows through the live hook", async () => {
    await seed()
    const { result } = renderHook(() => useConversationRows({ platformKind: "lark" }))
    await waitFor(() => expect(result.current.rows).toBeDefined())
    expect(result.current.rows!.map((row) => row.session.id)).toEqual(["legacy-empty"])
    expect(result.current.error).toBeNull()
  })

  it("captures a failed read instead of throwing past the pane boundaries, and retries", async () => {
    await seed()
    const spy = jest
      .spyOn(getDb().conversationOverrides, "toArray")
      .mockRejectedValueOnce(new Error("TransactionInactiveError"))
    const { result } = renderHook(() => useConversationRows())
    await waitFor(() => expect(result.current.error?.message).toBe("TransactionInactiveError"))
    expect(result.current.rows).toBeUndefined()
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.rows).toHaveLength(3))
    expect(result.current.error).toBeNull()
    spy.mockRestore()
  })
})
