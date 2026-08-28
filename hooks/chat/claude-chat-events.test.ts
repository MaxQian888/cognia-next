/** @jest-environment jsdom */
const applySdkEventMock = jest.fn()
const mergeWebSearchSourcesMock = jest.fn((messages: unknown, _context?: unknown) => messages)

jest.mock("@/lib/claude/adapter", () => {
  const actual = jest.requireActual("@/lib/claude/adapter")
  return {
    ...actual,
    applySdkEvent: (...args: unknown[]) => applySdkEventMock(...args),
    mergeWebSearchSourcesIntoLastAssistant: (messages: unknown, context: unknown) =>
      mergeWebSearchSourcesMock(messages, context),
  }
})

import { handleEvent, isTeamSubSession } from "./claude-chat-events"
import { SessionCoalescingRegistry } from "./stream-coalescing"
import { useChatStore } from "@/stores/chat"
import { clearSidecarLogTrail } from "@/lib/chat/sidecar-log-trail"

describe("Claude chat event seam", () => {
  it("exports event routing and filters team sub-sessions", () => {
    expect(typeof handleEvent).toBe("function")
    expect(isTeamSubSession("team::char::member")).toBe(true)
  })
})

describe("pre-search source folding", () => {
  it("reads the current turn's cached web context at turnComplete", async () => {
    const webSearchContext = {
      provider: "tavily",
      results: [{ title: "A", url: "https://a.test", content: "a", score: 1 }],
    }
    useChatStore.setState({
      sessions: {
        s1: {
          ...(useChatStore.getState().sessions.s1 ?? {}),
          messages: [],
          status: "streaming",
          pendingApprovals: [],
        },
      },
      openSessionIds: ["s1"],
      lastSendBySession: {
        s1: { content: "q", options: { webSearchContext }, attemptIndex: 0 },
      },
    } as never)
    applySdkEventMock.mockReturnValueOnce({
      messages: [{ id: "a1", role: "assistant", parts: [{ type: "text", text: "answer" }] }],
      turnComplete: true,
    })
    mergeWebSearchSourcesMock.mockImplementationOnce((messages) => messages)
    const registry = new SessionCoalescingRegistry({
      onCommit: () => {},
      onPersist: () => {},
      persistDelayMs: 0,
    })

    await handleEvent(
      { type: "event", sessionId: "s1", event: { type: "result" } } as never,
      { current: "s1" },
      { current: [] },
      { current: new Map() },
      { current: null },
      {
        messagesMirrorRef: { current: new Map() },
        registry,
        getExecutionHandle: () => undefined,
      } as never
    ).catch(() => {})

    expect(mergeWebSearchSourcesMock).toHaveBeenCalledWith(expect.any(Array), webSearchContext)
  })
})

describe("sidecar log frames", () => {
  const ref = <T>(value: T) => ({ current: value }) as React.MutableRefObject<T>

  /**
   * The `sidecar_exited` branch ends with two Dexie writes
   * (`finishDirectChatExecutionRun`, `settleChatTranscript`) that have no
   * database in this environment. Everything under test — including the
   * diagnostic — is set before them, so the tail rejection is swallowed rather
   * than mocked away: mocking it would mean asserting against a handler that
   * is not the one that runs.
   */
  const dispatch = async (evt: unknown) => {
    const registry = new SessionCoalescingRegistry({
      onCommit: () => {},
      onPersist: () => {},
      persistDelayMs: 0,
    })
    await handleEvent(
      evt as never,
      ref<string | null>("s1"),
      ref<string[]>([]),
      ref(new Map<string, { groupId: string; index: number }>()),
      ref(null),
      {
        messagesMirrorRef: ref(new Map()),
        registry,
        getExecutionHandle: () => undefined,
      } as never
    ).catch(() => {})
  }

  beforeEach(() => {
    clearSidecarLogTrail()
    useChatStore.setState({
      sessions: {
        s1: {
          ...(useChatStore.getState().sessions.s1 ?? {}),
          messages: [],
          status: "streaming",
          pendingApprovals: [],
          errorDiagnostic: null,
        },
      },
      lastSendBySession: {},
    } as never)
  })

  it("never turns a log frame into a session failure on its own", async () => {
    // The whole reason these frames were dropped: a warning mid-turn is not the
    // turn's outcome, and rendering it would fail a turn that goes on to work.
    await dispatch({ type: "log", level: "error", message: "tool retry failed", sessionId: "s1" })
    const session = useChatStore.getState().sessions.s1!
    expect(session.errorDiagnostic).toBeNull()
    expect(session.status).toBe("streaming")
  })

  it("hands the last error line to the crash it explains", async () => {
    // `sidecarExited` used to be raised with no message at all — "the backend
    // stopped", with the stderr line that says why already discarded.
    await dispatch({ type: "log", level: "error", message: "ENOENT: node not found" })
    await dispatch({ type: "sidecar_exited", code: 1 })
    const diagnostic = useChatStore.getState().sessions.s1!.errorDiagnostic
    expect(diagnostic?.code).toBe("sidecarExited")
    expect(diagnostic?.message).toBe("ENOENT: node not found")
  })

  it("still reports a crash with no log line, rather than nothing", async () => {
    await dispatch({ type: "sidecar_exited", code: 137 })
    expect(useChatStore.getState().sessions.s1!.errorDiagnostic?.code).toBe("sidecarExited")
  })

  it("does not let an info-level line become a crash cause", async () => {
    await dispatch({ type: "log", level: "info", message: "listening on 3000" })
    await dispatch({ type: "sidecar_exited", code: 1 })
    // `createDiagnostic` defaults `message` to "", so absence reads as empty
    // rather than undefined — what matters is that routine startup chatter
    // never gets presented as the reason a process died.
    expect(useChatStore.getState().sessions.s1!.errorDiagnostic?.message).toBe("")
  })
})
