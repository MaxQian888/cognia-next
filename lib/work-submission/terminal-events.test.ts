/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import type { ClaudeEvent } from "@cognia/agent-config-types"

import {
  registerInteractiveWorkSubmissionEvents,
  startWorkSubmissionTerminalEvents,
} from "./terminal-events"
import type { Unsubscribe } from "./outbox-runner"
import {
  __resetClaimedTurnUsageForTesting,
  claimTurnUsage,
} from "@/lib/usage/claimed-turn-usage"

async function flushEvents(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve()
}

describe("work submission terminal events", () => {
  it("settles terminal sessions when no chat route owns the event pipeline", async () => {
    let handler: ((event: ClaudeEvent) => void) | undefined
    const settleSession = jest.fn(async () => true)
    const stop = startWorkSubmissionTerminalEvents({
      subscribe: async (next) => {
        handler = next
        return () => {}
      },
      settleSession,
    })
    await Promise.resolve()

    handler?.({ type: "session_ended", sessionId: "session-1", error: "boom" })
    await flushEvents()

    expect(settleSession).toHaveBeenCalledWith("session-1", {
      outcome: "failed",
      errorCode: "turn_error",
    })
    stop()
  })

  it("commits recovered output through the exactly-once settlement transaction", async () => {
    let handler: ((event: ClaudeEvent) => void) | undefined
    const initial = [{ id: "user-1", role: "user", parts: [] }] as never
    const projected = [
      ...initial,
      { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "done" }] },
    ] as never
    const persistMessages = jest.fn(async () => {})
    const settleSession = jest.fn(
      async (_sessionId: string, input: { writeTranscript?: () => Promise<void> }) => {
        await input.writeTranscript?.()
        return true
      }
    )
    const onReady = jest.fn()
    const stop = startWorkSubmissionTerminalEvents({
      subscribe: async (next) => {
        handler = next
        return () => {}
      },
      loadMessages: async () => initial,
      applyEvent: () => ({ messages: projected }),
      persistMessages,
      settleSession,
      hasOpenSubmission: async () => true,
      onReady,
    })
    await Promise.resolve()
    expect(onReady).toHaveBeenCalledTimes(1)

    handler?.({
      type: "event",
      sessionId: "session-1",
      event: { type: "assistant" } as never,
    })
    handler?.({ type: "session_ended", sessionId: "session-1" })
    for (let attempt = 0; attempt < 20 && persistMessages.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve()
    }

    expect(persistMessages).toHaveBeenCalledWith("session-1", projected)
    expect(settleSession).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ outcome: "completed", writeTranscript: expect.any(Function) })
    )
    stop()
  })

  it("keeps a message the Host accepted after the turn's mirror was loaded", async () => {
    let handler: ((event: ClaudeEvent) => void) | undefined
    const first = { id: "user-1", role: "user", parts: [] }
    const reply = { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "done" }] }
    // Sent mid-turn: written on acceptance, after this turn's first frame.
    const queued = { id: "user-2", role: "user", parts: [{ type: "text", text: "next" }] }
    let rows: unknown[] = [first]
    const persistMessages = jest.fn(async () => {})
    let settled!: () => void
    const done = new Promise<void>((resolve) => {
      settled = resolve
    })
    const stop = startWorkSubmissionTerminalEvents({
      subscribe: async (next) => {
        handler = next
        return () => {}
      },
      loadMessages: async () => rows as never,
      applyEvent: (messages) => ({ messages: [...messages, reply] as never }),
      persistMessages,
      settleSession: async (_sessionId, input) => {
        await input.writeTranscript?.()
        settled()
        return true
      },
      hasOpenSubmission: async () => true,
    })
    await Promise.resolve()
    handler?.({ type: "event", sessionId: "session-1", event: { type: "assistant" } as never })
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
    rows = [first, queued]
    handler?.({ type: "session_ended", sessionId: "session-1" })
    await done
    expect(persistMessages).toHaveBeenCalledWith("session-1", [first, reply, queued])
    stop()
  })

  it("books the usage of a turn no chat view renders, under the reply's id", async () => {
    let handler: ((event: ClaudeEvent) => void) | undefined
    const reply = { id: "assistant-7", role: "assistant", parts: [] }
    const result = { type: "result", subtype: "success" } as never
    const recordUsage = jest.fn(async () => null)
    const stop = startWorkSubmissionTerminalEvents({
      subscribe: async (next) => {
        handler = next
        return () => {}
      },
      loadMessages: async () => [{ id: "user-1", role: "user", parts: [] }] as never,
      applyEvent: (messages, event) =>
        (event as { type: string }).type === "result"
          ? { messages, result }
          : { messages: [...messages, reply] as never },
      hasOpenSubmission: async () => true,
      loadSession: async () =>
        ({
          id: "session-1",
          characterId: "char-1",
          model: "ark-deepseek-v4.1-flash",
          providerOverride: "deepseek",
          projectId: "proj-1",
        }) as never,
      recordUsage,
    })
    await Promise.resolve()

    handler?.({ type: "event", sessionId: "session-1", event: { type: "assistant" } as never })
    handler?.({
      type: "event",
      sessionId: "session-1",
      turnId: "turn-1",
      event: { type: "result" } as never,
    } as ClaudeEvent)
    for (let tick = 0; tick < 20 && recordUsage.mock.calls.length === 0; tick += 1) {
      await Promise.resolve()
    }

    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage).toHaveBeenCalledWith({
      sessionId: "session-1",
      messageId: "assistant-7",
      characterId: "char-1",
      model: "ark-deepseek-v4.1-flash",
      providerId: "deepseek",
      projectId: "proj-1",
      turnId: "turn-1",
      result,
    })
    stop()
  })

  it("leaves a turn a headless caller claimed, and survives a failed usage write", async () => {
    __resetClaimedTurnUsageForTesting()
    claimTurnUsage("session-1", "turn-claimed")
    let handler: ((event: ClaudeEvent) => void) | undefined
    const reply = { id: "assistant-1", role: "assistant", parts: [] }
    const recordUsage = jest.fn(async () => {
      throw new Error("disk full")
    })
    const onError = jest.fn()
    const settleSession = jest.fn(async () => true)
    const stop = startWorkSubmissionTerminalEvents({
      subscribe: async (next) => {
        handler = next
        return () => {}
      },
      loadMessages: async () => [reply] as never,
      applyEvent: (messages) => ({ messages, result: { type: "result" } as never }),
      hasOpenSubmission: async () => true,
      loadSession: async () => undefined,
      recordUsage,
      settleSession,
      onError,
    })
    await Promise.resolve()

    const frame = (turnId: string) =>
      ({
        type: "event",
        sessionId: "session-1",
        turnId,
        event: { type: "result" },
      }) as unknown as ClaudeEvent
    handler?.(frame("turn-claimed"))
    handler?.(frame("turn-open"))
    handler?.({ type: "session_ended", sessionId: "session-1" })
    for (let tick = 0; tick < 30 && settleSession.mock.calls.length === 0; tick += 1) {
      await Promise.resolve()
    }

    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "assistant-1", turnId: "turn-open" })
    )
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "disk full" }))
    expect(settleSession).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ outcome: "completed" })
    )
    __resetClaimedTurnUsageForTesting()
    stop()
  })

  it("ignores SDK frames from sessions with no open work submission", async () => {
    let handler: ((event: ClaudeEvent) => void) | undefined
    const loadMessages = jest.fn(async () => [])
    const applyEvent = jest.fn(() => ({ messages: [] }))
    const stop = startWorkSubmissionTerminalEvents({
      subscribe: async (next) => {
        handler = next
        return () => {}
      },
      hasOpenSubmission: async () => false,
      loadMessages,
      applyEvent,
    })
    await Promise.resolve()

    handler?.({ type: "event", sessionId: "scheduler-1", event: { type: "assistant" } as never })
    await flushEvents()

    expect(loadMessages).not.toHaveBeenCalled()
    expect(applyEvent).not.toHaveBeenCalled()
    stop()
  })

  it("defers to the interactive pipeline so routing fallback can decide settlement", async () => {
    let handler: ((event: ClaudeEvent) => void) | undefined
    const settleSession = jest.fn(async () => true)
    const unregister = registerInteractiveWorkSubmissionEvents()
    const stop = startWorkSubmissionTerminalEvents({
      subscribe: async (next) => {
        handler = next
        return () => {}
      },
      settleSession,
    })
    await Promise.resolve()

    handler?.({ type: "session_ended", sessionId: "session-1" })
    await Promise.resolve()
    expect(settleSession).not.toHaveBeenCalled()

    unregister()
    handler?.({ type: "session_ended", sessionId: "session-1" })
    await flushEvents()
    expect(settleSession).toHaveBeenCalledWith("session-1", { outcome: "completed" })
    stop()
  })

  it("fails every dispatched row when the sidecar exits without an interactive owner", async () => {
    let handler: ((event: ClaudeEvent) => void) | undefined
    const settleSubmission = jest.fn(async () => true)
    const stop = startWorkSubmissionTerminalEvents({
      subscribe: async (next) => {
        handler = next
        return () => {}
      },
      listDispatched: async () =>
        [
          { id: "submission-1", sessionId: "session-1" },
          { id: "submission-2", sessionId: "session-2" },
        ] as never,
      loadMessages: async () => [],
      settleSubmission,
    })
    await Promise.resolve()

    handler?.({ type: "sidecar_exited" })
    for (let attempt = 0; attempt < 20 && settleSubmission.mock.calls.length < 2; attempt += 1) {
      await Promise.resolve()
    }

    expect(settleSubmission).toHaveBeenCalledTimes(2)
    expect(settleSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        submissionId: "submission-1",
        outcome: "failed",
        errorCode: "sidecar_exit",
        writeTranscript: expect.any(Function),
      })
    )
    stop()
  })

  it("unsubscribes a listener that resolves after teardown", async () => {
    let resolveSubscribe: ((stop: Unsubscribe) => void) | undefined
    const transportStop = jest.fn()
    const stop = startWorkSubmissionTerminalEvents({
      subscribe: () =>
        new Promise((resolve) => {
          resolveSubscribe = resolve
        }),
    })

    stop()
    resolveSubscribe?.(transportStop)
    await Promise.resolve()

    expect(transportStop).toHaveBeenCalledTimes(1)
  })

  it("does not announce readiness after teardown wins the subscribe race", async () => {
    let resolveSubscribe: ((stop: Unsubscribe) => void) | undefined
    const onReady = jest.fn()
    const stop = startWorkSubmissionTerminalEvents({
      subscribe: () =>
        new Promise((resolve) => {
          resolveSubscribe = resolve
        }),
      onReady,
    })

    stop()
    resolveSubscribe?.(() => {})
    await Promise.resolve()

    expect(onReady).not.toHaveBeenCalled()
  })

  it("reports and retries a failed transport subscription", async () => {
    jest.useFakeTimers()
    const onError = jest.fn()
    const onReady = jest.fn()
    const subscribe = jest
      .fn()
      .mockRejectedValueOnce(new Error("transport unavailable"))
      .mockResolvedValueOnce(() => {})
    const stop = startWorkSubmissionTerminalEvents({ subscribe, onError, onReady, retryMs: 10 })

    await flushEvents()
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
    expect(onReady).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(10)
    expect(subscribe).toHaveBeenCalledTimes(2)
    expect(onReady).toHaveBeenCalledTimes(1)

    stop()
    jest.useRealTimers()
  })
})

it("settles structured provider refusals with the code and cap reset", async () => {
  let handler: ((event: ClaudeEvent) => void) | undefined
  const settleSession = jest.fn(async () => true)
  const stop = startWorkSubmissionTerminalEvents({
    subscribe: async (next) => {
      handler = next
      return () => {}
    },
    settleSession,
  })
  await Promise.resolve()
  handler?.({
    type: "session_ended",
    sessionId: "person-session",
    error: "cap",
    code: "member_usage_cap_reached",
    resetAt: 123,
    httpStatus: 429,
  })
  for (let tick = 0; tick < 30; tick += 1) await Promise.resolve()
  expect(settleSession).toHaveBeenCalledWith("person-session", {
    outcome: "failed",
    errorCode: "member_usage_cap_reached",
    resetAt: 123,
  })
  stop()
})

it("writes a real reply and terminal settlement only into the person account database", async () => {
  const { webcrypto } = await import("node:crypto")
  if (!globalThis.crypto?.subtle)
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true })
  const { activateAccountDatabase, clearAccountDatabaseSelection, __resetDbForTesting, getDb } =
    await import("@/lib/db/schema")
  const { AccountContentCipher, activateAccountContentCipher } =
    await import("@/lib/accounts/content-cipher")
  const { acceptChatTurn, settleChatTurnForSession } = await import("./chat-adapter")
  const { listMessages } = await import("@/lib/db/messages")
  const { initializePersonChat } = await import("@/lib/headless/person-chat")
  initializePersonChat("person-brain", { COGNIA_PERSON_CHAT: "tool-less" })
  activateAccountDatabase("pb_chat_test", "local-host")
  activateAccountContentCipher(
    await AccountContentCipher.createForTesting("pb_chat_test", getDb().name)
  )
  await getDb().delete()
  __resetDbForTesting()
  const deps = {
    resolveScope: () => ({ accountId: "pb_chat_test", runtimeTargetId: "local-host" }),
    loadKey: async () => new Uint8Array(32).fill(5),
  }
  await getDb().sessions.put({ id: "person-session", title: "Chat", createdAt: 1, updatedAt: 1 })
  await acceptChatTurn(
    {
      sessionId: "person-session",
      runId: "person-run",
      messageId: "user",
      content: "hello",
      visibleMessageIds: ["user"],
    },
    deps
  )
  let handler: ((event: ClaudeEvent) => void) | undefined
  let finish!: () => void
  let fail!: (error: unknown) => void
  const finished = new Promise<void>((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  const stop = startWorkSubmissionTerminalEvents({
    subscribe: async (next) => {
      handler = next
      return () => {}
    },
    settleSession: async (id, input) => {
      const result = await settleChatTurnForSession(id, input, deps)
      finish()
      return result
    },
    onError: fail,
  })
  try {
    await Promise.resolve()
    handler?.({
      type: "event",
      sessionId: "person-session",
      event: {
        type: "assistant",
        message: {
          id: "reply",
          role: "assistant",
          content: [{ type: "text", text: "partition reply" }],
        },
      } as never,
    })
    handler?.({
      type: "event",
      sessionId: "person-session",
      event: {
        type: "result",
        subtype: "success",
        usage: { input_tokens: 12, output_tokens: 7 },
        total_cost_usd: 0.001,
        duration_ms: 900,
      } as never,
    })
    handler?.({ type: "session_ended", sessionId: "person-session" })
    await finished
    expect(await listMessages("person-session")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          parts: expect.arrayContaining([
            expect.objectContaining({ type: "text", text: "partition reply" }),
          ]),
        }),
      ])
    )
    expect(await getDb().workSubmissions.get("work:person-run")).toMatchObject({
      dispatchState: "settled",
      terminalOutcome: "completed",
    })
    // The member's usage lands beside the member's transcript.
    expect(await getDb().sessionUsage.where("sessionId").equals("person-session").toArray()).toEqual(
      [expect.objectContaining({ inputTokens: 12, outputTokens: 7 })]
    )
    activateAccountDatabase("pb_other_chat_test", "local-host")
    activateAccountContentCipher(
      await AccountContentCipher.createForTesting("pb_other_chat_test", getDb().name)
    )
    expect(await listMessages("person-session")).toEqual([])
    expect(await getDb().sessionUsage.count()).toBe(0)
    await getDb().delete()
  } finally {
    stop()
    activateAccountDatabase("pb_chat_test", "local-host")
    await getDb().delete()
    clearAccountDatabaseSelection()
    __resetDbForTesting()
    initializePersonChat("brain", {})
  }
}, 30_000)

it("starts a member's queued tool-less turn only once the running turn has settled", async () => {
  const { initializePersonChat } = await import("@/lib/headless/person-chat")
  const personChat = await import("@/lib/claude/person-chat-turn")
  initializePersonChat("person-brain", { COGNIA_PERSON_CHAT: "tool-less" })
  let handler: ((event: ClaudeEvent) => void) | undefined
  let settled!: () => void
  const settleSession = jest.fn(
    () =>
      new Promise<boolean>((resolve) => {
        settled = () => resolve(true)
      })
  )
  const stop = startWorkSubmissionTerminalEvents({
    subscribe: async (next) => {
      handler = next
      return () => {}
    },
    settleSession,
  })
  try {
    await Promise.resolve()
    const running = personChat.admitPersonChatTurn("queued-session", async () => {})
    const next = jest.fn(async () => {})
    const queued = personChat.admitPersonChatTurn("queued-session", next)
    await running.started
    handler?.({ type: "session_ended", sessionId: "queued-session" })
    for (let tick = 0; tick < 30 && settleSession.mock.calls.length === 0; tick += 1)
      await Promise.resolve()
    expect(settleSession).toHaveBeenCalledTimes(1)
    // The reply is not in the history yet: the next turn would read without it.
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
    expect(next).not.toHaveBeenCalled()
    settled()
    await queued.started
    expect(next).toHaveBeenCalledTimes(1)
  } finally {
    stop()
    personChat.endAllPersonChatTurns()
    initializePersonChat("brain", {})
  }
})

it("frees a member's queued tool-less turns when the sidecar exits", async () => {
  const { initializePersonChat } = await import("@/lib/headless/person-chat")
  const personChat = await import("@/lib/claude/person-chat-turn")
  initializePersonChat("person-brain", { COGNIA_PERSON_CHAT: "tool-less" })
  let handler: ((event: ClaudeEvent) => void) | undefined
  const stop = startWorkSubmissionTerminalEvents({
    subscribe: async (next) => {
      handler = next
      return () => {}
    },
    listDispatched: async () => [],
    loadMessages: async () => [],
    settleSubmission: async () => true,
  })
  try {
    await Promise.resolve()
    personChat.admitPersonChatTurn("exited-session", async () => {})
    const next = jest.fn(async () => {})
    const queued = personChat.admitPersonChatTurn("exited-session", next)
    await Promise.resolve()
    handler?.({ type: "sidecar_exited" })
    await queued.started
    expect(next).toHaveBeenCalledTimes(1)
  } finally {
    stop()
    initializePersonChat("brain", {})
  }
})
