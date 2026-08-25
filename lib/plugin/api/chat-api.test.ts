// The composer lives behind a window-event seam that `chat-api` reaches by
// dynamic import; stubbing the module keeps this suite in the fast node project
// instead of dragging the whole composer (and a DOM) in behind it.
const appended: Array<{ text?: string; sessionId?: string }> = []
jest.mock("@/components/chat/composer", () => ({
  dispatchComposerAppend: (detail: { text?: string; sessionId?: string }) => {
    appended.push(detail)
  },
}))

import { useChatStore } from "@/stores/chat"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
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

// -- composer write surface (ADR-0145) --------------------------------------

describe("chat write surface", () => {
  beforeEach(() => {
    __resetChatApiForTesting()
    // Through the store's own action, not `setState`: `contextSelections` is a
    // projection of the active session's slice (per-conversation composer
    // state), so overwriting the projected field leaves the slice populated and
    // the next add re-projects it.
    useChatStore.setState({ activeSessionId: "s-active" })
    useChatStore.getState().clearContextSelections()
    useComposerIntentStore.setState({ pendingBySession: {} })
    appended.length = 0
  })

  it("stamps the plugin id and kind rather than trusting the caller", () => {
    createChatAPI("wiki").addContextSelection({
      title: "Overview",
      snapshot: "the wiki body",
      sourceLabel: "wiki page",
      ref: "wiki:repo#overview",
      citations: [{ path: "src/main.ts", startLine: 10, endLine: 14 }],
    })

    expect(useChatStore.getState().contextSelections).toEqual([
      {
        kind: "plugin",
        pluginId: "wiki",
        title: "Overview",
        snapshot: "the wiki body",
        comment: "",
        sourceLabel: "wiki page",
        ref: "wiki:repo#overview",
        citations: [{ path: "src/main.ts", startLine: 10, endLine: 14 }],
      },
    ])
  })

  it("omits optional fields instead of staging undefined ones", () => {
    createChatAPI("wiki").addContextSelection({
      title: "Overview",
      snapshot: "body",
      sourceLabel: "wiki page",
      citations: [],
    })
    const [staged] = useChatStore.getState().contextSelections
    expect(staged).not.toHaveProperty("ref")
    expect(staged).not.toHaveProperty("citations")
  })

  it("appends to the addressed composer, and to the focused one when unaddressed", async () => {
    const api = createChatAPI("wiki")
    api.appendToComposer("hello", { sessionId: "s-2" })
    api.appendToComposer("world")
    await Promise.resolve()
    await Promise.resolve()
    expect(appended).toEqual([{ text: "hello", sessionId: "s-2" }, { text: "world" }])
  })

  it("does not dispatch an empty append", async () => {
    createChatAPI("wiki").appendToComposer("")
    await Promise.resolve()
    expect(appended).toEqual([])
  })

  it("stages an intent against the active session by default", () => {
    const candidateId = createChatAPI("wiki").stageIntent("Explain this module")
    expect(candidateId).toMatch(/^plugin_wiki_/)
    expect(useComposerIntentStore.getState().pendingBySession["s-active"]).toEqual({
      candidateId,
      prompt: "Explain this module",
    })
  })

  it("keeps auto-send opt-in", () => {
    const api = createChatAPI("wiki")
    api.stageIntent("draft", { sessionId: "s-2" })
    expect(useComposerIntentStore.getState().pendingBySession["s-2"]).not.toHaveProperty("autoSend")

    api.stageIntent("send it", { sessionId: "s-3", autoSend: true })
    expect(useComposerIntentStore.getState().pendingBySession["s-3"]).toMatchObject({
      autoSend: true,
    })
  })

  it("refuses to stage an intent with no session to stage it against", () => {
    useChatStore.setState({ activeSessionId: null })
    expect(() => createChatAPI("wiki").stageIntent("hi")).toThrow(/no session/i)
  })
})
