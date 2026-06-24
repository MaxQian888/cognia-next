jest.mock("@/lib/db/sessions", () => ({
  listSessions: jest.fn(),
}))
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: jest.fn() },
}))

import { handleSessions, handleReset, handleResume } from "./sessions"
import { listSessions } from "@/lib/db/sessions"
import { useChatStore } from "@/stores/chat"
import type { SlashContext } from "../builtin"

const mockedList = listSessions as unknown as jest.Mock
const mockedChatGetState = useChatStore.getState as unknown as jest.Mock

function makeCtx(
  overrides: Partial<SlashContext> = {}
): SlashContext & { _pushed: string[]; _started: number } {
  const pushed: string[] = []
  let started = 0
  const startNewSession = jest.fn(async () => {
    started += 1
  })
  return {
    args: "",
    activeSessionId: null,
    chatStatus: "ready",
    currentPermissionMode: null,
    startNewSession,
    openSettings: () => undefined,
    setPermissionMode: () => undefined,
    pushSystemMessage: (md: string) => {
      pushed.push(md)
    },
    get _started() {
      return started
    },
    _pushed: pushed,
    ...overrides,
  } as unknown as SlashContext & { _pushed: string[]; _started: number }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("handleSessions", () => {
  it("emits 'no sessions' when list is empty", async () => {
    mockedList.mockResolvedValue([])
    const ctx = makeCtx()
    await handleSessions(ctx)
    expect(ctx._pushed[0]).toContain("No sessions yet.")
  })

  it("renders a markdown table for known sessions, with relative-time formatter coverage", async () => {
    const now = Date.now()
    mockedList.mockResolvedValue([
      {
        id: "abc-very-long-session-id-12345",
        title: "Recent | piped",
        kind: "agent",
        updatedAt: now - 30_000,
      },
      { id: "x", title: "older minute", updatedAt: now - 5 * 60_000 },
      { id: "y", title: "hours back", updatedAt: now - 3 * 3_600_000 },
      { id: "z", title: undefined as unknown as string, updatedAt: now - 5 * 86_400_000 },
    ])
    const ctx = makeCtx()
    await handleSessions(ctx)
    const md = ctx._pushed[0]
    expect(md).toContain("**Sessions**")
    expect(md).toContain("just now")
    expect(md).toContain("5m ago")
    expect(md).toContain("3h ago")
    expect(md).toContain("5d ago")
    expect(md).toContain("(untitled)")
    // long ID should be truncated
    expect(md).toContain("abc-very-long-…")
    // pipe should be escaped
    expect(md).toContain("Recent \\| piped")
    expect(md).toContain("Use `/resume <title or id>` to switch.")
  })

  it("captures Error from listSessions", async () => {
    mockedList.mockRejectedValue(new Error("nope"))
    const ctx = makeCtx()
    await handleSessions(ctx)
    expect(ctx._pushed[0]).toContain("Could not list sessions: nope")
  })

  it("captures non-Error from listSessions", async () => {
    mockedList.mockRejectedValue("plain")
    const ctx = makeCtx()
    await handleSessions(ctx)
    expect(ctx._pushed[0]).toContain("Could not list sessions: plain")
  })
})

describe("handleReset", () => {
  it("delegates to ctx.startNewSession", async () => {
    const ctx = makeCtx()
    await handleReset(ctx)
    expect(ctx._started).toBe(1)
  })
})

describe("handleResume", () => {
  it("prints usage when no arg is given", async () => {
    const ctx = makeCtx({ args: "" })
    await handleResume(ctx)
    expect(ctx._pushed[0]).toContain("Usage: `/resume <id or title>")
  })

  it("captures Error rejection from listSessions", async () => {
    mockedList.mockRejectedValue(new Error("explode"))
    const ctx = makeCtx({ args: "x" })
    await handleResume(ctx)
    expect(ctx._pushed[0]).toContain("Could not list sessions: explode")
  })

  it("captures non-Error rejection from listSessions", async () => {
    mockedList.mockRejectedValue("plain")
    const ctx = makeCtx({ args: "x" })
    await handleResume(ctx)
    expect(ctx._pushed[0]).toContain("Could not list sessions: plain")
  })

  it("notes that no sessions exist", async () => {
    mockedList.mockResolvedValue([])
    const ctx = makeCtx({ args: "anything" })
    await handleResume(ctx)
    expect(ctx._pushed[0]).toContain("No sessions yet.")
  })

  it("matches by exact id and switches active session", async () => {
    const setActive = jest.fn()
    mockedChatGetState.mockReturnValue({ setActiveSession: setActive })
    mockedList.mockResolvedValue([
      { id: "id-1", title: "First" },
      { id: "id-2", title: "Second" },
    ])
    const ctx = makeCtx({ args: "id-2" })
    await handleResume(ctx)
    expect(setActive).toHaveBeenCalledWith("id-2")
    expect(ctx._pushed[0]).toEqual({
      kind: "slash-result",
      commandId: "resume",
      args: "id-2",
      summary: "Resumed Second",
    })
  })

  it("matches by case-insensitive exact title", async () => {
    const setActive = jest.fn()
    mockedChatGetState.mockReturnValue({ setActiveSession: setActive })
    mockedList.mockResolvedValue([
      { id: "id-1", title: "First" },
      { id: "id-2", title: "Second" },
    ])
    const ctx = makeCtx({ args: "first" })
    await handleResume(ctx)
    expect(setActive).toHaveBeenCalledWith("id-1")
    expect(ctx._pushed[0]).toEqual({
      kind: "slash-result",
      commandId: "resume",
      args: "first",
      summary: "Resumed First",
    })
  })

  it("matches by substring when there is exactly one partial match", async () => {
    const setActive = jest.fn()
    mockedChatGetState.mockReturnValue({ setActiveSession: setActive })
    mockedList.mockResolvedValue([
      { id: "a", title: "Alpha thing" },
      { id: "b", title: "Beta" },
    ])
    const ctx = makeCtx({ args: "alpha" })
    await handleResume(ctx)
    expect(setActive).toHaveBeenCalledWith("a")
    expect(ctx._pushed[0]).toEqual({
      kind: "slash-result",
      commandId: "resume",
      args: "alpha",
      summary: "Resumed Alpha thing",
    })
  })

  it("reports no match when neither title nor id matches", async () => {
    mockedList.mockResolvedValue([{ id: "a", title: "Alpha" }])
    const ctx = makeCtx({ args: "zzz" })
    await handleResume(ctx)
    expect(ctx._pushed[0]).toContain("No session matched `zzz`")
  })

  it("disambiguates when multiple titles match the substring", async () => {
    const setActive = jest.fn()
    mockedChatGetState.mockReturnValue({ setActiveSession: setActive })
    mockedList.mockResolvedValue([
      { id: "a", title: "Alpha One" },
      { id: "b", title: "Alpha Two" },
      { id: "c", title: "Beta" },
    ])
    const ctx = makeCtx({ args: "alpha" })
    await handleResume(ctx)
    expect(setActive).not.toHaveBeenCalled()
    const md = ctx._pushed[0]
    expect(md).toContain("matches multiple sessions")
    expect(md).toContain("Alpha One")
    expect(md).toContain("Alpha Two")
  })

  it("disambiguates when multiple titles match exactly (case-insensitive)", async () => {
    const setActive = jest.fn()
    mockedChatGetState.mockReturnValue({ setActiveSession: setActive })
    mockedList.mockResolvedValue([
      { id: "a", title: "Same" },
      { id: "b", title: "same" },
    ])
    const ctx = makeCtx({ args: "Same" })
    await handleResume(ctx)
    expect(setActive).not.toHaveBeenCalled()
    expect(ctx._pushed[0]).toContain("matches multiple sessions")
  })
})
