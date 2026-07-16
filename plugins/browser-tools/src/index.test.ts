jest.mock("@/lib/browser/agent-engine", () => {
  // Stateful current URL: navigate moves it, getPage reports it — mirroring the
  // real engine so the live-URL trust gating is exercisable (incl. redirects
  // via __setUrl).
  const state = { url: "http://localhost/" }
  const engine = {
    navigate: jest.fn(async (u: string) => {
      state.url = u
    }),
    snapshot: jest.fn(async () => ({
      generation: 3,
      url: "http://localhost/",
      title: "t",
      nodes: [],
    })),
    act: jest.fn(async () => ({ ok: true, error: null, generation: 3 })),
    pressKey: jest.fn(async () => ({ ok: true, error: null, generation: 3 })),
    scroll: jest.fn(async () => ({ ok: true, error: null, generation: 3 })),
    evaluate: jest.fn(async () => ({ ok: true, value: "Home" })),
    readConsole: jest.fn(async () => [{ level: "warn", text: "x", ts: 1 }]),
    readNetwork: jest.fn(async () => []),
    getPage: jest.fn(async () => ({ url: state.url, title: "t" })),
    back: jest.fn(async () => {}),
    forward: jest.fn(async () => {}),
    reload: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
    waitForText: jest.fn(async () => ({ ok: true, timedOut: false })),
    waitForSelector: jest.fn(async () => ({ ok: true, timedOut: false })),
    waitForNetworkIdle: jest.fn(async () => ({ ok: true, timedOut: false })),
    waitForLoad: jest.fn(async () => ({ ok: true, timedOut: false })),
    screenshot: jest.fn(async () => ({ bytes: "AAAA", width: 10, height: 10, capturedAt: 0 })),
  }
  return {
    __engine: engine,
    __setUrl: (u: string) => {
      state.url = u
    },
    // URL-aware so the public-URL (untrusted) branch is exercisable: anything
    // off localhost is treated as a public origin, mirroring resolveTrustTier.
    routeEngine: (url: string) => {
      const trusted = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url ?? "")
      return {
        engine,
        tier: trusted ? "trusted" : "public",
        untrusted: !trusted,
      }
    },
  }
})
jest.mock("@cognia/plugin-sdk", () => ({
  defineContextProvider: (p: unknown) => p,
}))
jest.mock("@/lib/db/browser-annotations", () => ({
  saveBrowserAnnotation: jest.fn(async () => {}),
}))
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: { getState: jest.fn(() => ({ activeSessionId: "session-1" })) },
}))

import definition from "@/plugins/browser-tools/src/index"
import * as engineModule from "@/lib/browser/agent-engine"
import { saveBrowserAnnotation } from "@/lib/db/browser-annotations"
import { useChatStore } from "@/stores/chat/chat-store"

const engine = (engineModule as unknown as { __engine: Record<string, jest.Mock> }).__engine
const setLiveUrl = (engineModule as unknown as { __setUrl: (u: string) => void }).__setUrl
const saveBrowserAnnotationMock = saveBrowserAnnotation as jest.Mock
const activeSessionMock = useChatStore.getState as jest.Mock

type Tools = Record<string, (args: unknown) => Promise<unknown>>
type ToolRegistration = {
  name: string
  definition: {
    description: string
    parametersSchema: {
      required?: string[]
      properties?: Record<string, { enum?: readonly string[] }>
    }
  }
  execute: (args: unknown) => Promise<unknown>
}

async function collectTools(): Promise<Tools> {
  const tools: Tools = {}
  const ctx = {
    pluginId: "cognia-browser-tools",
    logger: { info: jest.fn() },
    agent: {
      registerTool: (t: { name: string; execute: (a: unknown) => Promise<unknown> }) => {
        tools[t.name] = t.execute
      },
      context: { registerProvider: jest.fn() },
    },
  }
  await definition.activate!(ctx as never)
  return tools
}

async function collectRegistrations(): Promise<Record<string, ToolRegistration>> {
  const registrations: Record<string, ToolRegistration> = {}
  await definition.activate!({
    pluginId: "cognia-browser-tools",
    logger: { info: jest.fn() },
    agent: {
      registerTool: (tool: ToolRegistration) => {
        registrations[tool.name] = tool
      },
      context: { registerProvider: jest.fn() },
    },
  } as never)
  return registrations
}

beforeEach(() => {
  Object.values(engine).forEach((m) => m.mockClear())
  saveBrowserAnnotationMock.mockClear()
  activeSessionMock.mockReturnValue({ activeSessionId: "session-1" })
  setLiveUrl("http://localhost/")
})

describe("browser-tools plugin", () => {
  it("registers the full Phase-1 tool surface", async () => {
    const tools = await collectTools()
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining([
        "browser_navigate",
        "browser_snapshot",
        "browser_annotate",
        "browser_click",
        "browser_type",
        "browser_fill_form",
        "browser_select",
        "browser_hover",
        "browser_read_console",
        "browser_read_network",
        "browser_get_page",
        "browser_press_key",
        "browser_scroll",
        "browser_evaluate",
      ])
    )
  })

  it("browser_annotate resolves the live ref and saves a pending annotation", async () => {
    const selection = {
      paneId: "browser-preview",
      selector: "#hero-cta",
      domPath: "html > body > button#hero-cta",
      tagName: "BUTTON",
      id: "hero-cta",
      classes: "primary",
      rect: { x: 20, y: 100, width: 160, height: 44 },
      outerHTML: '<button id="hero-cta">Start</button>',
      text: "Start",
      pageUrl: "http://localhost:3000/pricing",
      pageTitle: "Pricing",
      viewport: { width: 1280, height: 800 },
    }
    engine.evaluate.mockResolvedValueOnce({
      ok: true,
      value: JSON.stringify({ ok: true, error: null, selection }),
    })
    const tools = await collectTools()
    const result = (await tools.browser_annotate({
      ref: "e7",
      comment: "  The CTA lacks visual hierarchy. Increase contrast or isolate it.  ",
      intent: "change",
      severity: "important",
    })) as { ok: boolean; annotation: { status: string; baseUrl: string } }

    expect(engine.evaluate).toHaveBeenCalledWith('window.__cogniaSelectionForRef("e7")')
    expect(saveBrowserAnnotationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        baseUrl: "http://localhost:3000",
        selection,
        comment: "The CTA lacks visual hierarchy. Increase contrast or isolate it.",
        intent: "change",
        severity: "important",
        status: "pending",
        thread: [],
      })
    )
    expect(result.ok).toBe(true)
    expect(result.annotation).toMatchObject({
      status: "pending",
      baseUrl: "http://localhost:3000",
    })
  })

  it("browser_annotate exposes the strict critique contract", async () => {
    const registrations = await collectRegistrations()
    const contract = registrations.browser_annotate.definition
    expect(contract.parametersSchema.required).toEqual(["ref", "comment", "intent", "severity"])
    expect(contract.parametersSchema.properties?.intent.enum).toEqual([
      "fix",
      "change",
      "question",
      "approve",
    ])
    expect(contract.parametersSchema.properties?.severity.enum).toEqual([
      "blocking",
      "important",
      "suggestion",
    ])
    expect(contract.description).toMatch(/2–3 sentences/)
    expect(contract.description).toMatch(/comparable product/)
    expect(contract.description).toMatch(/spacing rhythm/)
  })

  it("browser_annotate rejects stale refs without persisting", async () => {
    engine.evaluate.mockResolvedValueOnce({
      ok: true,
      value: JSON.stringify({ ok: false, error: "Unknown or stale ref: e2", selection: null }),
    })
    const tools = await collectTools()
    const result = (await tools.browser_annotate({
      ref: "e2",
      comment: "This navigation treatment is unclear.",
      intent: "fix",
      severity: "blocking",
    })) as { ok: boolean; error: string }

    expect(result).toEqual({ ok: false, error: "Unknown or stale ref: e2" })
    expect(saveBrowserAnnotationMock).not.toHaveBeenCalled()
  })

  it("browser_annotate enforces intent and severity at execution time", async () => {
    const tools = await collectTools()
    await expect(
      tools.browser_annotate({
        ref: "e1",
        comment: "Critique",
        intent: "delete",
        severity: "urgent",
      })
    ).resolves.toEqual({ ok: false, error: "intent must be fix, change, question, or approve" })
    await expect(
      tools.browser_annotate({
        ref: "e1",
        comment: "Critique",
        intent: "fix",
        severity: "urgent",
      })
    ).resolves.toEqual({
      ok: false,
      error: "severity must be blocking, important, or suggestion",
    })
    expect(engine.evaluate).not.toHaveBeenCalled()
  })

  it("browser_annotate requires an active chat session", async () => {
    activeSessionMock.mockReturnValueOnce({ activeSessionId: undefined })
    const tools = await collectTools()
    const result = await tools.browser_annotate({
      ref: "e1",
      comment: "Critique",
      intent: "question",
      severity: "suggestion",
    })
    expect(result).toEqual({ ok: false, error: "No active chat session" })
    expect(engine.evaluate).not.toHaveBeenCalled()
  })

  it("browser_press_key forwards the chord (and optional ref) and refreshes the snapshot", async () => {
    const tools = await collectTools()
    const res = (await tools.browser_press_key({ key: "ctrl+a", ref: "e1" })) as {
      result: { ok: boolean }
      snapshot: { generation: number }
    }
    expect(engine.pressKey).toHaveBeenCalledWith("ctrl+a", "e1")
    expect(res.result.ok).toBe(true)
    expect(res.snapshot.generation).toBe(3)
  })

  it("browser_scroll forwards ref/direction/amount", async () => {
    const tools = await collectTools()
    await tools.browser_scroll({ direction: "bottom", amount: 200 })
    expect(engine.scroll).toHaveBeenCalledWith({
      reference: undefined,
      direction: "bottom",
      amount: 200,
    })
  })

  it("browser_click forwards modifiers when given", async () => {
    const tools = await collectTools()
    await tools.browser_click({ ref: "e1", modifiers: ["ctrl"] })
    expect(engine.act).toHaveBeenCalledWith("e1", "click", { modifiers: ["ctrl"] })
  })

  it("browser_snapshot forwards includeText", async () => {
    const tools = await collectTools()
    await tools.browser_snapshot({ includeText: true })
    expect(engine.snapshot).toHaveBeenCalledWith({ includeText: true })
  })

  it("browser_evaluate runs on the trusted localhost preview", async () => {
    const tools = await collectTools()
    await tools.browser_navigate({ url: "http://localhost:3000/" })
    const res = (await tools.browser_evaluate({ expression: "document.title" })) as {
      ok: boolean
      value: unknown
    }
    expect(engine.evaluate).toHaveBeenCalledWith("document.title")
    expect(res).toEqual({ ok: true, value: "Home" })
  })

  it("browser_evaluate is blocked on a public (untrusted) origin", async () => {
    const tools = await collectTools()
    await tools.browser_navigate({ url: "https://example.com/" })
    const res = (await tools.browser_evaluate({ expression: "document.cookie" })) as {
      ok: boolean
      error: string
    }
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/mcp__playwright__/)
    expect(engine.evaluate).not.toHaveBeenCalled()
    // Restore trusted origin for any later tests sharing module state.
    await tools.browser_navigate({ url: "http://localhost:3000/" })
  })

  it("browser_evaluate is blocked when the page redirected off localhost since the last navigate", async () => {
    const tools = await collectTools()
    await tools.browser_navigate({ url: "http://localhost:3000/" })
    // The page redirected (or the human navigated) to a public origin.
    setLiveUrl("https://evil.example/phish")
    const res = (await tools.browser_evaluate({ expression: "document.cookie" })) as {
      ok: boolean
      error: string
    }
    expect(res.ok).toBe(false)
    expect(engine.evaluate).not.toHaveBeenCalled()
  })

  it("browser_evaluate falls back to the last known url when the live page is unreadable", async () => {
    const tools = await collectTools()
    await tools.browser_navigate({ url: "http://localhost:3000/" })
    engine.getPage.mockRejectedValueOnce(new Error("preview is not open"))
    const res = (await tools.browser_evaluate({ expression: "1+1" })) as { ok: boolean }
    expect(res.ok).toBe(true)
    expect(engine.evaluate).toHaveBeenCalledWith("1+1")
  })

  it("browser_wait_for waits on a CSS selector when given", async () => {
    const tools = await collectTools()
    await tools.browser_wait_for({ selector: ".ready", timeoutMs: 500 })
    expect(engine.waitForSelector).toHaveBeenCalledWith(".ready", {
      mode: undefined,
      timeoutMs: 500,
    })
    expect(engine.waitForText).not.toHaveBeenCalled()
  })

  it("browser_wait_for waits for network idle when requested", async () => {
    const tools = await collectTools()
    await tools.browser_wait_for({ networkIdle: true, timeoutMs: 800 })
    expect(engine.waitForNetworkIdle).toHaveBeenCalledWith({ timeoutMs: 800 })
  })

  it("browser_navigate sets the url and returns a fresh snapshot + untrusted flag", async () => {
    const tools = await collectTools()
    const res = (await tools.browser_navigate({ url: "http://localhost:3000/" })) as {
      navigated: string
      snapshot: { generation: number }
      untrusted: boolean
    }
    expect(engine.navigate).toHaveBeenCalledWith("http://localhost:3000/")
    // Waits for the target document to load before snapshotting.
    expect(engine.waitForLoad).toHaveBeenCalledWith(
      expect.objectContaining({ targetUrl: "http://localhost:3000/" })
    )
    expect(res.navigated).toBe("http://localhost:3000/")
    expect(res.snapshot.generation).toBe(3)
    expect(res.untrusted).toBe(false)
    expect("hint" in res).toBe(false)
  })

  it("browser_navigate flags untrusted from the LANDED url when a redirect leaves localhost", async () => {
    const tools = await collectTools()
    engine.navigate.mockImplementationOnce(async () => {
      // Server-side redirect: asked for localhost, landed on a public origin.
      setLiveUrl("https://sso.example.com/login")
    })
    const res = (await tools.browser_navigate({ url: "http://localhost:3000/admin" })) as {
      untrusted: boolean
    }
    expect(res.untrusted).toBe(true)
  })

  it("browser_navigate to a PUBLIC url flags untrusted and steers to the Playwright MCP tools", async () => {
    const tools = await collectTools()
    const res = (await tools.browser_navigate({ url: "https://example.com/" })) as {
      untrusted: boolean
      hint?: string
    }
    expect(res.untrusted).toBe(true)
    expect(res.hint).toMatch(/mcp__playwright__/)
  })

  it("browser_click acts by ref and returns a refreshed snapshot", async () => {
    const tools = await collectTools()
    const res = (await tools.browser_click({ ref: "e1" })) as {
      result: { ok: boolean }
      snapshot: { generation: number }
    }
    expect(engine.act).toHaveBeenCalledWith("e1", "click", {})
    expect(res.result.ok).toBe(true)
    expect(res.snapshot.generation).toBe(3)
  })

  it("browser_fill_form forwards the text arg", async () => {
    const tools = await collectTools()
    await tools.browser_fill_form({ ref: "e2", text: "hello" })
    expect(engine.act).toHaveBeenCalledWith("e2", "fill", { text: "hello" })
  })

  it("browser_read_console returns drained entries", async () => {
    const tools = await collectTools()
    const res = (await tools.browser_read_console({})) as { entries: unknown[] }
    expect(res.entries).toHaveLength(1)
  })

  it("browser_snapshot returns the raw snapshot", async () => {
    const tools = await collectTools()
    const snap = (await tools.browser_snapshot({})) as { generation: number }
    expect(snap.generation).toBe(3)
    expect(engine.snapshot).toHaveBeenCalled()
  })

  it("browser_type / browser_select / browser_hover forward their args", async () => {
    const tools = await collectTools()
    await tools.browser_type({ ref: "e1", text: "hi" })
    await tools.browser_select({ ref: "e2", value: "v" })
    await tools.browser_hover({ ref: "e3" })
    expect(engine.act).toHaveBeenNthCalledWith(1, "e1", "type", { text: "hi" })
    expect(engine.act).toHaveBeenNthCalledWith(2, "e2", "select", { value: "v" })
    expect(engine.act).toHaveBeenNthCalledWith(3, "e3", "hover", {})
  })

  it("nav tools (back/forward/reload/stop) run and return a fresh snapshot", async () => {
    const tools = await collectTools()
    const back = (await tools.browser_back({})) as { ok: boolean; snapshot: { generation: number } }
    expect(engine.back).toHaveBeenCalled()
    expect(back.ok).toBe(true)
    expect(back.snapshot.generation).toBe(3)
    // Same-URL loads get a settle delay so the readyState check can't pass on
    // the OLD document before the reload/back even starts.
    expect(engine.waitForLoad).toHaveBeenCalledWith(
      expect.objectContaining({ initialDelayMs: 250 })
    )
    await tools.browser_forward({})
    await tools.browser_reload({})
    await tools.browser_stop({})
    expect(engine.forward).toHaveBeenCalled()
    expect(engine.reload).toHaveBeenCalled()
    expect(engine.stop).toHaveBeenCalled()
  })

  it("browser_wait_for forwards text/mode/timeout and returns result + snapshot", async () => {
    const tools = await collectTools()
    const res = (await tools.browser_wait_for({
      text: "Done",
      mode: "appear",
      timeoutMs: 1000,
    })) as {
      result: { ok: boolean }
      snapshot: { generation: number }
    }
    expect(engine.waitForText).toHaveBeenCalledWith("Done", { mode: "appear", timeoutMs: 1000 })
    expect(res.result.ok).toBe(true)
    expect(res.snapshot.generation).toBe(3)
  })

  it("browser_screenshot returns ok + base64 on success", async () => {
    const tools = await collectTools()
    const res = (await tools.browser_screenshot({})) as { ok: boolean; base64: string }
    expect(engine.screenshot).toHaveBeenCalled()
    expect(res).toMatchObject({ ok: true, base64: "AAAA", width: 10, height: 10 })
  })

  it("browser_screenshot returns ok:false when no preview is open", async () => {
    engine.screenshot.mockRejectedValueOnce(new Error("preview is not open"))
    const tools = await collectTools()
    const res = (await tools.browser_screenshot({})) as { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not open/)
  })

  it("browser_read_network and browser_get_page delegate", async () => {
    const tools = await collectTools()
    const net = (await tools.browser_read_network({})) as { entries: unknown[] }
    expect(net.entries).toEqual([])
    const page = (await tools.browser_get_page({})) as { url: string; title: string }
    expect(page).toEqual({ url: "http://localhost/", title: "t" })
  })

  it("ignores activation when the host exposes no registerTool", async () => {
    const ctx = { pluginId: "cognia-browser-tools", logger: { info: jest.fn() }, agent: {} }
    await expect(definition.activate!(ctx as never)).resolves.toBeUndefined()
  })

  it("registers an availability context provider and deactivates cleanly", async () => {
    const providers: Array<{ provide: () => string }> = []
    const ctx = {
      pluginId: "cognia-browser-tools",
      logger: { info: jest.fn() },
      agent: {
        registerTool: jest.fn(),
        context: { registerProvider: (p: { provide: () => string }) => providers.push(p) },
      },
    }
    await definition.activate!(ctx as never)
    expect(providers).toHaveLength(1)
    const text = providers[0].provide()
    expect(text).toMatch(/browser_snapshot/)
    // Steers public-site automation to the separately-attached Playwright MCP.
    expect(text).toMatch(/mcp__playwright__/)
    await expect(definition.deactivate!({} as never)).resolves.toBeUndefined()
  })

  it("defaults missing args (no url, no ref) to empty values", async () => {
    const tools = await collectTools()
    await tools.browser_navigate({})
    expect(engine.navigate).toHaveBeenCalledWith("")
    await tools.browser_click(undefined)
    expect(engine.act).toHaveBeenCalledWith("", "click", {})
  })
})
