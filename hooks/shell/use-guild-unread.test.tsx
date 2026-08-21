/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

const listSessionStates = jest.fn()
const markSessionRead = jest.fn()
const bulkGet = jest.fn()
jest.mock("@/lib/db/session-state", () => ({
  listSessionStates: () => listSessionStates(),
  markSessionRead: (id: string) => markSessionRead(id),
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ sessions: { bulkGet: (ids: string[]) => bulkGet(ids) } }),
}))

let showUnreadBadges: boolean | undefined = undefined
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: unknown }) => T): T =>
    selector({ settings: { conversationSidebar: { showUnreadBadges } } }),
}))

// `useClientLiveQuery` resolves the query once and hands back its value; the
// live re-run on table change is Dexie's contract, not this hook's.
let liveValue: unknown = undefined
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: () => liveValue,
}))

import type { UnreadSession } from "./use-guild-unread"
import {
  aggregateGuildUnread,
  loadGuildUnread,
  markGuildRead,
  useGuildUnread,
} from "./use-guild-unread"

// Typed: an untyped `over` widened `kind` to `string`, which the hook's own
// `UnreadSession` (a `Pick` of `ChatSession`) will not accept.
const session = (id: string, over: Partial<UnreadSession> = {}): UnreadSession => ({
  id,
  kind: "direct",
  ...over,
})

beforeEach(() => {
  listSessionStates.mockReset()
  markSessionRead.mockReset().mockResolvedValue(undefined)
  bulkGet.mockReset()
  showUnreadBadges = undefined
  liveValue = undefined
})

describe("aggregateGuildUnread", () => {
  it("files each unread conversation under its guild and sums the total", () => {
    const unread = new Map([
      ["d1", 3],
      ["d2", 1],
      ["t1", 2],
      ["t2", 5],
    ])
    const result = aggregateGuildUnread(
      [
        session("d1"),
        session("d2"),
        session("t1", { kind: "team", teamId: "team-a" }),
        session("t2", { kind: "team", teamId: "team-a" }),
      ],
      unread
    )
    // Conversations, not messages: a chat with 3 unread messages is one row.
    expect(result.dm).toBe(2)
    expect(result.teams.get("team-a")).toBe(2)
    expect(result.total).toBe(4)
  })

  it("skips archived, hidden and unresolved sessions", () => {
    const unread = new Map([
      ["a", 1],
      ["b", 1],
      ["c", 1],
      ["d", 1],
      ["e", 1],
    ])
    const result = aggregateGuildUnread(
      [
        session("a", { archivedAt: 123 }),
        session("b", { kind: "subagent" }),
        session("c", { kind: "workflow-editor" }),
        undefined, // "d" was deleted after its unread row was written
        session("e"),
        session("not-unread"), // no unread row → not counted
      ],
      unread
    )
    expect(result).toEqual({ dm: 1, teams: new Map(), total: 1 })
  })

  it("counts a team session without a teamId as a direct conversation", () => {
    const result = aggregateGuildUnread([session("x", { kind: "team" })], new Map([["x", 1]]))
    expect(result.dm).toBe(1)
    expect(result.teams.size).toBe(0)
  })
})

describe("loadGuildUnread", () => {
  it("returns the empty aggregate without touching sessions when nothing is unread", async () => {
    listSessionStates.mockResolvedValue([{ sessionId: "s", unreadCount: 0, lastReadAt: 1 }])
    const result = await loadGuildUnread()
    expect(result).toEqual({ dm: 0, teams: new Map(), total: 0 })
    expect(bulkGet).not.toHaveBeenCalled()
  })

  it("resolves only the sessions with unread rows", async () => {
    listSessionStates.mockResolvedValue([
      { sessionId: "read", unreadCount: 0, lastReadAt: 1 },
      { sessionId: "t1", unreadCount: 2, lastReadAt: 1 },
      { sessionId: "d1", unreadCount: 1, lastReadAt: 1 },
    ])
    bulkGet.mockResolvedValue([session("t1", { kind: "team", teamId: "team-b" }), session("d1")])
    const result = await loadGuildUnread()
    expect(bulkGet).toHaveBeenCalledWith(["t1", "d1"])
    expect(result.dm).toBe(1)
    expect(result.teams.get("team-b")).toBe(1)
    expect(result.total).toBe(2)
  })
})

describe("markGuildRead", () => {
  const states = [
    { sessionId: "read", unreadCount: 0, lastReadAt: 1 },
    { sessionId: "d1", unreadCount: 1, lastReadAt: 1 },
    { sessionId: "d-archived", unreadCount: 1, lastReadAt: 1 },
    { sessionId: "t1", unreadCount: 2, lastReadAt: 1 },
    { sessionId: "t-other", unreadCount: 2, lastReadAt: 1 },
    { sessionId: "sub", unreadCount: 2, lastReadAt: 1 },
  ]
  const rows = [
    session("d1"),
    session("d-archived", { archivedAt: 5 }),
    session("t1", { kind: "team", teamId: "team-a" }),
    session("t-other", { kind: "team", teamId: "team-b" }),
    session("sub", { kind: "subagent" }),
  ]

  it("clears exactly the direct conversations the DM badge counted", async () => {
    listSessionStates.mockResolvedValue(states)
    bulkGet.mockResolvedValue(rows)
    await expect(markGuildRead({ kind: "dm" })).resolves.toBe(1)
    expect(markSessionRead.mock.calls.map(([id]) => id)).toEqual(["d1"])
  })

  it("clears exactly one team's conversations", async () => {
    listSessionStates.mockResolvedValue(states)
    bulkGet.mockResolvedValue(rows)
    await expect(markGuildRead({ kind: "team", teamId: "team-a" })).resolves.toBe(1)
    expect(markSessionRead.mock.calls.map(([id]) => id)).toEqual(["t1"])
  })

  it("does nothing when nothing is unread", async () => {
    listSessionStates.mockResolvedValue([{ sessionId: "read", unreadCount: 0, lastReadAt: 1 }])
    await expect(markGuildRead({ kind: "dm" })).resolves.toBe(0)
    expect(bulkGet).not.toHaveBeenCalled()
    expect(markSessionRead).not.toHaveBeenCalled()
  })
})

function Probe() {
  const unread = useGuildUnread()
  return (
    <div data-testid="probe">
      {unread.dm}/{unread.teams.get("team-a") ?? 0}/{unread.total}
    </div>
  )
}

describe("useGuildUnread", () => {
  it("exposes the live aggregate", () => {
    liveValue = { dm: 2, teams: new Map([["team-a", 3]]), total: 5 }
    render(<Probe />)
    expect(screen.getByTestId("probe")).toHaveTextContent("2/3/5")
  })

  it("is empty before the first read lands", () => {
    liveValue = undefined
    render(<Probe />)
    expect(screen.getByTestId("probe")).toHaveTextContent("0/0/0")
  })

  it("goes dark with the unread-badge display setting", () => {
    liveValue = { dm: 2, teams: new Map([["team-a", 3]]), total: 5 }
    showUnreadBadges = false
    render(<Probe />)
    expect(screen.getByTestId("probe")).toHaveTextContent("0/0/0")
  })
})
