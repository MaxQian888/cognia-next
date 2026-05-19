import {
  __resetChatApiForTesting,
  clearChatMiddlewaresForPluginContext,
  createChatAPI,
} from "./chat-api"
import {
  __resetChatMiddlewareRegistryForTesting,
  listAllChatMiddlewares,
} from "@/lib/claude/chat-middleware/registry"
import type { ChatMiddleware } from "@/types/plugin/plugin-chat-middleware"

const noop: ChatMiddleware = async (_req, next) => next()

describe("createChatAPI", () => {
  beforeEach(() => {
    __resetChatApiForTesting()
    __resetChatMiddlewareRegistryForTesting()
  })

  it("registers a middleware under the plugin id", () => {
    const api = createChatAPI("p")
    api.use(noop, { id: "m" })
    expect(listAllChatMiddlewares().map((m) => m.fullId)).toEqual(["p:m"])
  })

  it("auto-generates an id when not provided", () => {
    const api = createChatAPI("p")
    api.use(noop)
    const fullId = listAllChatMiddlewares()[0]!.fullId
    expect(fullId).toMatch(/^p:m_/)
  })

  it("rejects two registrations with the same explicit id from the same plugin", () => {
    const api = createChatAPI("p")
    api.use(noop, { id: "m" })
    expect(() => api.use(noop, { id: "m" })).toThrow(/already registered/i)
  })

  it("disposer unregisters the middleware", () => {
    const api = createChatAPI("p")
    const dispose = api.use(noop, { id: "m" })
    expect(listAllChatMiddlewares()).toHaveLength(1)
    dispose()
    expect(listAllChatMiddlewares()).toHaveLength(0)
  })

  it("clearChatMiddlewaresForPluginContext drops every middleware the plugin owns", () => {
    createChatAPI("p").use(noop, { id: "a" })
    createChatAPI("p").use(noop, { id: "b" })
    createChatAPI("q").use(noop, { id: "c" })
    clearChatMiddlewaresForPluginContext("p")
    expect(listAllChatMiddlewares().map((m) => m.fullId)).toEqual(["q:c"])
  })

  it("forwards priority and timeoutMs to the registry", () => {
    const api = createChatAPI("p")
    api.use(noop, { id: "m", priority: 7, timeoutMs: 1234 })
    const reg = listAllChatMiddlewares()[0]!
    expect(reg.priority).toBe(7)
    expect(reg.timeoutMs).toBe(1234)
  })
})
