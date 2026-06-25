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
