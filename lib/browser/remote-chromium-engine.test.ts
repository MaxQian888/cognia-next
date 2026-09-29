jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: jest.fn(), subscribe: jest.fn() },
}))

import { transport } from "@/lib/tauri/transport-instance"
import { REMOTE_UNSUPPORTED_FEATURES, RemoteChromiumEngine } from "./remote-chromium-engine"

const call = transport.call as jest.Mock

beforeEach(() => call.mockReset())

describe("RemoteChromiumEngine", () => {
  it("keeps the public BrowserEngine contract while adding session context", async () => {
    call.mockResolvedValueOnce({
      generation: 2,
      url: "https://app.example",
      title: "App",
      nodes: [],
    })
    const engine = new RemoteChromiumEngine("session-1")
    await engine.snapshot({ includeText: true })
    expect(call).toHaveBeenCalledWith("browser_snapshot", {
      browserSessionId: "session-1",
      options: { includeText: true },
    })
  })

  it("delegates page, file, and download operations to companion RPC", async () => {
    call
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([])
    const engine = new RemoteChromiumEngine("session-1")
    await engine.listPages()
    await engine.activatePage("page-2")
    await engine.closePage("page-1")
    await engine.setFiles("opaque-ref", ["fixtures/avatar.png"])
    await engine.downloads()
    expect(call.mock.calls).toEqual([
      ["browser_pages", { browserSessionId: "session-1" }],
      ["browser_switch_page", { browserSessionId: "session-1", pageId: "page-2" }],
      ["browser_close_page", { browserSessionId: "session-1", pageId: "page-1" }],
      [
        "browser_set_files",
        {
          browserSessionId: "session-1",
          ref: "opaque-ref",
          paths: ["fixtures/avatar.png"],
        },
      ],
      ["browser_downloads", { browserSessionId: "session-1" }],
    ])
  })

  it("drives zoom and find-in-page through companion RPC", async () => {
    call
      .mockResolvedValueOnce({ ok: true, zoom: 1.5 })
      .mockResolvedValueOnce({ matches: 3, index: 0 })
      .mockResolvedValueOnce(undefined)
    const engine = new RemoteChromiumEngine("session-1")
    await engine.setZoom(1.5)
    await engine.find("hello", { forward: true })
    await engine.findClear()
    expect(call.mock.calls).toEqual([
      ["browser_set_zoom", { browserSessionId: "session-1", zoom: 1.5 }],
      [
        "browser_find",
        { browserSessionId: "session-1", query: "hello", options: { forward: true } },
      ],
      ["browser_find_clear", { browserSessionId: "session-1" }],
    ])
  })

  it("delegates new page, drag, dialog, and scoped screenshot operations", async () => {
    call
      .mockResolvedValueOnce({ id: "page-2", url: "https://example.com", title: "", active: true })
      .mockResolvedValueOnce({ ok: true, error: null, generation: 2 })
      .mockResolvedValueOnce({ ok: true, error: null, generation: 2 })
      .mockResolvedValueOnce({ bytes: "AAAA", width: 10, height: 20 })
    const engine = new RemoteChromiumEngine("session-1")
    await engine.createPage("https://example.com")
    await engine.drag("source", "target")
    await engine.handleDialog({ accept: false })
    await engine.screenshot({ scope: "element", ref: "target" })
    expect(call.mock.calls).toEqual([
      ["browser_new_page", { browserSessionId: "session-1", url: "https://example.com" }],
      ["browser_drag", { browserSessionId: "session-1", sourceRef: "source", targetRef: "target" }],
      ["browser_handle_dialog", { browserSessionId: "session-1", accept: false }],
      [
        "browser_screenshot",
        { browserSessionId: "session-1", options: { scope: "element", ref: "target" } },
      ],
    ])
  })
})

describe("RemoteChromiumEngine desktop-only surface (ADR-0201)", () => {
  it("refuses every local-runtime feature without calling the gateway, naming the way out", async () => {
    const engine = new RemoteChromiumEngine("session-1")
    expect(engine.backend).toBe("remote-chromium")
    const calls: Array<[keyof typeof REMOTE_UNSUPPORTED_FEATURES, () => Promise<unknown>]> = [
      ["pdf", () => engine.pdf()],
      ["emulate", () => engine.emulate({ offline: true })],
      ["cookies", () => engine.listCookies()],
      ["cookies", () => engine.clearCookies("a.test")],
      ["storage", () => engine.getStorage("local")],
      ["storage", () => engine.setStorage("local", "k", "v")],
      ["storage", () => engine.clearStorage("session")],
      ["networkRequest", () => engine.networkRequest("r")],
      ["credentials", () => engine.detectLoginForms()],
      ["credentials", () => engine.fillCredential({})],
      ["extensions", () => engine.listExtensions()],
      ["extensions", () => engine.openExtension("x", "popup")],
      ["finalizeTabs", () => engine.finalizeTabs()],
      ["downloadControl", () => engine.cancelDownload("d")],
      ["downloadControl", () => engine.deleteDownload("d")],
      ["downloadControl", () => engine.saveDownload("d", "/x")],
    ]
    for (const [feature, run] of calls) {
      const error = await run().then(
        () => null,
        (cause: { code?: string; message?: string }) => cause
      )
      expect(error?.code).toBe("browser_feature_unsupported")
      expect(error?.message).toContain(REMOTE_UNSUPPORTED_FEATURES[feature])
      expect(error?.message).toContain("local Chromium")
    }
    expect(new Set(calls.map(([feature]) => feature))).toEqual(
      new Set(Object.keys(REMOTE_UNSUPPORTED_FEATURES))
    )
    expect(call).not.toHaveBeenCalled()
  })
})
