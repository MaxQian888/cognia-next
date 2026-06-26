jest.mock("@/lib/browser/agent-engine", () => {
  const engine = {
    navigate: jest.fn(async () => {}),
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
    getPage: jest.fn(async () => ({ url: "http://localhost/", title: "t" })),
    back: jest.fn(async () => {}),
    forward: jest.fn(async () => {}),
    reload: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
    waitForText: jest.fn(async () => ({ ok: true, timedOut: false })),
    waitForSelector: jest.fn(async () => ({ ok: true, timedOut: false })),
    waitForNetworkIdle: jest.fn(async () => ({ ok: true, timedOut: false })),
    screenshot: jest.fn(async () => ({ bytes: "AAAA", width: 10, height: 10, capturedAt: 0 })),
  }
  return {
    __engine: engine,
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

import definition from "@/plugins/browser-tools/src/index"
import * as engineModule from "@/lib/browser/agent-engine"

const engine = (engineModule as unknown as { __engine: Record<string, jest.Mock> }).__engine

type Tools = Record<string, (args: unknown) => Promise<unknown>>

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

beforeEach(() => Object.values(engine).forEach((m) => m.mockClear()))

describe("browser-tools plugin", () => {
  it("registers the full Phase-1 tool surface", async () => {
    const tools = await collectTools()
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining([
        "browser_navigate",
        "browser_snapshot",
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
    expect(res.navigated).toBe("http://localhost:3000/")
    expect(res.snapshot.generation).toBe(3)
    expect(res.untrusted).toBe(false)
    expect("hint" in res).toBe(false)
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
