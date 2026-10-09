import type { ChatSession } from "@cognia/agent-config-types"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import {
  conversationActivityAt,
  conversationSectionId,
  groupConversationRows,
  orderByTriagePriority,
  summarizeConversationRows,
  visibleConversationRows,
  type ConversationRowItem,
} from "./conversation-grouping"

interface RowOpts {
  adapterId?: string
  platform?: string
  updatedAt?: number
  lastMessageAt?: number
  pinned?: boolean
  unread?: number
  archived?: boolean
  status?: ConversationOverrideRow["status"]
}

function row(id: string, opts: RowOpts = {}): ConversationRowItem {
  const adapterId = opts.adapterId ?? "a1"
  const platform = opts.platform ?? "telegram"
  const session = {
    id,
    title: id,
    createdAt: 0,
    updatedAt: opts.updatedAt ?? 0,
    pinned: opts.pinned,
    archivedAt: opts.archived ? 1 : undefined,
    platformBinding: {
      adapterId,
      platform,
      conversationKey: `${platform}:${adapterId}:${id}`,
      conversationRef: { platform, adapterId },
    },
  } as unknown as ChatSession
  return {
    session,
    override: opts.status
      ? ({ conversationKey: id, status: opts.status } as ConversationOverrideRow)
      : undefined,
    unreadCount: opts.unread ?? 0,
    lastMessageAt: opts.lastMessageAt,
  }
}

const ids = (rows: ConversationRowItem[]) => rows.map((r) => r.session.id)

describe("groupConversationRows — status", () => {
  it("splits live rows into pinned, unread and read, newest first", () => {
    const sections = groupConversationRows(
      [
        row("read-old", { updatedAt: 1 }),
        row("unread", { updatedAt: 5, unread: 2 }),
        row("pinned", { updatedAt: 0, pinned: true, unread: 3 }),
        row("read-new", { updatedAt: 9 }),
      ],
      "status"
    )
    expect(sections.map((s) => s.id)).toEqual(["status:pinned", "status:unread", "status:read"])
    expect(ids(sections[0]!.rows)).toEqual(["pinned"])
    expect(ids(sections[1]!.rows)).toEqual(["unread"])
    expect(ids(sections[2]!.rows)).toEqual(["read-new", "read-old"])
    expect(sections[0]!.unreadCount).toBe(1)
  })

  it("drops empty sections", () => {
    const sections = groupConversationRows([row("r")], "status")
    expect(sections.map((s) => s.kind)).toEqual(["read"])
  })

  it("orders by the newest message when it is newer than the session row", () => {
    const sections = groupConversationRows(
      [row("a", { updatedAt: 5 }), row("b", { updatedAt: 1, lastMessageAt: 10 })],
      "status"
    )
    expect(ids(sections[0]!.rows)).toEqual(["b", "a"])
  })
})

describe("groupConversationRows — tails", () => {
  it("moves resolved then archived rows into collapsed tail sections", () => {
    const sections = groupConversationRows(
      [
        row("archived-and-resolved", { archived: true, status: "resolved" }),
        row("resolved", { status: "resolved" }),
        row("live"),
      ],
      "status"
    )
    expect(sections.map((s) => [s.id, s.tail, s.collapsed])).toEqual([
      ["status:read", false, false],
      ["resolved", true, true],
      ["archived", true, true],
    ])
    // Archived wins: it is out of the inbox whatever its status says.
    expect(ids(sections[2]!.rows)).toEqual(["archived-and-resolved"])
  })

  it("honours stored collapse choices over the defaults", () => {
    const sections = groupConversationRows(
      [row("live"), row("resolved", { status: "resolved" })],
      "status",
      { collapsed: { "status:read": true, resolved: false } }
    )
    expect(sections.map((s) => s.collapsed)).toEqual([true, false])
  })

  it("keeps pending and snoozed conversations in the live sections", () => {
    const sections = groupConversationRows(
      [row("p", { status: "pending" }), row("s", { status: "snoozed" })],
      "status"
    )
    expect(sections).toHaveLength(1)
    expect(sections[0]!.rows).toHaveLength(2)
  })
})

describe("groupConversationRows — adapter", () => {
  const adapters = [
    { id: "a2", displayName: "Support bot", type: "lark" },
    { id: "a1", displayName: "Sales bot", type: "telegram" },
  ]

  it("makes one section per adapter in the sidebar's order, unknown adapters last", () => {
    const sections = groupConversationRows(
      [
        row("x", { adapterId: "zzz", platform: "slack" }),
        row("y", { adapterId: "a1" }),
        row("z", { adapterId: "a2", platform: "lark" }),
      ],
      "adapter",
      { adapters }
    )
    expect(sections.map((s) => s.id)).toEqual(["adapter:a2", "adapter:a1", "adapter:zzz"])
    expect(sections[0]).toMatchObject({ adapterName: "Support bot", platform: "lark" })
    // A deleted adapter still gets a section, labelled from the row's binding.
    expect(sections[2]).toMatchObject({ adapterName: undefined, platform: "slack" })
  })

  it("keeps pinned → unread → read order inside each section", () => {
    const sections = groupConversationRows(
      [
        row("read", { updatedAt: 9 }),
        row("unread", { unread: 1, updatedAt: 1 }),
        row("pinned", { pinned: true, updatedAt: 0 }),
      ],
      "adapter",
      { adapters }
    )
    expect(ids(sections[0]!.rows)).toEqual(["pinned", "unread", "read"])
  })
})

describe("groupConversationRows — platform", () => {
  it("orders platforms by the adapters list, then alphabetically", () => {
    const sections = groupConversationRows(
      [
        row("d", { platform: "discord" }),
        row("t", { platform: "telegram" }),
        row("b", { platform: "slack" }),
        row("l", { platform: "lark" }),
      ],
      "platform",
      {
        adapters: [
          { id: "1", displayName: "x", type: "telegram" },
          { id: "2", displayName: "y", type: "telegram" },
          { id: "3", displayName: "z", type: "lark" },
        ],
      }
    )
    expect(sections.map((s) => s.id)).toEqual([
      "platform:telegram",
      "platform:lark",
      "platform:discord",
      "platform:slack",
    ])
    expect(sections[0]!.platform).toBe("telegram")
  })
})

describe("helpers", () => {
  it("builds stable section ids", () => {
    expect(conversationSectionId.status("unread")).toBe("status:unread")
    expect(conversationSectionId.adapter("a1")).toBe("adapter:a1")
    expect(conversationSectionId.platform("lark")).toBe("platform:lark")
    expect(conversationSectionId.tail("archived")).toBe("archived")
  })

  it("orders by triage priority", () => {
    expect(
      ids(orderByTriagePriority([row("r"), row("u", { unread: 1 }), row("p", { pinned: true })]))
    ).toEqual(["p", "u", "r"])
  })

  it("reads activity from the newer of the message and the session row", () => {
    expect(conversationActivityAt(row("a", { updatedAt: 3, lastMessageAt: 7 }))).toBe(7)
    expect(conversationActivityAt(row("a", { updatedAt: 9, lastMessageAt: 7 }))).toBe(9)
  })

  it("flattens only expanded sections", () => {
    const sections = groupConversationRows(
      [row("live"), row("res", { status: "resolved" })],
      "status"
    )
    expect(ids(visibleConversationRows(sections))).toEqual(["live"])
  })

  it("summarizes the live rows only", () => {
    expect(
      summarizeConversationRows([
        row("u", { unread: 2 }),
        row("p", { status: "pending" }),
        row("s", { status: "snoozed", unread: 1 }),
        row("r", { status: "resolved", unread: 1 }),
        row("a", { archived: true }),
      ])
    ).toEqual({ total: 3, unread: 2, pending: 1, snoozed: 1 })
  })
})
