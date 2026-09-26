import type { ChatSession } from "@cognia/agent-config-types"

const listSessionStates = jest.fn()
const bulkGet = jest.fn()
jest.mock("@/lib/db/session-state", () => ({
  listSessionStates: () => listSessionStates(),
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ sessions: { bulkGet: (ids: string[]) => bulkGet(ids) } }),
}))

const warnMock = jest.fn()
jest.mock("@cognia/logging", () => ({
  loggers: { chat: { warn: (...args: unknown[]) => warnMock(...args) } },
}))

// A hand-driven Dexie `liveQuery`: each subscription is recorded so a test can
// count observers and push a read (or a failure) through one.
interface FakeObserver {
  query: () => Promise<unknown>
  next: (value: unknown) => void
  error: (error: unknown) => void
  unsubscribed: boolean
}
const observers: FakeObserver[] = []
jest.mock("dexie", () => ({
  __esModule: true,
  default: {
    liveQuery: (query: () => Promise<unknown>) => ({
      subscribe: (handlers: { next: (v: unknown) => void; error: (e: unknown) => void }) => {
        const observer: FakeObserver = { query, ...handlers, unsubscribed: false }
        observers.push(observer)
        return {
          unsubscribe: () => {
            observer.unsubscribed = true
          },
        }
      },
    }),
  },
}))

import {
  __resetUnreadSessionsForTests,
  ALL_WORKSPACES_UNREAD_SCOPE,
  EMPTY_UNREAD_SESSIONS,
  getUnreadSessionsServerSnapshot,
  getUnreadSessionsSnapshot,
  isBadgeableUnread,
  isInUnreadScope,
  isUnreadScopeOpen,
  loadUnreadSessions,
  sameUnreadSessions,
  subscribeUnreadSessions,
  unreadGuildTeamId,
  type UnreadBadgeSession,
  type UnreadScope,
  type UnreadSessions,
} from "./unread-sessions"

const P1: UnreadScope = { kind: "workspace", projectId: "p1" }
const UNKNOWN: UnreadScope = { kind: "workspace", projectId: null }

const row = (id: string, over: Partial<ChatSession> = {}): ChatSession =>
  ({ id, kind: "direct", title: id, updatedAt: 1, ...over }) as unknown as ChatSession

const badge = (id: string, over: Partial<UnreadBadgeSession> = {}): UnreadBadgeSession => ({
  id,
  kind: "direct",
  ...over,
})

function read(sessions: UnreadBadgeSession[], counts?: number[]): UnreadSessions {
  return {
    sessions,
    unreadBySession: new Map(sessions.map((s, i) => [s.id, counts?.[i] ?? 1])),
  }
}

beforeEach(() => {
  __resetUnreadSessionsForTests()
  observers.length = 0
  listSessionStates.mockReset()
  bulkGet.mockReset()
  warnMock.mockReset()
})

describe("isInUnreadScope", () => {
  it("admits everything across all workspaces", () => {
    expect(isInUnreadScope({ projectId: "p2" }, ALL_WORKSPACES_UNREAD_SCOPE)).toBe(true)
  })

  it("admits the workspace's own and workspace-less conversations", () => {
    expect(isInUnreadScope({ projectId: "p1" }, P1)).toBe(true)
    expect(isInUnreadScope({ projectId: undefined }, P1)).toBe(true)
    expect(isInUnreadScope({ projectId: "p2" }, P1)).toBe(false)
  })

  it("admits nothing before the active workspace is known", () => {
    expect(isInUnreadScope({ projectId: undefined }, UNKNOWN)).toBe(false)
    expect(isUnreadScopeOpen(UNKNOWN)).toBe(false)
    expect(isUnreadScopeOpen(P1)).toBe(true)
    expect(isUnreadScopeOpen(ALL_WORKSPACES_UNREAD_SCOPE)).toBe(true)
  })
})

describe("isBadgeableUnread", () => {
  it("counts a resolved, listed, unarchived conversation", () => {
    expect(isBadgeableUnread(badge("a"))).toBe(true)
  })

  it("never counts what the main list cannot show", () => {
    expect(isBadgeableUnread(undefined)).toBe(false)
    expect(isBadgeableUnread(null)).toBe(false)
    expect(isBadgeableUnread(badge("a", { archivedAt: 5 }))).toBe(false)
    expect(isBadgeableUnread(badge("a", { kind: "subagent" }))).toBe(false)
    expect(isBadgeableUnread(badge("a", { kind: "workflow-editor" }))).toBe(false)
    expect(isBadgeableUnread(badge("a", { visibility: "embedded" }))).toBe(false)
  })

  it("applies the scope, defaulting to every workspace", () => {
    const elsewhere = badge("a", { projectId: "p2" })
    expect(isBadgeableUnread(elsewhere)).toBe(true)
    expect(isBadgeableUnread(elsewhere, P1)).toBe(false)
    expect(isBadgeableUnread(badge("b"), UNKNOWN)).toBe(false)
  })
})

describe("unreadGuildTeamId", () => {
  it("files a team conversation under its team and anything else under DMs", () => {
    expect(unreadGuildTeamId({ kind: "team", teamId: "t" })).toBe("t")
    expect(unreadGuildTeamId({ kind: "team" })).toBeNull()
    expect(unreadGuildTeamId({ kind: "direct", teamId: "t" })).toBeNull()
  })
})

describe("loadUnreadSessions", () => {
  it("returns the shared empty read without touching sessions when nothing is unread", async () => {
    listSessionStates.mockResolvedValue([{ sessionId: "s", unreadCount: 0, lastReadAt: 1 }])
    await expect(loadUnreadSessions()).resolves.toBe(EMPTY_UNREAD_SESSIONS)
    expect(bulkGet).not.toHaveBeenCalled()
  })

  it("resolves only the sessions with unread, skips the gone ones, and projects the fields", async () => {
    listSessionStates.mockResolvedValue([
      { sessionId: "read", unreadCount: 0, lastReadAt: 1 },
      { sessionId: "a", unreadCount: 3, lastReadAt: 1 },
      { sessionId: "gone", unreadCount: 1, lastReadAt: 1 },
    ])
    bulkGet.mockResolvedValue([row("a", { kind: "team", teamId: "t", projectId: "p1" }), undefined])
    const result = await loadUnreadSessions()
    expect(bulkGet).toHaveBeenCalledWith(["a", "gone"])
    expect(result.unreadBySession).toEqual(
      new Map([
        ["a", 3],
        ["gone", 1],
      ])
    )
    // Projected: `title` / `updatedAt` are not badge fields.
    expect(result.sessions).toEqual([{ id: "a", kind: "team", teamId: "t", projectId: "p1" }])
  })
})

describe("sameUnreadSessions", () => {
  it("treats reads that draw the same badges as equal", () => {
    const binding = { platform: "lark", chatId: "c" }
    expect(
      sameUnreadSessions(
        read([badge("a", { platformBinding: binding as never })]),
        read([badge("a", { platformBinding: { ...binding } as never })])
      )
    ).toBe(true)
  })

  it("notices a changed count, a new row, and a changed badge field", () => {
    const base = read([badge("a")])
    expect(sameUnreadSessions(base, read([badge("a")], [2]))).toBe(false)
    expect(sameUnreadSessions(base, read([badge("a"), badge("b")]))).toBe(false)
    expect(sameUnreadSessions(base, read([badge("a", { archivedAt: 1 })]))).toBe(false)
    expect(sameUnreadSessions(base, read([badge("a", { platformBinding: {} as never })]))).toBe(
      false
    )
  })
})

describe("the shared live read", () => {
  it("runs one observer for every subscriber, and stops with the last", () => {
    const unsubA = subscribeUnreadSessions(() => {})
    const unsubB = subscribeUnreadSessions(() => {})
    expect(observers).toHaveLength(1)
    unsubA()
    expect(observers[0].unsubscribed).toBe(false)
    unsubB()
    expect(observers[0].unsubscribed).toBe(true)
    // A second call of the same unsubscribe must not tear down a new observer.
    subscribeUnreadSessions(() => {})
    unsubB()
    expect(observers).toHaveLength(2)
    expect(observers[1].unsubscribed).toBe(false)
  })

  it("observes the shared loader", async () => {
    listSessionStates.mockResolvedValue([])
    subscribeUnreadSessions(() => {})
    await expect(observers[0].query()).resolves.toBe(EMPTY_UNREAD_SESSIONS)
  })

  it("is null until the first read lands, then notifies with it", () => {
    const listener = jest.fn()
    subscribeUnreadSessions(listener)
    expect(getUnreadSessionsSnapshot()).toBeNull()
    const first = read([badge("a")])
    observers[0].next(first)
    expect(getUnreadSessionsSnapshot()).toBe(first)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("does not wake the badges for a read that draws the same thing", () => {
    const listener = jest.fn()
    subscribeUnreadSessions(listener)
    const first = read([badge("a")])
    observers[0].next(first)
    observers[0].next(read([badge("a")]))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getUnreadSessionsSnapshot()).toBe(first)
    observers[0].next(read([badge("a")], [4]))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("keeps the last read across a restart instead of flashing zero", () => {
    const unsub = subscribeUnreadSessions(() => {})
    const first = read([badge("a")])
    observers[0].next(first)
    unsub()
    subscribeUnreadSessions(() => {})
    expect(getUnreadSessionsSnapshot()).toBe(first)
  })

  it("goes empty, and says so once, when the read fails", () => {
    const listener = jest.fn()
    subscribeUnreadSessions(listener)
    observers[0].next(read([badge("a")]))
    observers[0].error(new Error("boom"))
    expect(getUnreadSessionsSnapshot()).toBe(EMPTY_UNREAD_SESSIONS)
    expect(warnMock).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("renders nothing from the database on the server", () => {
    expect(getUnreadSessionsServerSnapshot()).toBeNull()
  })
})
