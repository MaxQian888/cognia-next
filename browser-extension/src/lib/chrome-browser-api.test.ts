/** @jest-environment jsdom */
import { createChromeBrowserApi } from "./chrome-browser-api"
import { readYouTubeTranscript } from "./capture/youtube-transcript"
import type { PageCapture, PageCaptureOptions } from "./capture/page-capture"

interface ChromeStub {
  tabs: { query: jest.Mock; create: jest.Mock; get: jest.Mock }
  scripting: { executeScript: jest.Mock }
  storage: {
    local: { get: jest.Mock; set: jest.Mock; remove: jest.Mock }
    onChanged: { addListener: jest.Mock; removeListener: jest.Mock }
  }
  permissions: { contains: jest.Mock; request: jest.Mock }
  runtime: { getURL: jest.Mock }
  i18n: { getMessage: jest.Mock }
}

function stub(): ChromeStub {
  const chromeStub: ChromeStub = {
    tabs: {
      query: jest.fn(async () => [{ id: 7, url: "https://example.com/a", title: "A" }]),
      create: jest.fn(async () => undefined),
      get: jest.fn(async (id: number) => ({ id, url: "https://example.com/b", title: "B" })),
    },
    scripting: { executeScript: jest.fn(async () => [{ result: { title: "A" } }]) },
    storage: {
      local: {
        get: jest.fn(async () => ({ "a.key": 42 })),
        set: jest.fn(async () => undefined),
        remove: jest.fn(async () => undefined),
      },
      onChanged: { addListener: jest.fn(), removeListener: jest.fn() },
    },
    permissions: { contains: jest.fn(async () => true), request: jest.fn(async () => true) },
    runtime: { getURL: jest.fn(() => "chrome-extension://abcdefghijklmnopabcdefghijklmnop/") },
    i18n: { getMessage: jest.fn(() => "translated") },
  }
  ;(globalThis as unknown as { chrome: ChromeStub }).chrome = chromeStub
  return chromeStub
}

describe("createChromeBrowserApi", () => {
  it("injects the capture bundle before invoking it in the isolated world", async () => {
    const chromeStub = stub()
    const options = { wholePage: true, article: true }
    const result: PageCapture = {
      title: "Captured",
      url: "https://example.com",
      selection: null,
      readableText: "Body",
      readableCharacterCount: 4,
      article: null,
      metadata: {},
      isPdf: false,
    }
    chromeStub.scripting.executeScript.mockResolvedValueOnce([]).mockResolvedValueOnce([{ result }])
    expect(await createChromeBrowserApi().capturePage(7, options)).toEqual(result)
    expect(chromeStub.scripting.executeScript.mock.calls[0][0]).toEqual({
      target: { tabId: 7 },
      files: ["/page-capture.js"],
    })
    const invocation = chromeStub.scripting.executeScript.mock.calls[1][0] as {
      target: { tabId: number }
      args: PageCaptureOptions[]
      world?: string
      func: (options: PageCaptureOptions) => PageCapture
    }
    expect(invocation.target).toEqual({ tabId: 7 })
    expect(invocation.args).toEqual([options])
    expect(invocation.world).toBeUndefined()
    const capture = jest.fn(() => result)
    globalThis.__cogniaPageCapture = { capture }
    expect(invocation.func(options)).toBe(result)
    expect(capture).toHaveBeenCalledWith(options)
    globalThis.__cogniaPageCapture = undefined
  })

  it("rejects a missing page capture and propagates bundle injection failures", async () => {
    const chromeStub = stub()
    chromeStub.scripting.executeScript.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    await expect(
      createChromeBrowserApi().capturePage(7, { wholePage: false, article: true })
    ).rejects.toThrow("the page could not be read")
    chromeStub.scripting.executeScript
      .mockReset()
      .mockRejectedValueOnce(new Error("permission denied"))
    await expect(
      createChromeBrowserApi().capturePage(7, { wholePage: false, article: true })
    ).rejects.toThrow("permission denied")
    expect(chromeStub.scripting.executeScript).toHaveBeenCalledTimes(1)
  })

  it("reads transcripts in MAIN only after checking the tab URL", async () => {
    const chromeStub = stub()
    chromeStub.tabs.get.mockResolvedValue({ id: 7, url: "https://www.youtube.com/watch?v=video" })
    const transcript = { status: "available", text: "[0:00] Hello", truncated: false }
    chromeStub.scripting.executeScript.mockResolvedValueOnce([{ result: transcript }])
    expect(await createChromeBrowserApi().captureTranscript(7, "en")).toEqual(transcript)
    expect(chromeStub.tabs.get).toHaveBeenCalledWith(7)
    expect(chromeStub.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      world: "MAIN",
      func: readYouTubeTranscript,
      args: ["en"],
    })
    chromeStub.scripting.executeScript.mockResolvedValueOnce([])
    expect(await createChromeBrowserApi().captureTranscript(7, "en")).toEqual({
      status: "unavailable",
      reason: "fetch_failed",
    })
  })

  it("does not inject transcript readers into non-video tabs", async () => {
    const chromeStub = stub()
    expect(await createChromeBrowserApi().captureTranscript(7, "en")).toEqual({
      status: "unavailable",
      reason: "not_a_video",
    })
    expect(chromeStub.scripting.executeScript).not.toHaveBeenCalled()
  })

  it("returns the active tab, or null when there is none we may touch", async () => {
    const chromeStub = stub()
    const api = createChromeBrowserApi()
    expect(await api.activeTab()).toEqual({ id: 7, url: "https://example.com/a", title: "A" })

    chromeStub.tabs.query.mockResolvedValueOnce([{ id: undefined, url: undefined }])
    expect(await api.activeTab()).toBeNull()
    // A tab with no URL is one the extension has no `activeTab` grant for.
    chromeStub.tabs.query.mockResolvedValueOnce([])
    expect(await api.activeTab()).toBeNull()
  })

  it("resolves a tab by id, and treats a closed one as absent", async () => {
    const chromeStub = stub()
    const api = createChromeBrowserApi()
    expect(await api.tabById(7)).toEqual({ id: 7, url: "https://example.com/b", title: "B" })

    // `chrome.tabs.get` REJECTS for a tab that has closed rather than
    // resolving null, and a closed tab is ordinary here: a recorded capture
    // request may be up to a minute old.
    chromeStub.tabs.get.mockRejectedValueOnce(new Error("No tab with id: 7."))
    expect(await api.tabById(7)).toBeNull()
  })

  it("reads a missing storage key as null rather than undefined", async () => {
    const chromeStub = stub()
    const api = createChromeBrowserApi()
    expect(await api.read("a.key")).toBe(42)
    chromeStub.storage.local.get.mockResolvedValueOnce({})
    expect(await api.read("a.key")).toBeNull()
  })

  it("asks for exactly the loopback origin and nothing wider", async () => {
    const chromeStub = stub()
    const api = createChromeBrowserApi()
    await api.hasLoopbackPermission()
    await api.requestLoopbackPermission()
    for (const mock of [chromeStub.permissions.contains, chromeStub.permissions.request]) {
      expect(mock).toHaveBeenCalledWith({ origins: ["http://127.0.0.1/*"] })
    }
  })

  it("reports its origin without the trailing slash the runtime returns", async () => {
    // The Host stores the bare origin and Chrome sends the bare origin in the
    // `Origin` header; a trailing slash here would never match either.
    stub()
    expect(createChromeBrowserApi().extensionOrigin()).toBe(
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
    )
  })

  it("reports changes to one local key, and stops when asked", () => {
    const chromeStub = stub()
    const seen: unknown[] = []
    const stop = createChromeBrowserApi().onStorageChange("a.key", (value) => seen.push(value))
    const handler = chromeStub.storage.onChanged.addListener.mock.calls[0][0] as (
      changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
      area: string
    ) => void

    handler({ "a.key": { newValue: 7 } }, "local")
    // Another key, and the same key in another area, are somebody else's.
    handler({ "b.key": { newValue: 8 } }, "local")
    handler({ "a.key": { newValue: 9 } }, "sync")
    // A removal carries no `newValue`; the contract reports it as null.
    handler({ "a.key": { oldValue: 7 } }, "local")
    expect(seen).toEqual([7, null])

    stop()
    expect(chromeStub.storage.onChanged.removeListener).toHaveBeenCalledWith(handler)
  })

  it("passes substitutions through to the locale lookup", async () => {
    const chromeStub = stub()
    createChromeBrowserApi().message("pairFailed", ["boom"])
    expect(chromeStub.i18n.getMessage).toHaveBeenCalledWith("pairFailed", ["boom"])
  })
})

describe("createChromeBrowserApi — ADR-0228 surface", () => {
  function wideStub() {
    const base = stub() as unknown as Record<string, Record<string, unknown>>
    const port = { postMessage: jest.fn(), disconnect: jest.fn() }
    Object.assign(base.tabs!, {
      captureVisibleTab: jest.fn(async () => "data:image/png;base64,AA=="),
      update: jest.fn(async () => undefined),
    })
    Object.assign(base.permissions!, { remove: jest.fn(async () => true) })
    Object.assign(base.runtime!, {
      connect: jest.fn(() => port),
      sendMessage: jest.fn(async () => true),
    })
    Object.assign(base.storage!, {
      session: {
        get: jest.fn(async () => ({ "s.key": { draft: true } })),
        set: jest.fn(async () => undefined),
        remove: jest.fn(async () => undefined),
      },
    })
    return { chromeStub: base as unknown as ChromeStub & Record<string, never>, raw: base, port }
  }

  it("reads and writes session storage separately from local", async () => {
    const { raw } = wideStub()
    const api = createChromeBrowserApi()
    expect(await api.readSession("s.key")).toEqual({ draft: true })
    await api.writeSession("s.key", 1)
    await api.removeSession(["s.key"])
    const session = (raw.storage as { session: { set: jest.Mock; remove: jest.Mock } }).session
    expect(session.set).toHaveBeenCalledWith({ "s.key": 1 })
    expect(session.remove).toHaveBeenCalledWith(["s.key"])
  })

  it("passes optional permission requests through unchanged", async () => {
    const { raw } = wideStub()
    const api = createChromeBrowserApi()
    await api.requestPermissions({ permissions: ["tabs"], origins: ["https://a.test/*"] })
    await api.removePermissions({ origins: ["<all_urls>"] })
    const permissions = raw.permissions as { request: jest.Mock; remove: jest.Mock }
    expect(permissions.request).toHaveBeenCalledWith({
      permissions: ["tabs"],
      origins: ["https://a.test/*"],
    })
    expect(permissions.remove).toHaveBeenCalledWith({ origins: ["<all_urls>"] })
  })

  it("lists the window's tabs, dropping ones it cannot read, with their window", async () => {
    const { raw } = wideStub()
    ;(raw.tabs as { query: jest.Mock }).query.mockResolvedValueOnce([
      { id: 1, url: "https://a.test/", title: "A", windowId: 4 },
      { id: 2, title: "no url" },
    ])
    expect(await createChromeBrowserApi().listTabs()).toEqual([
      { id: 1, url: "https://a.test/", title: "A", windowId: 4 },
    ])
    expect((raw.tabs as { query: jest.Mock }).query).toHaveBeenCalledWith({ currentWindow: true })
  })

  it("captures PNG and measures and scrolls the page", async () => {
    const { raw } = wideStub()
    const api = createChromeBrowserApi()
    expect(await api.captureVisible(4)).toBe("data:image/png;base64,AA==")
    expect((raw.tabs as { captureVisibleTab: jest.Mock }).captureVisibleTab).toHaveBeenCalledWith(
      4,
      { format: "png" }
    )
    const executeScript = (raw.scripting as { executeScript: jest.Mock }).executeScript
    executeScript.mockResolvedValueOnce([
      { result: { scrollHeight: 10, viewportHeight: 5, viewportWidth: 3, scrollY: 0, dpr: 1 } },
    ])
    expect(await api.scrollMetrics(7)).toMatchObject({ scrollHeight: 10 })
    executeScript.mockResolvedValueOnce([{ result: 4 }])
    expect(await api.scrollTo(7, 9)).toBe(4)
    expect(executeScript.mock.calls.at(-1)?.[0]).toMatchObject({ target: { tabId: 7 }, args: [9] })
  })

  it("fetches bytes without credentials and refuses oversized ones", async () => {
    wideStub()
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({
        "content-type": "Application/PDF; charset=binary",
        "content-length": "3",
      }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }))
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock
    const api = createChromeBrowserApi()
    expect(await api.fetchBytes("https://a.test/f.pdf", 10)).toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "application/pdf",
    })
    expect(fetchMock).toHaveBeenCalledWith("https://a.test/f.pdf", {
      credentials: "omit",
      redirect: "follow",
    })
    await expect(api.fetchBytes("https://a.test/f.pdf", 2)).rejects.toThrow("too_large")
  })

  it("holds a named port to the worker", () => {
    const { raw, port } = wideStub()
    const handle = createChromeBrowserApi().connectPanel()
    expect((raw.runtime as { connect: jest.Mock }).connect).toHaveBeenCalledWith({
      name: "cognia-panel",
    })
    handle.post({ kind: "refresh-status" })
    handle.disconnect()
    expect(port.postMessage).toHaveBeenCalledWith({ kind: "refresh-status" })
    expect(port.disconnect).toHaveBeenCalled()
  })

  it("sends permission mutations to the worker instead of writing a second session store", async () => {
    const { raw } = wideStub()
    const api = createChromeBrowserApi()
    await api.answerSiteQuestion("q1", "once")
    await api.forgetSiteDecision("https://a.test")
    const runtime = raw.runtime as { sendMessage: jest.Mock }
    expect(runtime.sendMessage.mock.calls).toEqual([
      [{ kind: "cognia-agent-permission", action: "answer", questionId: "q1", answer: "once" }],
      [{ kind: "cognia-agent-permission", action: "forget", origin: "https://a.test" }],
    ])
    expect((raw.storage as { local: { set: jest.Mock } }).local.set).not.toHaveBeenCalled()
    expect((raw.storage as { session: { set: jest.Mock } }).session.set).not.toHaveBeenCalled()
    runtime.sendMessage.mockResolvedValueOnce(false)
    await expect(api.answerSiteQuestion("q1", "once")).rejects.toThrow()
  })
})
