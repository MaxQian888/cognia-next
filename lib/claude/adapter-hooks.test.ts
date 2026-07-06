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
  __hasEventListenersForTests,
  __hasListenersForTests,
} from "./adapter-hooks"
import { emitSystemBusEvent, SystemEvents } from "@/lib/plugin/messaging/message-bus"
import {
  getPluginEventHooks,
  getPluginLifecycleHooks,
  resetPluginEventHooks,
  resetPluginLifecycleHooks,
} from "@/lib/plugin/messaging/hooks-system"

jest.mock("@/lib/plugin/messaging/message-bus", () => {
  const actual = jest.requireActual("@/lib/plugin/messaging/message-bus")
  return { ...actual, emitSystemBusEvent: jest.fn() }
})
const mockedEmit = emitSystemBusEvent as jest.Mock

// PluginEventHooks reads enabled plugins from this store; default is empty so
// the no-listener fast path is exercised unless a test opts in.
const getStateMock = jest.fn(() => ({ plugins: {} as Record<string, unknown> }))
jest.mock("@/stores/plugin-runtime", () => ({
  __esModule: true,
  usePluginStore: { getState: () => getStateMock() },
}))

// An enabled plugin advertising every event hook — flips `hasEventListeners`
// true for the forwarding tests without faking the singleton's internals.
const ALL_EVENT_HOOKS = {
  onUserPromptSubmit: () => {},
  onPreToolUse: () => {},
  onPostToolUse: () => {},
  onStreamStart: () => {},
  onStreamChunk: () => {},
  onStreamEnd: () => {},
  onChatError: () => {},
  onTokenUsage: () => {},
  onPostChatReceive: () => {},
}
function enableAllEventHooks() {
  getStateMock.mockReturnValue({
    plugins: { p1: { status: "enabled", hooks: ALL_EVENT_HOOKS } },
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  getStateMock.mockReturnValue({ plugins: {} })
  // Fresh singletons per test so registered lifecycle hooks don't leak.
  resetPluginEventHooks()
  resetPluginLifecycleHooks()
})

describe("adapter-hooks", () => {
  it("forwards dispatchUserPromptSubmit and returns the proceed default when no plugin overrides", async () => {
    enableAllEventHooks()
    const spy = jest
      .spyOn(getPluginEventHooks(), "dispatchUserPromptSubmit")
      .mockResolvedValue({ action: "proceed" } as never)
    const result = await dispatchUserPromptSubmit("hi", "session_a")
    expect(result.action).toBe("proceed")
    expect(spy).toHaveBeenCalledWith("hi", "session_a", {})
  })

  it("dispatchPreToolUse forwards arguments verbatim", async () => {
    enableAllEventHooks()
    const spy = jest
      .spyOn(getPluginEventHooks(), "dispatchPreToolUse")
      .mockResolvedValue({ action: "allow" } as never)
    const result = await dispatchPreToolUse("calc", { x: 1 }, "session_b")
    expect(result.action).toBe("allow")
    expect(spy).toHaveBeenCalledWith("calc", { x: 1 }, "session_b")
  })

  it("dispatchPostToolUse returns the dispatcher's merge result", async () => {
    enableAllEventHooks()
    jest
      .spyOn(getPluginEventHooks(), "dispatchPostToolUse")
      .mockResolvedValue({ modifiedResult: { ok: true } } as never)
    const result = await dispatchPostToolUse("calc", {}, { ok: false }, "s")
    expect(result.modifiedResult).toEqual({ ok: true })
  })

  it("dispatchOnAssistantMessage falls back to the input on dispatcher errors", async () => {
    getPluginLifecycleHooks().registerHooks("p1", { onMessageReceive: (m) => m })
    jest
      .spyOn(getPluginLifecycleHooks(), "dispatchOnMessageReceive")
      .mockRejectedValue(new Error("oops"))
    const message = { id: "x", role: "assistant" } as never
    const result = await dispatchOnAssistantMessage(message)
    expect(result).toBe(message)
  })

  it("stream dispatchers swallow hook errors", () => {
    enableAllEventHooks()
    jest.spyOn(getPluginEventHooks(), "dispatchStreamStart").mockImplementation(() => {
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
    enableAllEventHooks()
    const spy = jest
      .spyOn(getPluginEventHooks(), "dispatchPostChatReceive")
      .mockResolvedValue({} as never)
    await dispatchPostChatReceive({
      sessionId: "s",
      message: { id: "1", role: "assistant" } as never,
    })
    expect(spy).toHaveBeenCalled()
  })

  it("hasEventListeners reflects real enabled-plugin registration (false → true → false on disable)", () => {
    expect(__hasEventListenersForTests("onUserPromptSubmit")).toBe(false)
    enableAllEventHooks()
    expect(__hasEventListenersForTests("onUserPromptSubmit")).toBe(true)
    // A disabled plugin must not count — locks the enabled-only semantic.
    getStateMock.mockReturnValue({
      plugins: { p1: { status: "disabled", hooks: ALL_EVENT_HOOKS } },
    })
    expect(__hasEventListenersForTests("onUserPromptSubmit")).toBe(false)
  })

  it("hasListeners reflects real lifecycle-hook registration (false → true)", () => {
    expect(__hasListenersForTests("onMessageReceive")).toBe(false)
    getPluginLifecycleHooks().registerHooks("p1", { onMessageReceive: (m) => m })
    expect(__hasListenersForTests("onMessageReceive")).toBe(true)
  })

  it("skips dispatch entirely when no listeners are registered (the real fast path)", async () => {
    // Event path: empty store → predicate false → dispatcher never touched.
    const eventSpy = jest.spyOn(getPluginEventHooks(), "dispatchUserPromptSubmit")
    const result = await dispatchUserPromptSubmit("hi", "session_a")
    expect(result.action).toBe("proceed")
    expect(eventSpy).not.toHaveBeenCalled()

    // Lifecycle path: nothing registered → dispatcher never touched.
    const lifecycleSpy = jest.spyOn(getPluginLifecycleHooks(), "dispatchOnMessageReceive")
    const message = { id: "x", role: "assistant" } as never
    expect(await dispatchOnAssistantMessage(message)).toBe(message)
    expect(lifecycleSpy).not.toHaveBeenCalled()
  })
})
