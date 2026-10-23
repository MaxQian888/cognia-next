import * as sdk from "./chat-middleware"
import type {
  ChatMiddleware,
  ChatMiddlewareEvent,
  ChatMiddlewareNext,
  ChatMiddlewareRegistration,
  ChatMiddlewareRequest,
  ChatMiddlewareResponse,
  PluginChatAPI,
  PluginChatMiddlewareDef,
  RegisterChatMiddlewareArgs,
  RegisterChatMiddlewaresOptions,
} from "./chat-middleware"

describe("plugin-sdk api/chat-middleware", () => {
  it("exposes the authoring helper and the chat-middleware registry", () => {
    expect(typeof sdk.defineChatMiddleware).toBe("function")
    expect(typeof sdk.registerChatMiddleware).toBe("function")
    expect(typeof sdk.unregisterChatMiddleware).toBe("function")
    expect(typeof sdk.clearChatMiddlewaresForPlugin).toBe("function")
    expect(typeof sdk.listActiveChatMiddlewares).toBe("function")
    expect(typeof sdk.listAllChatMiddlewares).toBe("function")
    expect(typeof sdk.getChatMiddleware).toBe("function")
    expect(typeof sdk.subscribeChatMiddlewareRegistry).toBe("function")
    expect(sdk.DEFAULT_MIDDLEWARE_TIMEOUT_MS).toBeGreaterThan(0)
    expect(sdk.MAX_MIDDLEWARE_TIMEOUT_MS).toBeGreaterThan(sdk.DEFAULT_MIDDLEWARE_TIMEOUT_MS)
  })

  it("keeps host wiring off the author surface (plugins reach it through ctx.chat)", () => {
    expect(sdk).not.toHaveProperty("registerChatMiddlewaresForPlugin")
    expect(sdk).not.toHaveProperty("unregisterChatMiddlewaresForPlugin")
    expect(sdk).not.toHaveProperty("createChatAPI")
    expect(sdk).not.toHaveProperty("clearChatMiddlewaresForPluginContext")
    expect(sdk).not.toHaveProperty("recordMiddlewareFailure")
    expect(sdk).not.toHaveProperty("recordMiddlewareSuccess")
    expect(sdk).not.toHaveProperty("resetChatMiddlewareBreaker")
  })

  it("defineChatMiddleware is a typesafe identity function", () => {
    const def = sdk.defineChatMiddleware({
      id: "rewrite-system-prompt",
      label: "Rewrite system prompt",
      entry: "dist/chat.js",
      export: "rewriteSystemPrompt",
      priority: 20,
      timeoutMs: 1000,
    })

    expect(def.id).toBe("rewrite-system-prompt")
    expect(def.export).toBe("rewriteSystemPrompt")
  })

  it("re-exports chat middleware bridge, registry, and runtime types", () => {
    const assertTypes = <
      _T extends
        | PluginChatMiddlewareDef
        | ChatMiddleware
        | ChatMiddlewareRequest
        | ChatMiddlewareResponse
        | ChatMiddlewareNext
        | PluginChatAPI
        | ChatMiddlewareRegistration
        | ChatMiddlewareEvent
        | RegisterChatMiddlewareArgs
        | RegisterChatMiddlewaresOptions,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
