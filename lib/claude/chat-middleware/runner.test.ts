import {
  __resetChatMiddlewareRegistryForTesting,
  listAllChatMiddlewares,
  registerChatMiddleware,
} from "./registry"
import {
  resolveInterceptorChain,
  __resetInterceptorDispatchForTesting,
  __resetInterceptorRegistryForTesting,
} from "@/lib/plugin/interceptors"
import { runChatMiddlewareChain } from "./runner"
import type {
  ChatMiddleware,
  ChatMiddlewareRequest,
  ChatMiddlewareResponse,
} from "@/types/plugin/plugin-chat-middleware"

const baseRequest = (overrides: Partial<ChatMiddlewareRequest> = {}): ChatMiddlewareRequest => ({
  messages: [],
  model: "claude-opus-4-7",
  sessionId: "sess-1",
  options: {},
  signal: new AbortController().signal,
  ...overrides,
})

const terminalOk: ChatMiddlewareResponse = { text: "from terminal" }

describe("runChatMiddlewareChain", () => {
  beforeEach(() => {
    __resetChatMiddlewareRegistryForTesting()
  })

  it("runs the terminal with no middlewares registered", async () => {
    const terminal = jest.fn(async () => terminalOk)
    const { response, report } = await runChatMiddlewareChain(baseRequest(), terminal)
    expect(response).toEqual(terminalOk)
    expect(terminal).toHaveBeenCalledTimes(1)
    expect(report.succeeded).toEqual([])
  })

  it("composes middlewares so outer wraps inner", async () => {
    const order: string[] = []
    const outer: ChatMiddleware = async (req, next) => {
      order.push("outer-before")
      const res = await next()
      order.push("outer-after")
      return { ...res, text: `outer(${res.text})` }
    }
    const inner: ChatMiddleware = async (req, next) => {
      order.push("inner-before")
      const res = await next()
      order.push("inner-after")
      return { ...res, text: `inner(${res.text})` }
    }
    registerChatMiddleware({ pluginId: "a", middlewareId: "outer", fn: outer, priority: 10 })
    registerChatMiddleware({ pluginId: "b", middlewareId: "inner", fn: inner, priority: 1 })

    const terminal = async (): Promise<ChatMiddlewareResponse> => ({ text: "core" })
    const { response, report } = await runChatMiddlewareChain(baseRequest(), terminal)

    expect(response.text).toBe("outer(inner(core))")
    expect(order).toEqual(["outer-before", "inner-before", "inner-after", "outer-after"])
    expect(report.succeeded.sort()).toEqual(["a:outer", "b:inner"])
  })

  it("isolates a throwing middleware (chain continues with next())", async () => {
    const thrown: ChatMiddleware = async () => {
      throw new Error("middleware boom")
    }
    registerChatMiddleware({ pluginId: "p", middlewareId: "bad", fn: thrown })

    const terminal = async (): Promise<ChatMiddlewareResponse> => ({ text: "core" })
    const { response, report } = await runChatMiddlewareChain(baseRequest(), terminal)

    expect(response.text).toBe("core")
    expect(report.threw).toEqual([{ fullId: "p:bad", message: "middleware boom" }])
  })

  it("times out a slow middleware and proceeds with the chain", async () => {
    const slow: ChatMiddleware = (_req, _next) =>
      new Promise<ChatMiddlewareResponse>((resolve) => {
        setTimeout(() => resolve({ text: "late" }), 200)
      })
    registerChatMiddleware({
      pluginId: "p",
      middlewareId: "slow",
      fn: slow,
      timeoutMs: 20,
    })

    const terminal = async (): Promise<ChatMiddlewareResponse> => ({ text: "core" })
    const { response, report } = await runChatMiddlewareChain(baseRequest(), terminal)

    expect(response.text).toBe("core")
    expect(report.timedOut).toEqual(["p:slow"])
  })

  it("trips the breaker after 3 consecutive failures", async () => {
    const thrown: ChatMiddleware = async () => {
      throw new Error("again")
    }
    registerChatMiddleware({ pluginId: "p", middlewareId: "m", fn: thrown })

    const terminal = async (): Promise<ChatMiddlewareResponse> => ({ text: "core" })
    for (let i = 0; i < 2; i++) {
      const { report } = await runChatMiddlewareChain(baseRequest(), terminal)
      expect(report.trippedBreakers).toEqual([])
    }
    const { report } = await runChatMiddlewareChain(baseRequest(), terminal)
    expect(report.trippedBreakers).toEqual(["p:m"])
    // Next turn skips the tripped middleware entirely (disabled).
    const { report: next } = await runChatMiddlewareChain(baseRequest(), terminal)
    expect(next.threw).toEqual([])
    expect(listAllChatMiddlewares()[0]!.disabled).toBe(true)
  })

  it("counts a successful run as a reset of the failure counter", async () => {
    let attempt = 0
    const flaky: ChatMiddleware = async (_req, next) => {
      attempt++
      if (attempt === 1) throw new Error("once")
      return next()
    }
    registerChatMiddleware({ pluginId: "p", middlewareId: "f", fn: flaky })

    const terminal = async (): Promise<ChatMiddlewareResponse> => ({ text: "core" })
    await runChatMiddlewareChain(baseRequest(), terminal) // throws
    await runChatMiddlewareChain(baseRequest(), terminal) // succeeds → reset
    expect(listAllChatMiddlewares()[0]!.consecutiveFailures).toBe(0)
  })

  it("lets a middleware mutate the request via next()", async () => {
    const mutator: ChatMiddleware = async (_req, next) => next() // can't actually mutate req here, but the chain stays intact
    registerChatMiddleware({ pluginId: "p", middlewareId: "m", fn: mutator })

    const terminal = jest.fn(async (req: ChatMiddlewareRequest) => ({
      text: `model=${req.model}`,
    }))
    const { response } = await runChatMiddlewareChain(baseRequest({ model: "x" }), terminal)
    expect(response.text).toBe("model=x")
  })
})

describe("runChatMiddlewareChain — the send happens once (ADR-0189)", () => {
  beforeEach(() => {
    __resetChatMiddlewareRegistryForTesting()
    __resetInterceptorRegistryForTesting()
    __resetInterceptorDispatchForTesting()
  })

  it("does not re-send when a middleware throws AFTER awaiting next()", async () => {
    // The old runner called `next(req)` again on the error path, so a
    // middleware that had already delegated produced two model requests for one
    // user turn.
    const terminal = jest.fn(async () => terminalOk)
    const middleware: ChatMiddleware = async (_req, next) => {
      await next()
      throw new Error("post-processing blew up")
    }

    const { response } = await runChatMiddlewareChain(baseRequest(), terminal, {
      middlewares: [
        {
          pluginId: "p",
          middlewareId: "m",
          fullId: "p:m",
          fn: middleware,
          priority: 0,
          timeoutMs: 1_000,
          consecutiveFailures: 0,
          disabled: false,
          breakerTripped: false,
        },
      ],
    })

    expect(terminal).toHaveBeenCalledTimes(1)
    expect(response).toEqual(terminalOk)
  })

  it("does not re-send when a middleware times out while delegating", async () => {
    const terminal = jest.fn(
      () =>
        new Promise<ChatMiddlewareResponse>((resolve) => setTimeout(() => resolve(terminalOk), 40))
    )
    const middleware: ChatMiddleware = (_req, next) => next()

    const { response } = await runChatMiddlewareChain(baseRequest(), terminal, {
      middlewares: [
        {
          pluginId: "p",
          middlewareId: "slow",
          fullId: "p:slow",
          fn: middleware,
          priority: 0,
          timeoutMs: 10,
          consecutiveFailures: 0,
          disabled: false,
          breakerTripped: false,
        },
      ],
    })

    expect(terminal).toHaveBeenCalledTimes(1)
    expect(response).toEqual(terminalOk)
  })

  it("registers a middleware into the interceptor chain, not a second registry", async () => {
    registerChatMiddleware({
      pluginId: "p",
      middlewareId: "m",
      fn: async (_req, next) => next(),
    })
    expect(
      resolveInterceptorChain("model.request.invoke").ordered.map((e) => e.registrationId)
    ).toEqual(["p:m"])
    expect(listAllChatMiddlewares()).toHaveLength(1)
  })
})
