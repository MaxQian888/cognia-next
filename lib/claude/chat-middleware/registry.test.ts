import {
  CIRCUIT_BREAKER_THRESHOLD,
  __resetChatMiddlewareRegistryForTesting,
  clearChatMiddlewaresForPlugin,
  listActiveChatMiddlewares,
  listAllChatMiddlewares,
  recordMiddlewareFailure,
  recordMiddlewareSuccess,
  registerChatMiddleware,
  resetChatMiddlewareBreaker,
  subscribeChatMiddlewareRegistry,
  unregisterChatMiddleware,
  type ChatMiddlewareEvent,
} from "./registry"
import type { ChatMiddleware } from "@/types/plugin/plugin-chat-middleware"

const noop: ChatMiddleware = async (_req, next) => next()

describe("chat-middleware registry", () => {
  beforeEach(() => {
    __resetChatMiddlewareRegistryForTesting()
  })

  it("registers a middleware and exposes it via list functions", () => {
    registerChatMiddleware({ pluginId: "p", middlewareId: "m", fn: noop })
    expect(listActiveChatMiddlewares()).toHaveLength(1)
    expect(listAllChatMiddlewares()).toHaveLength(1)
    expect(listActiveChatMiddlewares()[0]!.fullId).toBe("p:m")
  })

  it("rejects duplicate middlewareIds from the same plugin", () => {
    registerChatMiddleware({ pluginId: "p", middlewareId: "m", fn: noop })
    expect(() => registerChatMiddleware({ pluginId: "p", middlewareId: "m", fn: noop })).toThrow(
      /already registered/i
    )
  })

  it("clamps oversized timeouts to the maximum", () => {
    registerChatMiddleware({
      pluginId: "p",
      middlewareId: "m",
      fn: noop,
      timeoutMs: 999_999,
    })
    expect(listAllChatMiddlewares()[0]!.timeoutMs).toBe(60_000)
  })

  it("defaults timeout to 5000ms when missing or invalid", () => {
    registerChatMiddleware({ pluginId: "p", middlewareId: "a", fn: noop })
    registerChatMiddleware({
      pluginId: "p",
      middlewareId: "b",
      fn: noop,
      timeoutMs: -1,
    })
    const all = listAllChatMiddlewares()
    expect(all.find((m) => m.fullId === "p:a")!.timeoutMs).toBe(5000)
    expect(all.find((m) => m.fullId === "p:b")!.timeoutMs).toBe(5000)
  })

  it("orders active middlewares by priority desc then plugin id", () => {
    registerChatMiddleware({ pluginId: "b", middlewareId: "x", fn: noop, priority: 5 })
    registerChatMiddleware({ pluginId: "a", middlewareId: "y", fn: noop, priority: 5 })
    registerChatMiddleware({ pluginId: "c", middlewareId: "z", fn: noop, priority: 10 })
    const ids = listActiveChatMiddlewares().map((m) => m.fullId)
    expect(ids).toEqual(["c:z", "a:y", "b:x"])
  })

  it("trips the breaker after exactly N consecutive failures", () => {
    registerChatMiddleware({ pluginId: "p", middlewareId: "m", fn: noop })
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD - 1; i++) {
      const tripped = recordMiddlewareFailure("p:m", "boom")
      expect(tripped).toBe(false)
    }
    const tripped = recordMiddlewareFailure("p:m", "boom")
    expect(tripped).toBe(true)
    expect(listActiveChatMiddlewares()).toHaveLength(0)
    expect(listAllChatMiddlewares()[0]!.breakerTripped).toBe(true)
  })

  it("resets the failure counter on success", () => {
    registerChatMiddleware({ pluginId: "p", middlewareId: "m", fn: noop })
    recordMiddlewareFailure("p:m", "boom")
    recordMiddlewareFailure("p:m", "boom")
    recordMiddlewareSuccess("p:m")
    expect(listAllChatMiddlewares()[0]!.consecutiveFailures).toBe(0)
    expect(listAllChatMiddlewares()[0]!.disabled).toBe(false)
  })

  it("resetChatMiddlewareBreaker un-trips a tripped breaker", () => {
    registerChatMiddleware({ pluginId: "p", middlewareId: "m", fn: noop })
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) recordMiddlewareFailure("p:m", "boom")
    expect(listActiveChatMiddlewares()).toHaveLength(0)
    expect(resetChatMiddlewareBreaker("p:m")).toBe(true)
    expect(listActiveChatMiddlewares()).toHaveLength(1)
  })

  it("clearChatMiddlewaresForPlugin drops every middleware the plugin owns", () => {
    registerChatMiddleware({ pluginId: "p", middlewareId: "a", fn: noop })
    registerChatMiddleware({ pluginId: "p", middlewareId: "b", fn: noop })
    registerChatMiddleware({ pluginId: "q", middlewareId: "c", fn: noop })
    clearChatMiddlewaresForPlugin("p")
    expect(listAllChatMiddlewares().map((m) => m.fullId)).toEqual(["q:c"])
  })

  it("emits registered + unregistered events to subscribers", () => {
    const events: ChatMiddlewareEvent[] = []
    const unsubscribe = subscribeChatMiddlewareRegistry((e) => events.push(e))
    registerChatMiddleware({ pluginId: "p", middlewareId: "m", fn: noop })
    unregisterChatMiddleware("p:m")
    unsubscribe()
    expect(events.map((e) => e.type)).toEqual(["registered", "unregistered"])
  })

  it("emits breaker-tripped on threshold crossing", () => {
    const events: ChatMiddlewareEvent[] = []
    subscribeChatMiddlewareRegistry((e) => events.push(e))
    registerChatMiddleware({ pluginId: "p", middlewareId: "m", fn: noop })
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) recordMiddlewareFailure("p:m", "boom")
    expect(events.some((e) => e.type === "breaker-tripped")).toBe(true)
  })
})
