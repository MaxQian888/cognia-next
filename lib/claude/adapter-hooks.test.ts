/**
 * @jest-environment node
 */

import {
  dispatchUserPromptSubmit,
  dispatchPreToolUse,
  dispatchPostToolUse,
  dispatchOnAssistantMessage,
  dispatchStreamStart,
  dispatchStreamChunk,
  dispatchStreamEnd,
  dispatchChatError,
  dispatchTokenUsage,
  dispatchPostChatReceive,
} from "./adapter-hooks"
import { emitSystemBusEvent, SystemEvents } from "@/lib/plugin/messaging/message-bus"

jest.mock("@/lib/plugin/messaging/message-bus", () => {
  const actual = jest.requireActual("@/lib/plugin/messaging/message-bus")
  return { ...actual, emitSystemBusEvent: jest.fn() }
})
const mockedEmit = emitSystemBusEvent as jest.Mock

const dispatcherImpl = {
  dispatchUserPromptSubmit: jest.fn(async () => ({ action: "proceed" as const })),
  dispatchPreToolUse: jest.fn(async () => ({ action: "allow" as const })),
  dispatchPostToolUse: jest.fn(async () => ({})),
  dispatchOnMessageReceive: jest.fn(async (msg: unknown) => msg),
  dispatchStreamStart: jest.fn(),
  dispatchStreamChunk: jest.fn(),
  dispatchStreamEnd: jest.fn(),
  dispatchChatError: jest.fn(),
  dispatchTokenUsage: jest.fn(),
  dispatchPostChatReceive: jest.fn(async () => ({})),
}

const hookSet = new Set<string>([
  "onUserPromptSubmit",
  "onPreToolUse",
  "onPostToolUse",
  "onMessageReceive",
  "onStreamStart",
  "onStreamChunk",
  "onStreamEnd",
  "onChatError",
  "onTokenUsage",
  "onPostChatReceive",
])

jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginLifecycleHooks: () => ({
    ...dispatcherImpl,
    hooks: { has: (n: string) => hookSet.has(n) },
  }),
  getPluginEventHooks: () => ({
    ...dispatcherImpl,
    hooks: { has: (n: string) => hookSet.has(n) },
  }),
}))

beforeEach(() => {
  for (const fn of Object.values(dispatcherImpl)) {
    if (typeof fn === "function") (fn as jest.Mock).mockClear()
  }
  mockedEmit.mockClear()
})

describe("adapter-hooks", () => {
  it("forwards dispatchUserPromptSubmit and returns the proceed default when no plugin overrides", async () => {
    const result = await dispatchUserPromptSubmit("hi", "session_a")
    expect(result.action).toBe("proceed")
    expect(dispatcherImpl.dispatchUserPromptSubmit).toHaveBeenCalledWith("hi", "session_a", {})
  })

  it("dispatchPreToolUse forwards arguments verbatim", async () => {
    const result = await dispatchPreToolUse("calc", { x: 1 }, "session_b")
    expect(result.action).toBe("allow")
    expect(dispatcherImpl.dispatchPreToolUse).toHaveBeenCalledWith("calc", { x: 1 }, "session_b")
  })

  it("dispatchPostToolUse returns the dispatcher's merge result", async () => {
    dispatcherImpl.dispatchPostToolUse.mockResolvedValueOnce({
      modifiedResult: { ok: true },
    })
    const result = await dispatchPostToolUse("calc", {}, { ok: false }, "s")
    expect(result.modifiedResult).toEqual({ ok: true })
  })

  it("dispatchOnAssistantMessage falls back to the input on dispatcher errors", async () => {
    dispatcherImpl.dispatchOnMessageReceive.mockRejectedValueOnce(new Error("oops"))
    const message = { id: "x", role: "assistant" } as never
    const result = await dispatchOnAssistantMessage(message)
    expect(result).toBe(message)
  })

  it("stream dispatchers swallow hook errors", () => {
    dispatcherImpl.dispatchStreamStart.mockImplementationOnce(() => {
      throw new Error("noop")
    })
    expect(() => dispatchStreamStart("s")).not.toThrow()
    expect(() => dispatchStreamChunk("s", "chunk", "full")).not.toThrow()
    expect(() => dispatchStreamEnd("s", "full")).not.toThrow()
    expect(() => dispatchChatError("s", new Error("boom"))).not.toThrow()
    expect(() => dispatchTokenUsage("s", { inputTokens: 1, outputTokens: 2 })).not.toThrow()
  })

  it("dispatchChatError emits AGENT_ERROR with the bounded error class, not the message", () => {
    class RateLimitError extends Error {
      constructor() {
        super("you sent: secret prompt text")
        this.name = "RateLimitError"
      }
    }
    dispatchChatError("sess-1", new RateLimitError())
    // ids + error CLASS only — the free-text message must NOT reach the bus.
    expect(mockedEmit).toHaveBeenCalledWith(SystemEvents.AGENT_ERROR, {
      sessionId: "sess-1",
      error: "RateLimitError",
    })
  })

  it("dispatchPostChatReceive forwards the response payload", async () => {
    await dispatchPostChatReceive({
      sessionId: "s",
      message: { id: "1", role: "assistant" } as never,
    })
    expect(dispatcherImpl.dispatchPostChatReceive).toHaveBeenCalled()
  })

  it("short-circuits when no listeners are registered", async () => {
    hookSet.clear()
    const result = await dispatchUserPromptSubmit("hi", "session_a")
    expect(result.action).toBe("proceed")
    expect(dispatcherImpl.dispatchUserPromptSubmit).not.toHaveBeenCalled()
    // restore
    hookSet.add("onUserPromptSubmit")
    hookSet.add("onPreToolUse")
    hookSet.add("onPostToolUse")
    hookSet.add("onMessageReceive")
    hookSet.add("onStreamStart")
    hookSet.add("onStreamChunk")
    hookSet.add("onStreamEnd")
    hookSet.add("onChatError")
    hookSet.add("onTokenUsage")
    hookSet.add("onPostChatReceive")
  })
})
