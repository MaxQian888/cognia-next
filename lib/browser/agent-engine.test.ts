jest.mock("@/lib/browser/client", () => ({
  browserClient: {
    embedNavigate: jest.fn(async () => {}),
    embedSnapshot: jest.fn(async () => ({ generation: 1, url: "u", title: "t", nodes: [] })),
    embedAct: jest.fn(async () => ({ ok: true, error: null, generation: 1 })),
    embedReadConsole: jest.fn(async () => []),
    embedReadNetwork: jest.fn(async () => []),
    embedBack: jest.fn(async () => {}),
    embedForward: jest.fn(async () => {}),
    embedReload: jest.fn(async () => {}),
    embedStop: jest.fn(async () => {}),
    embedGetUrl: jest.fn(async () => "http://localhost/"),
    embedGetTitle: jest.fn(async () => "Home"),
    embedHasText: jest.fn(async () => true),
    embedHasSelector: jest.fn(async () => true),
    embedEvaluate: jest.fn(async () => ({ ok: true, value: "ok" })),
    embedNetworkState: jest.fn(async () => ({ pending: 0, completed: 0 })),
    embedCapture: jest.fn(async () => ({ bytes: "AAAA", width: 10, height: 10, capturedAt: 0 })),
  },
}))

import { browserClient } from "@/lib/browser/client"
import { routeEngine, EmbeddedEngine } from "@/lib/browser/agent-engine"
import { setActivePaneRect } from "@/lib/browser/pane-rect"

const mockClient = browserClient as unknown as Record<string, jest.Mock>

beforeEach(() => Object.values(mockClient).forEach((m) => m.mockClear()))

describe("routeEngine", () => {
  it("routes localhost to the embedded engine, trusted tier", () => {
    const r = routeEngine("http://localhost:3000/")
    expect(r.engine).toBeInstanceOf(EmbeddedEngine)
    expect(r.tier).toBe("trusted")
    expect(r.untrusted).toBe(false)
  })

  it("flags public URLs as untrusted (still embedded in Phase 1)", () => {
    const r = routeEngine("https://example.com/")
    expect(r.tier).toBe("public")
    expect(r.untrusted).toBe(true)
    expect(r.engine).toBeInstanceOf(EmbeddedEngine)
  })
})

describe("EmbeddedEngine", () => {
  it("act delegates to browserClient.embedAct", async () => {
    await new EmbeddedEngine().act("e1", "click", {})
    expect(mockClient.embedAct).toHaveBeenCalledWith("e1", "click", {})
  })

  it("getPage combines url + title", async () => {
    const page = await new EmbeddedEngine().getPage()
    expect(page).toEqual({ url: "http://localhost/", title: "Home" })
  })

  it("snapshot/navigate/console/network delegate", async () => {
    const e = new EmbeddedEngine()
    await e.navigate("http://localhost/")
    await e.snapshot()
    await e.readConsole()
    await e.readNetwork()
    expect(mockClient.embedNavigate).toHaveBeenCalledWith("http://localhost/")
    expect(mockClient.embedSnapshot).toHaveBeenCalled()
    expect(mockClient.embedReadConsole).toHaveBeenCalled()
    expect(mockClient.embedReadNetwork).toHaveBeenCalled()
  })

  it("back/forward/stop/reload delegate to browserClient", async () => {
    const e = new EmbeddedEngine()
    await e.back()
    await e.forward()
    await e.reload()
    await e.stop()
    expect(mockClient.embedBack).toHaveBeenCalled()
    expect(mockClient.embedForward).toHaveBeenCalled()
    expect(mockClient.embedReload).toHaveBeenCalled()
    expect(mockClient.embedStop).toHaveBeenCalled()
  })

  it("snapshot forwards options", async () => {
    await new EmbeddedEngine().snapshot({ includeText: true })
    expect(mockClient.embedSnapshot).toHaveBeenCalledWith({ includeText: true })
  })

  it("pressKey routes a key action through embedAct (default focused target)", async () => {
    await new EmbeddedEngine().pressKey("ctrl+a")
    expect(mockClient.embedAct).toHaveBeenCalledWith("", "key", { key: "ctrl+a" })
  })

  it("pressKey targets a ref when given", async () => {
    await new EmbeddedEngine().pressKey("Enter", "e7")
    expect(mockClient.embedAct).toHaveBeenCalledWith("e7", "key", { key: "Enter" })
  })

  it("scroll by ref strips the reference into the action target", async () => {
    await new EmbeddedEngine().scroll({ reference: "e3" })
    expect(mockClient.embedAct).toHaveBeenCalledWith("e3", "scroll", {})
  })

  it("scroll by direction passes a page scroll with no ref", async () => {
    await new EmbeddedEngine().scroll({ direction: "bottom", amount: 500 })
    expect(mockClient.embedAct).toHaveBeenCalledWith("", "scroll", {
      direction: "bottom",
      amount: 500,
    })
  })

  it("evaluate delegates to embedEvaluate", async () => {
    const res = await new EmbeddedEngine().evaluate("document.title")
    expect(mockClient.embedEvaluate).toHaveBeenCalledWith("document.title")
    expect(res).toEqual({ ok: true, value: "ok" })
  })
})

describe("EmbeddedEngine.waitForSelector", () => {
  it("resolves once the selector is present", async () => {
    mockClient.embedHasSelector.mockResolvedValueOnce(true)
    const res = await new EmbeddedEngine().waitForSelector(".ready", { timeoutMs: 1000 })
    expect(res).toEqual({ ok: true, timedOut: false })
    expect(mockClient.embedHasSelector).toHaveBeenCalledWith(".ready")
  })

  it("times out when the selector never matches", async () => {
    mockClient.embedHasSelector.mockResolvedValue(false)
    const res = await new EmbeddedEngine().waitForSelector(".nope", { timeoutMs: 0 })
    expect(res).toEqual({ ok: false, timedOut: true })
  })
})

describe("EmbeddedEngine.waitForNetworkIdle", () => {
  it("resolves when no requests are pending and the completed count is stable", async () => {
    mockClient.embedNetworkState.mockResolvedValue({ pending: 0, completed: 4 })
    const res = await new EmbeddedEngine().waitForNetworkIdle({ idleMs: 0, timeoutMs: 1000 })
    expect(res).toEqual({ ok: true, timedOut: false })
  })

  it("times out while requests stay in flight", async () => {
    mockClient.embedNetworkState.mockResolvedValue({ pending: 2, completed: 1 })
    const res = await new EmbeddedEngine().waitForNetworkIdle({ timeoutMs: 0 })
    expect(res).toEqual({ ok: false, timedOut: true })
  })

  it("waits out the quiet window before declaring idle", async () => {
    jest.useFakeTimers()
    // First poll: in-flight; subsequent polls: settled at completed=3.
    mockClient.embedNetworkState
      .mockResolvedValueOnce({ pending: 1, completed: 2 })
      .mockResolvedValue({ pending: 0, completed: 3 })
    const p = new EmbeddedEngine().waitForNetworkIdle({
      idleMs: 150,
      intervalMs: 100,
      timeoutMs: 5000,
    })
    await jest.advanceTimersByTimeAsync(400)
    const res = await p
    expect(res.ok).toBe(true)
    jest.useRealTimers()
  })
})

describe("EmbeddedEngine.waitForText", () => {
  it("resolves immediately when the text is already present (appear)", async () => {
    mockClient.embedHasText.mockResolvedValueOnce(true)
    const res = await new EmbeddedEngine().waitForText("done", { timeoutMs: 1000 })
    expect(res).toEqual({ ok: true, timedOut: false })
    expect(mockClient.embedHasText).toHaveBeenCalledWith("done")
  })

  it("resolves when the text is absent (disappear)", async () => {
    mockClient.embedHasText.mockResolvedValueOnce(false)
    const res = await new EmbeddedEngine().waitForText("spinner", {
      mode: "disappear",
      timeoutMs: 1000,
    })
    expect(res.ok).toBe(true)
  })

  it("times out when the condition is never met", async () => {
    mockClient.embedHasText.mockResolvedValue(false)
    const res = await new EmbeddedEngine().waitForText("never", { timeoutMs: 0 })
    expect(res).toEqual({ ok: false, timedOut: true })
  })

  it("polls until the text appears", async () => {
    jest.useFakeTimers()
    mockClient.embedHasText.mockResolvedValueOnce(false).mockResolvedValue(true)
    const p = new EmbeddedEngine().waitForText("ready", { intervalMs: 100, timeoutMs: 1000 })
    await jest.advanceTimersByTimeAsync(100)
    const res = await p
    expect(res.ok).toBe(true)
    jest.useRealTimers()
  })
})

describe("EmbeddedEngine.waitForLoad", () => {
  const loaded = (url: string, ready = "complete") => ({ ok: true, value: { url, ready } })

  it("resolves once the target url is loaded", async () => {
    mockClient.embedEvaluate.mockResolvedValue(loaded("http://localhost/next"))
    const res = await new EmbeddedEngine().waitForLoad({
      targetUrl: "http://localhost/next",
      fromUrl: "http://localhost/",
      timeoutMs: 1000,
    })
    expect(res).toEqual({ ok: true, timedOut: false })
  })

  it("counts leaving fromUrl as arrival (redirects land elsewhere)", async () => {
    mockClient.embedEvaluate.mockResolvedValue(loaded("https://redirected.example/"))
    const res = await new EmbeddedEngine().waitForLoad({
      targetUrl: "http://localhost/a",
      fromUrl: "http://localhost/",
      timeoutMs: 1000,
    })
    expect(res.ok).toBe(true)
  })

  it("matches urls loosely (hash and trailing slash ignored)", async () => {
    mockClient.embedEvaluate.mockResolvedValue(loaded("http://localhost/app/#tab"))
    const res = await new EmbeddedEngine().waitForLoad({
      targetUrl: "http://localhost/app",
      timeoutMs: 1000,
    })
    expect(res.ok).toBe(true)
  })

  it("times out while still on fromUrl", async () => {
    mockClient.embedEvaluate.mockResolvedValue(loaded("http://localhost/"))
    const res = await new EmbeddedEngine().waitForLoad({
      fromUrl: "http://localhost/",
      timeoutMs: 0,
    })
    expect(res).toEqual({ ok: false, timedOut: true })
  })

  it("without target/from it waits for readyState complete", async () => {
    mockClient.embedEvaluate
      .mockResolvedValueOnce(loaded("http://localhost/", "loading"))
      .mockResolvedValue(loaded("http://localhost/"))
    const res = await new EmbeddedEngine().waitForLoad({ timeoutMs: 1000, intervalMs: 1 })
    expect(res.ok).toBe(true)
    expect(mockClient.embedEvaluate.mock.calls.length).toBeGreaterThan(1)
  })

  it("keeps polling through eval rejections mid document swap", async () => {
    mockClient.embedEvaluate
      .mockRejectedValueOnce(new Error("webview busy"))
      .mockResolvedValue(loaded("http://localhost/next"))
    const res = await new EmbeddedEngine().waitForLoad({
      targetUrl: "http://localhost/next",
      timeoutMs: 1000,
      intervalMs: 1,
    })
    expect(res.ok).toBe(true)
  })

  it("honors the initial delay before the first poll", async () => {
    mockClient.embedEvaluate.mockResolvedValue(loaded("http://localhost/"))
    const res = await new EmbeddedEngine().waitForLoad({ timeoutMs: 1000, initialDelayMs: 1 })
    expect(res.ok).toBe(true)
  })
})

describe("EmbeddedEngine.screenshot", () => {
  afterEach(() => setActivePaneRect(null))

  it("captures the published pane rect", async () => {
    setActivePaneRect({ x: 1, y: 2, width: 3, height: 4 })
    const shot = await new EmbeddedEngine().screenshot()
    expect(mockClient.embedCapture).toHaveBeenCalledWith({ x: 1, y: 2, width: 3, height: 4 })
    expect(shot.bytes).toBe("AAAA")
  })

  it("rejects when no preview is open", async () => {
    setActivePaneRect(null)
    await expect(new EmbeddedEngine().screenshot()).rejects.toThrow(/not open/)
  })
})
