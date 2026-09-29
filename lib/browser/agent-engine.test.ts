/** @jest-environment jsdom */
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
    embedSetZoom: jest.fn(async (zoom: number) => ({ ok: true, zoom })),
    embedFind: jest.fn(async () => ({ matches: 2, index: 0 })),
    embedFindClear: jest.fn(async () => {}),
  },
}))

const mockFillCredential = jest.fn()
jest.mock(
  "./passwords",
  () => ({ fillCredential: (...args: unknown[]) => mockFillCredential(...args) }),
  { virtual: true }
)

const mockTransportCall = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
  transport: {
    call: (...args: unknown[]) => mockTransportCall(...args),
    subscribe: jest.fn(() => () => {}),
  },
}))

const mockLocal = {
  status: jest.fn(),
  createSession: jest.fn(),
  rpc: jest.fn(),
}
jest.mock("@/lib/browser/local-client", () => ({
  localBrowser: {
    status: (...args: unknown[]) => mockLocal.status(...args),
    createSession: (...args: unknown[]) => mockLocal.createSession(...args),
    rpc: (...args: unknown[]) => mockLocal.rpc(...args),
  },
}))

import { browserClient } from "@/lib/browser/client"
import { LocalChromiumEngine } from "@/lib/browser/local-chromium-engine"
import {
  BROWSER_AGENT_LOCAL_SESSION_EVENT,
  configureLocalBrowserEngine,
  configureRemoteBrowserEngine,
  ensureAgentLocalEngine,
  primeLocalBrowserRouting,
  redactNetworkHeaders,
  resetLocalBrowserRouting,
  setLocalChromiumInstalled,
  EMBEDDED_UNSUPPORTED_FEATURES,
  embeddedUnsupportedMessage,
  routeEngine,
  EmbeddedEngine,
  embeddedSnapshotCacheStats,
  resetEmbeddedSnapshotCache,
} from "@/lib/browser/agent-engine"
import { setActivePaneRect } from "@/lib/browser/pane-rect"

const mockClient = browserClient as unknown as Record<string, jest.Mock>

beforeEach(() => {
  Object.values(mockClient).forEach((m) => m.mockClear())
  configureRemoteBrowserEngine(null)
  resetEmbeddedSnapshotCache()
  resetLocalBrowserRouting()
  mockFillCredential.mockReset()
  mockTransportCall.mockReset()
  Object.values(mockLocal).forEach((m) => m.mockReset())
})

describe("routeEngine", () => {
  it("routes localhost to the embedded engine, trusted tier", () => {
    const r = routeEngine("http://localhost:3000/")
    expect(r.engine).toBeInstanceOf(EmbeddedEngine)
    expect(r.tier).toBe("trusted")
    expect(r.untrusted).toBe(false)
  })

  it("flags public URLs as untrusted and keeps them embedded until local Chromium is installed", () => {
    const r = routeEngine("https://example.com/")
    expect(r.tier).toBe("public")
    expect(r.untrusted).toBe(true)
    expect(r.engine).toBeInstanceOf(EmbeddedEngine)
  })

  it("treats every loopback form as trusted and embedded", () => {
    for (const url of ["http://127.0.0.2:8080", "http://app.localhost:3000", "http://[::1]/"]) {
      expect(routeEngine(url)).toMatchObject({ backend: "embedded", tier: "trusted" })
    }
  })

  it("routes cloud/mobile/headless and authorized public pages to a ready remote engine", () => {
    const remote = new EmbeddedEngine()
    configureRemoteBrowserEngine(remote, { enabled: true, healthy: true })
    for (const hostProfile of ["cloud-companion", "mobile-companion", "headless"] as const) {
      expect(routeEngine("http://localhost:3000", { hostProfile })).toMatchObject({
        engine: remote,
        backend: "remote-chromium",
      })
    }
    expect(
      routeEngine("https://app.example.com", {
        hostProfile: "desktop",
        domainAuthorized: true,
      })
    ).toMatchObject({ engine: remote, backend: "remote-chromium" })
  })

  it("falls back to the best desktop engine for an authorized public URL instead of throwing", () => {
    expect(
      routeEngine("https://app.example.com", { hostProfile: "desktop", domainAuthorized: true })
    ).toMatchObject({ backend: "embedded", untrusted: true })
    setLocalChromiumInstalled(true)
    expect(
      routeEngine("https://app.example.com", { hostProfile: "desktop", domainAuthorized: true })
    ).toMatchObject({ backend: "local-chromium", untrusted: true })
  })

  it("routes on the TARGET URL: public to local Chromium, loopback to embedded", () => {
    setLocalChromiumInstalled(true)
    expect(routeEngine("https://example.com").backend).toBe("local-chromium")
    expect(routeEngine("http://localhost:5173").backend).toBe("embedded")
  })

  it("keeps the agent on the session the pane is showing, for every URL", () => {
    configureLocalBrowserEngine({ sessionId: "pane-1", backend: "user-chrome" })
    const route = routeEngine("http://localhost:3000")
    expect(route.backend).toBe("user-chrome")
    expect(route.engine).toBeInstanceOf(LocalChromiumEngine)
    expect((route.engine as LocalChromiumEngine).sessionId).toBe("pane-1")
    configureLocalBrowserEngine(null)
    expect(routeEngine("http://localhost:3000").backend).toBe("embedded")
  })

  it("honours explicit local preferences and refuses what cannot be served", () => {
    expect(() =>
      routeEngine("https://example.com", { backendPreference: "local-chromium" })
    ).toThrow(expect.objectContaining({ code: "browser_feature_unsupported" }))
    expect(() => routeEngine("https://example.com", { backendPreference: "user-chrome" })).toThrow(
      expect.objectContaining({ code: "browser_feature_unsupported" })
    )
    expect(
      routeEngine("https://example.com", {
        backendPreference: "local-chromium",
        localChromiumInstalled: true,
      }).backend
    ).toBe("local-chromium")
    expect(routeEngine("https://example.com", { backendPreference: "embedded" }).backend).toBe(
      "embedded"
    )
  })

  it("lazily creates one headless local session on first use and announces it", async () => {
    setLocalChromiumInstalled(true)
    mockLocal.createSession.mockImplementation(async ({ id }: { id: string }) => ({ id }))
    mockLocal.rpc.mockResolvedValue({ url: "https://example.com/", title: "Example" })
    const announced: unknown[] = []
    const listener = (event: Event) => announced.push((event as CustomEvent).detail)
    window.addEventListener(BROWSER_AGENT_LOCAL_SESSION_EVENT, listener)
    const { engine } = routeEngine("https://example.com")
    expect(engine.backend).toBe("local-chromium")
    await expect(engine.getPage()).resolves.toEqual({
      url: "https://example.com/",
      title: "Example",
    })
    await routeEngine("https://example.com").engine.getPage()
    window.removeEventListener(BROWSER_AGENT_LOCAL_SESSION_EVENT, listener)
    expect(mockLocal.createSession).toHaveBeenCalledTimes(1)
    expect(mockLocal.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "local", headless: true })
    )
    const sessionId = (mockLocal.createSession.mock.calls[0][0] as { id: string }).id
    expect(mockLocal.rpc).toHaveBeenCalledWith("browser.page", { sessionId })
    expect(announced).toEqual([{ sessionId, backend: "local-chromium" }])
    // Once created, routing hands out the concrete engine.
    expect(routeEngine("https://example.com").engine).toBeInstanceOf(LocalChromiumEngine)
  })

  it("dedupes concurrent lazy session creation", async () => {
    mockLocal.createSession.mockImplementation(async ({ id }: { id: string }) => ({ id }))
    const [a, b] = await Promise.all([ensureAgentLocalEngine(), ensureAgentLocalEngine()])
    expect(a).toBe(b)
    expect(mockLocal.createSession).toHaveBeenCalledTimes(1)
  })

  it("primes the install snapshot from the runtime status (desktop only)", async () => {
    mockLocal.status.mockResolvedValue({ installed: true })
    await primeLocalBrowserRouting()
    // isTauri() is false under jest: the web shell never probes.
    expect(mockLocal.status).not.toHaveBeenCalled()
  })

  it("keeps desktop localhost embedded and rejects unavailable explicit remote routing", () => {
    expect(routeEngine("http://localhost:3000", { hostProfile: "desktop" }).backend).toBe(
      "embedded"
    )
    expect(() =>
      routeEngine("http://localhost:3000", { backendPreference: "remote-chromium" })
    ).toThrow(expect.objectContaining({ code: "browser_feature_unsupported" }))
  })
})

describe("EmbeddedEngine snapshot cache (ADR-0127)", () => {
  it("serves repeated snapshots from the cache until a mutating call invalidates it", async () => {
    const engine = new EmbeddedEngine()
    const first = await engine.snapshot()
    const second = await engine.snapshot()
    expect(second).toBe(first)
    expect(mockClient.embedSnapshot).toHaveBeenCalledTimes(1)
    // A scroll does not change the DOM → still cached.
    await engine.scroll({ direction: "down" })
    await engine.snapshot()
    expect(mockClient.embedSnapshot).toHaveBeenCalledTimes(1)
    // A click can → the next snapshot walks again.
    await engine.act("ref-1", "click", {})
    await engine.snapshot()
    expect(mockClient.embedSnapshot).toHaveBeenCalledTimes(2)
    expect(embeddedSnapshotCacheStats()).toMatchObject({ hits: 2, misses: 2 })
  })

  it("keys the cache on includeText, and `fresh` always re-walks without forwarding the flag", async () => {
    const engine = new EmbeddedEngine()
    await engine.snapshot({ includeText: true })
    await engine.snapshot()
    expect(mockClient.embedSnapshot).toHaveBeenCalledTimes(2)
    await engine.snapshot({ fresh: true })
    expect(mockClient.embedSnapshot).toHaveBeenCalledTimes(3)
    expect(mockClient.embedSnapshot).toHaveBeenLastCalledWith({})
  })

  it("navigate / back / forward / reload / evaluate all invalidate; readConsole does not", async () => {
    const engine = new EmbeddedEngine()
    for (const [name, call] of [
      ["navigate", () => engine.navigate("http://x/")],
      ["back", () => engine.back()],
      ["forward", () => engine.forward()],
      ["reload", () => engine.reload()],
      ["evaluate", () => engine.evaluate("1")],
    ] as const) {
      await engine.snapshot()
      const before = mockClient.embedSnapshot.mock.calls.length
      await call()
      await engine.snapshot()
      expect(mockClient.embedSnapshot.mock.calls.length).toBe(before + 1)
      void name
    }
    await engine.snapshot()
    const before = mockClient.embedSnapshot.mock.calls.length
    await engine.readConsole()
    await engine.snapshot()
    expect(mockClient.embedSnapshot.mock.calls.length).toBe(before)
  })
})

describe("EmbeddedEngine", () => {
  it("exposes the embedded webview as one activatable page", async () => {
    const engine = new EmbeddedEngine()
    await expect(engine.listPages()).resolves.toEqual([
      {
        id: "embedded",
        url: "http://localhost/",
        title: "Home",
        active: true,
      },
    ])
    await expect(engine.activatePage("embedded")).resolves.toBeUndefined()
    await expect(engine.activatePage("other")).rejects.toMatchObject({
      code: "browser_page_not_found",
    })
  })

  it("refuses to close its only page instead of blanking it (ADR-0201)", async () => {
    await expect(new EmbeddedEngine().closePage("embedded")).rejects.toMatchObject({
      code: "browser_feature_unsupported",
    })
    expect(mockClient.embedNavigate).not.toHaveBeenCalled()
    expect(mockClient.embedStop).not.toHaveBeenCalled()
  })

  it("reports upload as unsupported and lists the (empty) embedded downloads", async () => {
    const engine = new EmbeddedEngine()
    await expect(engine.setFiles("e1", ["fixture.txt"])).rejects.toMatchObject({
      code: "browser_feature_unsupported",
    })
    await expect(engine.downloads()).resolves.toEqual([])
  })

  it("reads, writes and clears web storage through the page", async () => {
    const engine = new EmbeddedEngine()
    mockClient.embedEvaluate.mockResolvedValueOnce({
      ok: true,
      value: { origin: "http://localhost:3000", entries: { a: "1" } },
    })
    await expect(engine.getStorage("local")).resolves.toEqual({
      area: "local",
      origin: "http://localhost:3000",
      entries: { a: "1" },
    })
    expect(mockClient.embedEvaluate.mock.calls[0][0]).toContain("window.localStorage")
    mockClient.embedEvaluate.mockResolvedValueOnce({ ok: true, value: { entries: { k: null } } })
    await expect(engine.getStorage("session", "k")).resolves.toMatchObject({
      entries: { k: null },
    })
    expect(mockClient.embedEvaluate.mock.calls[1][0]).toContain(
      'window.sessionStorage.getItem("k")'
    )
    await expect(engine.setStorage("local", "k", 'v"1')).resolves.toEqual({ ok: true })
    expect(mockClient.embedEvaluate.mock.calls[2][0]).toContain('setItem("k","v\\"1")')
    await expect(engine.clearStorage("session")).resolves.toEqual({ ok: true })
    mockClient.embedEvaluate.mockResolvedValueOnce({ ok: false, error: "SecurityError" })
    await expect(engine.clearStorage("local")).rejects.toThrow("SecurityError")
  })

  it("clears cookies for one site or every public site through Rust", async () => {
    const engine = new EmbeddedEngine()
    mockTransportCall.mockResolvedValueOnce({ removed: 3, domain: "example.com" })
    await expect(engine.clearCookies("example.com")).resolves.toEqual({ removed: 3 })
    expect(mockTransportCall).toHaveBeenCalledWith("browser_cookie_clear", {
      domain: "example.com",
    })
    mockTransportCall.mockResolvedValueOnce({ removed: 9 })
    await expect(engine.clearCookies()).resolves.toEqual({ removed: 9 })
    expect(mockTransportCall).toHaveBeenLastCalledWith("browser_cookie_clear_all", {})
  })

  it("refuses evaluate after a successful fill unless the call was approved", async () => {
    const engine = new EmbeddedEngine()
    mockFillCredential.mockResolvedValueOnce({ filled: false, username: null, reason: "no_match" })
    await engine.fillCredential({})
    expect(engine.credentialFilled).toBe(false)
    await expect(engine.evaluate("1")).resolves.toEqual({ ok: true, value: "ok" })

    mockFillCredential.mockResolvedValueOnce({ filled: true, username: "me" })
    await engine.fillCredential({})
    expect(engine.credentialFilled).toBe(true)
    mockClient.embedEvaluate.mockClear()
    await expect(
      engine.evaluate("document.querySelector('[type=password]').value")
    ).resolves.toEqual({
      ok: false,
      code: "browser_human_input_required",
      error: expect.stringContaining("approval"),
    })
    expect(mockClient.embedEvaluate).not.toHaveBeenCalled()

    await expect(
      engine.evaluate("document.title", { credentialFillApproved: true })
    ).resolves.toEqual({ ok: true, value: "ok" })
    expect(mockClient.embedEvaluate).toHaveBeenCalledWith("document.title")

    engine.resetCredentialFilled()
    expect(engine.credentialFilled).toBe(false)
  })

  it("reports the lazy local session's post-fill lock as a value, not a method", async () => {
    setLocalChromiumInstalled(true)
    const route = routeEngine("https://example.com/")
    expect(route.backend).toBe("local-chromium")
    expect(route.engine.credentialFilled).toBe(false)
  })

  it("fills credentials through Rust and returns only the username", async () => {
    mockFillCredential.mockResolvedValue({ filled: true, username: "me@example.com" })
    await expect(new EmbeddedEngine().fillCredential({})).resolves.toEqual({
      filled: true,
      username: "me@example.com",
      reason: null,
    })
    expect(mockFillCredential).toHaveBeenCalledWith({
      target: "embedded",
      credentialId: null,
      url: "http://localhost/",
    })
  })

  it("reports remote-only page, drag, dialog, and scoped screenshots as unsupported", async () => {
    const engine = new EmbeddedEngine()
    await expect(engine.createPage("https://example.com")).rejects.toMatchObject({
      code: "browser_feature_unsupported",
    })
    await expect(engine.drag("e1", "e2")).rejects.toMatchObject({
      code: "browser_feature_unsupported",
    })
    await expect(engine.handleDialog({ accept: true })).rejects.toMatchObject({
      code: "browser_feature_unsupported",
    })
    await expect(engine.screenshot({ scope: "fullPage" })).rejects.toMatchObject({
      code: "browser_feature_unsupported",
    })
    await expect(engine.screenshot({ scope: "element", ref: "e1" })).rejects.toMatchObject({
      code: "browser_feature_unsupported",
    })
  })

  it("delegates zoom and find operations to the embedded browser client", async () => {
    const engine = new EmbeddedEngine()
    await expect(engine.setZoom(10)).resolves.toEqual({ ok: true, zoom: 5 })
    await engine.find("hello", { matchCase: true })
    await engine.findClear()
    expect(mockClient.embedSetZoom).toHaveBeenCalledWith(5)
    expect(mockClient.embedFind).toHaveBeenCalledWith("hello", { matchCase: true })
    expect(mockClient.embedFindClear).toHaveBeenCalled()
  })

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

// Working rule 7, type half: what the embedded webview cannot do is declared
// once, and every refusal a model reads is built from it — a bare "not
// supported" left the model retrying and the human unaware a setting existed.
describe("embedded feature gaps", () => {
  it("names both the gap and the way out", () => {
    const message = embeddedUnsupportedMessage("setFiles")
    expect(message).toContain("File upload")
    expect(message).toContain("local Chromium")
    expect(message).toContain("Settings")
  })

  it("keeps the declared list and the methods that throw in agreement", async () => {
    const engine = new EmbeddedEngine()
    const thrown = await Promise.all(
      (
        [
          ["createPage", () => engine.createPage()],
          ["drag", () => engine.drag("a", "b")],
          ["handleDialog", () => engine.handleDialog({ accept: true })],
          ["setFiles", () => engine.setFiles("a", [])],
          ["closePage", () => engine.closePage("embedded")],
          ["scopedScreenshot", () => engine.screenshot({ scope: "fullPage" })],
          ["pdf", () => engine.pdf()],
          ["emulate", () => engine.emulate({ offline: true })],
          ["listCookies", () => engine.listCookies()],
          ["networkRequest", () => engine.networkRequest("r1")],
          ["detectLoginForms", () => engine.detectLoginForms()],
          ["extensions", () => engine.listExtensions()],
          ["finalizeTabs", () => engine.finalizeTabs()],
          ["downloadControl", () => engine.cancelDownload("d1")],
        ] as const
      ).map(async ([feature, call]) => {
        const error = await call().then(
          () => null,
          (cause: unknown) => cause as Error
        )
        return [feature, error?.message] as const
      })
    )
    for (const [feature, message] of thrown) {
      expect(message).toBe(
        embeddedUnsupportedMessage(feature as keyof typeof EMBEDDED_UNSUPPORTED_FEATURES)
      )
    }
    expect(thrown.map(([feature]) => feature).sort()).toEqual(
      Object.keys(EMBEDDED_UNSUPPORTED_FEATURES).sort()
    )
  })
})

describe("redactNetworkHeaders", () => {
  it("redacts credential-bearing headers case-insensitively", () => {
    expect(
      redactNetworkHeaders({
        Authorization: "Bearer x",
        cookie: "a=b",
        "Set-Cookie": "c=d",
        "content-type": "text/html",
      })
    ).toEqual({
      Authorization: "[REDACTED]",
      cookie: "[REDACTED]",
      "Set-Cookie": "[REDACTED]",
      "content-type": "text/html",
    })
    expect(redactNetworkHeaders(undefined)).toEqual({})
  })
})
