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
let sidebarExtras: Record<string, unknown> = {}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: unknown }) => T): T =>
    selector({ settings: { conversationSidebar: { showUnreadBadges, ...sidebarExtras } } }),
}))

let projectState: { activeProjectId: string | null; loaded: boolean } = {
  activeProjectId: "p1",
  loaded: true,
}
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: <T,>(selector: (s: typeof projectState) => T): T => selector(projectState),
}))

// The window's shared unread read (its store is pinned in
// `lib/chat/unread-sessions.test.ts`); `null` is "not read yet".
let liveValue: {
  sessions: UnreadSession[]
  unreadBySession: Map<string, number>
} | null = null
const subscribeCount = { current: 0 }
jest.mock("@/hooks/shell/use-unread-sessions", () => ({
  useUnreadSessions: () => {
    subscribeCount.current += 1
    return liveValue
  },
}))

import type { GuildUnreadScope, UnreadSession } from "./use-guild-unread"
import {
  ALL_WORKSPACES_SCOPE,
  aggregateGuildUnread,
  isInGuildUnreadScope,
  loadGuildUnread,
  markGuildRead,
  useGuildUnread,
  useGuildUnreadScope,
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
  sidebarExtras = {}
  projectState = { activeProjectId: "p1", loaded: true }
  liveValue = null
  subscribeCount.current = 0
})

const ALL = ALL_WORKSPACES_SCOPE
const P1: GuildUnreadScope = { kind: "workspace", projectId: "p1" }

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

describe("isInGuildUnreadScope", () => {
  it("admits everything across all workspaces", () => {
    expect(isInGuildUnreadScope({ projectId: "p2" }, ALL)).toBe(true)
  })

  it("admits the workspace's own and workspace-less conversations, like listWorkspaceSessions", () => {
    expect(isInGuildUnreadScope({ projectId: "p1" }, P1)).toBe(true)
    expect(isInGuildUnreadScope({ projectId: undefined }, P1)).toBe(true)
    expect(isInGuildUnreadScope({ projectId: "p2" }, P1)).toBe(false)
  })

  it("admits nothing before the active workspace is known", () => {
    expect(
      isInGuildUnreadScope({ projectId: undefined }, { kind: "workspace", projectId: null })
    ).toBe(false)
  })
})

describe("aggregateGuildUnread scope", () => {
  it("counts only conversations the scoped list would show", () => {
    const unread = new Map([
      ["here", 1],
      ["elsewhere", 1],
      ["nowhere", 1],
    ])
    const rows = [
      session("here", { projectId: "p1" }),
      session("elsewhere", { projectId: "p2" }),
      session("nowhere"),
    ]
    expect(aggregateGuildUnread(rows, unread, P1).dm).toBe(2)
    expect(aggregateGuildUnread(rows, unread, ALL).dm).toBe(3)
  })
})

describe("loadGuildUnread", () => {
  it("reads nothing while the active workspace is unknown", async () => {
    const result = await loadGuildUnread({ kind: "workspace", projectId: null })
    expect(result.total).toBe(0)
    expect(listSessionStates).not.toHaveBeenCalled()
  })

  it("returns the empty aggregate without touching sessions when nothing is unread", async () => {
    listSessionStates.mockResolvedValue([{ sessionId: "s", unreadCount: 0, lastReadAt: 1 }])
    const result = await loadGuildUnread(ALL)
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
    const result = await loadGuildUnread(ALL)
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
    await expect(markGuildRead({ kind: "dm" }, ALL)).resolves.toBe(1)
    expect(markSessionRead.mock.calls.map(([id]) => id)).toEqual(["d1"])
  })

  it("clears exactly one team's conversations", async () => {
    listSessionStates.mockResolvedValue(states)
    bulkGet.mockResolvedValue(rows)
    await expect(markGuildRead({ kind: "team", teamId: "team-a" }, ALL)).resolves.toBe(1)
    expect(markSessionRead.mock.calls.map(([id]) => id)).toEqual(["t1"])
  })

  it("leaves other workspaces' unread state alone", async () => {
    listSessionStates.mockResolvedValue([
      { sessionId: "d1", unreadCount: 1, lastReadAt: 1 },
      { sessionId: "d-other", unreadCount: 1, lastReadAt: 1 },
    ])
    bulkGet.mockResolvedValue([
      session("d1", { projectId: "p1" }),
      session("d-other", { projectId: "p2" }),
    ])
    await expect(markGuildRead({ kind: "dm" }, P1)).resolves.toBe(1)
    expect(markSessionRead.mock.calls.map(([id]) => id)).toEqual(["d1"])
  })

  it("does nothing when nothing is unread", async () => {
    listSessionStates.mockResolvedValue([{ sessionId: "read", unreadCount: 0, lastReadAt: 1 }])
    await expect(markGuildRead({ kind: "dm" }, ALL)).resolves.toBe(0)
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

/** A read with one DM in p1, one in p2, one with no workspace and two team-a rows. */
function seedRead(): void {
  const sessions: UnreadSession[] = [
    session("d-p1", { projectId: "p1" }),
    session("d-p2", { projectId: "p2" }),
    session("d-none"),
    session("t1", { kind: "team", teamId: "team-a", projectId: "p1" }),
    session("t2", { kind: "team", teamId: "team-a", projectId: "p2" }),
  ]
  liveValue = { sessions, unreadBySession: new Map(sessions.map((row) => [row.id, 1])) }
}

describe("useGuildUnread", () => {
  it("aggregates the shared read", () => {
    seedRead()
    render(<Probe />)
    // Default grouping spans every workspace.
    expect(screen.getByTestId("probe")).toHaveTextContent("3/2/5")
  })

  it("is empty before the first read lands", () => {
    liveValue = null
    render(<Probe />)
    expect(screen.getByTestId("probe")).toHaveTextContent("0/0/0")
  })

  it("scopes to the active workspace when the list groups on a single-workspace axis", () => {
    seedRead()
    sidebarExtras = { groupBy: "team" }
    render(<Probe />)
    // p1's own DM plus the workspace-less one; p1's team row.
    expect(screen.getByTestId("probe")).toHaveTextContent("2/1/3")
  })

  it("spans every workspace when the search reaches all of them", () => {
    seedRead()
    sidebarExtras = { groupBy: "team", search: { workspace: "all" } }
    render(<Probe />)
    expect(screen.getByTestId("probe")).toHaveTextContent("3/2/5")
  })

  it("counts nothing until the project store has loaded", () => {
    seedRead()
    sidebarExtras = { groupBy: "team" }
    projectState = { activeProjectId: "p1", loaded: false }
    render(<Probe />)
    expect(screen.getByTestId("probe")).toHaveTextContent("0/0/0")
  })

  it("scopes to no workspace until the project store has loaded", () => {
    sidebarExtras = { groupBy: "team" }
    projectState = { activeProjectId: "p1", loaded: false }
    function ScopeProbe() {
      const scope = useGuildUnreadScope()
      return <div data-testid="scope">{JSON.stringify(scope)}</div>
    }
    render(<ScopeProbe />)
    expect(screen.getByTestId("scope")).toHaveTextContent('{"kind":"workspace","projectId":null}')
  })

  it("goes dark with the unread-badge display setting", () => {
    seedRead()
    showUnreadBadges = false
    render(<Probe />)
    expect(screen.getByTestId("probe")).toHaveTextContent("0/0/0")
  })

  it("draws from the shared read and never runs a Dexie read of its own", () => {
    seedRead()
    render(
      <>
        <Probe />
        <Probe />
      </>
    )
    expect(subscribeCount.current).toBeGreaterThanOrEqual(2)
    expect(listSessionStates).not.toHaveBeenCalled()
    expect(bulkGet).not.toHaveBeenCalled()
  })
})
