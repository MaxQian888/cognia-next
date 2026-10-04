const mockRpc = jest.fn()
jest.mock("@/lib/browser/local-client", () => ({
  localBrowser: { rpc: (...args: unknown[]) => mockRpc(...args) },
}))
const mockFillCredential = jest.fn()
jest.mock(
  "./passwords",
  () => ({ fillCredential: (...a: unknown[]) => mockFillCredential(...a) }),
  {
    virtual: true,
  }
)
const mockSaveDownloadAs = jest.fn()
jest.mock("@/lib/browser/downloads-client", () => ({
  saveDownloadAs: (...args: unknown[]) => mockSaveDownloadAs(...args),
}))
const mockListExtensions = jest.fn()
jest.mock("@/lib/browser/extensions-client", () => ({
  listExtensions: () => mockListExtensions(),
}))

import {
  LOCAL_DOWNLOAD_SAVE_CANCELLED,
  LOCAL_UPLOAD_NEEDS_STAGING,
  LocalBrowserOpError,
  LocalChromiumEngine,
  clearLocalSessionCredentialFilled,
  isLocalSessionCredentialFilled,
  toLocalBrowserError,
} from "./local-chromium-engine"
import { BrowserSessionError } from "./session-types"

beforeEach(() => {
  clearLocalSessionCredentialFilled()
  mockRpc.mockReset()
  mockRpc.mockResolvedValue({ ok: true })
  mockFillCredential.mockReset()
  mockListExtensions.mockReset()
  mockSaveDownloadAs.mockReset()
  mockSaveDownloadAs.mockResolvedValue({ id: "d1", state: "saved" })
})

const engine = () => new LocalChromiumEngine("s1", "local-chromium")

describe("LocalChromiumEngine", () => {
  it("maps the shared BrowserEngine surface onto the runtime op vocabulary", async () => {
    const e = engine()
    await e.navigate("https://a.test")
    await e.snapshot({ includeText: true, fresh: true })
    await e.act("e1", "click", { modifiers: ["ctrl"] })
    await e.pressKey("Enter")
    await e.pressKey("Tab", "e2")
    await e.scroll({ direction: "down", amount: 100 })
    await e.evaluate("1+1")
    await e.readConsole()
    await e.readNetwork()
    await e.back()
    await e.forward()
    await e.reload()
    await e.stop()
    await e.getPage()
    await e.listPages()
    await e.activatePage("p2")
    await e.closePage("p2")
    await e.createPage()
    await e.createPage("https://b.test")
    await e.drag("a", "b")
    await e.handleDialog({ accept: false, promptText: "x" })
    await e.setFiles("f", ["/app/browser/uploads/x/a.txt"])
    await e.downloads()
    await e.waitForText("hi", { timeoutMs: 5 })
    await e.waitForSelector("#x")
    await e.waitForNetworkIdle({ idleMs: 1 })
    await e.waitForLoad({ targetUrl: "https://a.test" })
    await e.screenshot({ scope: "fullPage" })
    await e.screenshot()
    await e.setZoom(2)
    await e.find("q", { matchCase: true })
    await e.findClear()
    const ops = mockRpc.mock.calls.map(([op, payload]) => [op, payload])
    expect(ops).toEqual([
      ["browser.navigate", { sessionId: "s1", url: "https://a.test" }],
      ["browser.snapshot", { sessionId: "s1", options: { includeText: true } }],
      [
        "browser.act",
        { sessionId: "s1", ref: "e1", action: "click", args: { modifiers: ["ctrl"] } },
      ],
      ["browser.press-key", { sessionId: "s1", key: "Enter" }],
      ["browser.press-key", { sessionId: "s1", key: "Tab", ref: "e2" }],
      ["browser.scroll", { sessionId: "s1", direction: "down", amount: 100 }],
      ["browser.evaluate", { sessionId: "s1", expression: "1+1" }],
      ["browser.console", { sessionId: "s1" }],
      ["browser.network", { sessionId: "s1" }],
      ["browser.back", { sessionId: "s1" }],
      ["browser.forward", { sessionId: "s1" }],
      ["browser.reload", { sessionId: "s1" }],
      ["browser.stop", { sessionId: "s1" }],
      ["browser.page", { sessionId: "s1" }],
      ["browser.pages", { sessionId: "s1" }],
      ["browser.page.activate", { sessionId: "s1", pageId: "p2" }],
      ["browser.page.close", { sessionId: "s1", pageId: "p2" }],
      ["browser.page.create", { sessionId: "s1" }],
      ["browser.page.create", { sessionId: "s1", url: "https://b.test" }],
      ["browser.drag", { sessionId: "s1", sourceRef: "a", targetRef: "b" }],
      ["browser.dialog.handle", { sessionId: "s1", accept: false, promptText: "x" }],
      ["browser.files.set", { sessionId: "s1", ref: "f", paths: ["/app/browser/uploads/x/a.txt"] }],
      ["browser.downloads", { sessionId: "s1" }],
      ["browser.wait.text", { sessionId: "s1", text: "hi", options: { timeoutMs: 5 } }],
      ["browser.wait.selector", { sessionId: "s1", selector: "#x", options: undefined }],
      ["browser.wait.network-idle", { sessionId: "s1", options: { idleMs: 1 } }],
      ["browser.wait.load", { sessionId: "s1", options: { targetUrl: "https://a.test" } }],
      ["browser.screenshot", { sessionId: "s1", options: { scope: "fullPage" } }],
      ["browser.screenshot", { sessionId: "s1" }],
      ["browser.set-zoom", { sessionId: "s1", zoom: 2 }],
      ["browser.find", { sessionId: "s1", query: "q", options: { matchCase: true } }],
      ["browser.find.clear", { sessionId: "s1" }],
    ])
  })

  it("maps the ADR-0201 local surface onto the new ops", async () => {
    const e = engine()
    await e.pdf({ landscape: true })
    await e.emulate({ device: "iPhone 15", offline: true })
    await e.clearCookies("a.test")
    await e.clearCookies()
    await e.getStorage("local")
    await e.getStorage("session", "k")
    await e.setStorage("local", "k", "v")
    await e.clearStorage("session")
    await e.networkRequest("r1")
    await e.finalizeTabs()
    await e.cancelDownload("d1")
    await e.deleteDownload("d1")
    expect(mockRpc.mock.calls).toEqual([
      ["browser.pdf", { sessionId: "s1", options: { landscape: true } }],
      ["browser.emulate", { sessionId: "s1", device: "iPhone 15", offline: true }],
      ["browser.cookies.clear", { sessionId: "s1", domain: "a.test" }],
      ["browser.cookies.clear", { sessionId: "s1" }],
      ["browser.storage.get", { sessionId: "s1", area: "local" }],
      ["browser.storage.get", { sessionId: "s1", area: "session", key: "k" }],
      ["browser.storage.set", { sessionId: "s1", area: "local", key: "k", value: "v" }],
      ["browser.storage.clear", { sessionId: "s1", area: "session" }],
      ["browser.network.request", { sessionId: "s1", requestId: "r1" }],
      ["browser.tabs.finalize", { sessionId: "s1" }],
      ["browser.download.cancel", { sessionId: "s1", downloadId: "d1" }],
      ["browser.download.delete", { sessionId: "s1", downloadId: "d1" }],
    ])
  })

  it("saves a download through the native save dialog and ignores targetPath", async () => {
    const saved = {
      id: "d1",
      sessionId: "s1",
      filename: "x.pdf",
      size: 1,
      state: "saved",
      savedPath: "/Users/me/x.pdf",
    }
    mockSaveDownloadAs.mockResolvedValueOnce(saved)
    await expect(engine().saveDownload("d1", "/tmp/x.pdf")).resolves.toEqual(saved)
    expect(mockSaveDownloadAs).toHaveBeenCalledWith("s1", "d1")
    await engine().saveDownload("d2")
    expect(mockSaveDownloadAs).toHaveBeenLastCalledWith("s1", "d2")
    // The runtime op is Rust-only: the renderer never sends it.
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it("throws a typed cancel error when the user dismisses the save dialog", async () => {
    mockSaveDownloadAs.mockResolvedValueOnce(null)
    const error = await engine()
      .saveDownload("d1")
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LocalBrowserOpError)
    expect((error as LocalBrowserOpError).code).toBe(LOCAL_DOWNLOAD_SAVE_CANCELLED)
    expect(LOCAL_DOWNLOAD_SAVE_CANCELLED).toBe("browser_download_save_cancelled")
  })

  it("normalizes save_as failures into coded errors", async () => {
    mockSaveDownloadAs.mockRejectedValueOnce("download_not_found")
    await expect(engine().saveDownload("zz")).rejects.toThrow("download_not_found")
    mockSaveDownloadAs.mockRejectedValueOnce("browser_local_unavailable: runtime stopped")
    const error = await engine()
      .saveDownload("d1")
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "browser_local_unavailable", message: "runtime stopped" })
  })

  it("re-redacts credential headers on request details", async () => {
    mockRpc.mockResolvedValueOnce({
      id: "r1",
      url: "https://a.test/",
      method: "GET",
      status: 200,
      requestHeaders: { Authorization: "Bearer leaked", accept: "*/*" },
      responseHeaders: { "set-cookie": "sid=1" },
      body: "ok",
      truncated: false,
    })
    await expect(engine().networkRequest("r1")).resolves.toMatchObject({
      requestHeaders: { Authorization: "[REDACTED]", accept: "*/*" },
      responseHeaders: { "set-cookie": "[REDACTED]" },
      body: "ok",
    })
  })

  it("normalizes cookie, storage and login-form result shapes", async () => {
    const e = engine()
    mockRpc.mockResolvedValueOnce([{ name: "a", expires: -1, value: "secret" }])
    await expect(e.listCookies()).resolves.toEqual([{ name: "a", expires: null }])
    mockRpc.mockResolvedValueOnce({ cookies: [{ name: "b", expires: 1700000000 }] })
    await expect(e.listCookies("b.test")).resolves.toEqual([{ name: "b", expires: 1700000000 }])
    expect(mockRpc).toHaveBeenLastCalledWith("browser.cookies.list", {
      sessionId: "s1",
      domain: "b.test",
    })
    mockRpc.mockResolvedValueOnce({ forms: [{ ref: "f", passwordRef: "p", origin: "o" }] })
    await expect(e.detectLoginForms("p1")).resolves.toEqual([
      { ref: "f", passwordRef: "p", origin: "o" },
    ])
    mockRpc.mockResolvedValueOnce(null)
    await expect(e.detectLoginForms()).resolves.toEqual([])
    mockRpc.mockResolvedValueOnce({ cleared: 4 })
    await expect(e.clearCookies()).resolves.toEqual({ removed: 4 })
    mockRpc.mockResolvedValueOnce({ origin: "https://a.test", key: "k", value: "v" })
    await expect(e.getStorage("local", "k")).resolves.toEqual({
      area: "local",
      origin: "https://a.test",
      entries: { k: "v" },
    })
    mockRpc.mockResolvedValueOnce({ origin: "https://a.test", entries: { x: "1" } })
    await expect(e.getStorage("session")).resolves.toEqual({
      area: "session",
      origin: "https://a.test",
      entries: { x: "1" },
    })
    mockRpc.mockResolvedValueOnce({ origin: "https://a.test", key: "k" })
    await expect(e.setStorage("local", "k", "v")).resolves.toEqual({ ok: true })
  })

  it("fills credentials through Rust with the session target and the live URL", async () => {
    mockRpc.mockResolvedValueOnce({ url: "https://login.test/", title: "Login" })
    mockFillCredential.mockResolvedValueOnce({ filled: true, username: "me" })
    await expect(engine().fillCredential({ credentialId: "c1" })).resolves.toEqual({
      filled: true,
      username: "me",
      reason: null,
    })
    expect(mockFillCredential).toHaveBeenCalledWith({
      target: "local",
      sessionId: "s1",
      credentialId: "c1",
      url: "https://login.test/",
    })
    mockFillCredential.mockResolvedValueOnce({ filled: false, username: null, reason: "ambiguous" })
    await expect(
      engine().fillCredential({ url: "https://login.test/", pageId: "p1" })
    ).resolves.toEqual({ filled: false, username: null, reason: "ambiguous" })
    expect(mockFillCredential).toHaveBeenLastCalledWith({
      target: "local",
      sessionId: "s1",
      pageId: "p1",
      credentialId: null,
      url: "https://login.test/",
    })
  })

  it("locks evaluate after a successful fill, per session and across engine objects", async () => {
    mockFillCredential.mockResolvedValueOnce({ filled: false, username: null, reason: "no_match" })
    await engine().fillCredential({ url: "https://login.test/" })
    expect(engine().credentialFilled).toBe(false)

    mockFillCredential.mockResolvedValueOnce({ filled: true, username: "me" })
    await engine().fillCredential({ url: "https://login.test/" })
    expect(isLocalSessionCredentialFilled("s1")).toBe(true)

    // A fresh engine object for the same session (the pane re-binding) keeps the lock.
    const rebound = engine()
    expect(rebound.credentialFilled).toBe(true)
    mockRpc.mockClear()
    await expect(rebound.evaluate("document.querySelector('input').value")).resolves.toEqual({
      ok: false,
      code: "browser_human_input_required",
      error: expect.stringContaining("approval"),
    })
    expect(mockRpc).not.toHaveBeenCalled()

    // Another session is unaffected.
    const other = new LocalChromiumEngine("s2", "local-chromium")
    expect(other.credentialFilled).toBe(false)
    mockRpc.mockResolvedValueOnce({ ok: true, value: 1 })
    await expect(other.evaluate("1")).resolves.toEqual({ ok: true, value: 1 })

    // A person's per-call approval lets exactly that call through.
    mockRpc.mockResolvedValueOnce({ ok: true, value: "x" })
    await expect(
      rebound.evaluate("document.title", { credentialFillApproved: true })
    ).resolves.toEqual({ ok: true, value: "x" })
    expect(mockRpc).toHaveBeenLastCalledWith("browser.evaluate", {
      sessionId: "s1",
      expression: "document.title",
    })

    clearLocalSessionCredentialFilled("s1")
    expect(engine().credentialFilled).toBe(false)
  })

  it("lists only enabled extensions, and never for the user's Chrome", async () => {
    mockListExtensions.mockResolvedValue([
      { id: "a", enabled: true },
      { id: "b", enabled: false },
    ])
    await expect(engine().listExtensions()).resolves.toEqual([{ id: "a", enabled: true }])
    mockListExtensions.mockResolvedValue([
      { id: "a", enabled: true, popupPath: "popup.html", optionsPath: null },
      { id: "b", enabled: false, popupPath: "p.html", optionsPath: "o.html" },
    ])
    await engine().openExtension("a", "popup")
    expect(mockRpc).toHaveBeenLastCalledWith("browser.extension.open", {
      sessionId: "s1",
      extensionId: "a",
      page: "popup",
      path: "popup.html",
    })
    await expect(engine().openExtension("a", "options")).rejects.toMatchObject({
      code: "browser_option_invalid",
    })
    await expect(engine().openExtension("b", "popup")).rejects.toMatchObject({
      code: "extension_not_found",
    })
    const chrome = new LocalChromiumEngine("s2", "user-chrome")
    await expect(chrome.listExtensions()).rejects.toBeInstanceOf(BrowserSessionError)
    await expect(chrome.openExtension("a", "popup")).rejects.toMatchObject({
      code: "browser_feature_unsupported",
    })
  })

  it("surfaces runtime error codes on rejection", async () => {
    mockRpc.mockRejectedValueOnce("browser_page_not_found: Browser page not found")
    await expect(engine().activatePage("nope")).rejects.toMatchObject({
      code: "browser_page_not_found",
      message: "Browser page not found",
    })
    mockRpc.mockRejectedValueOnce({ code: "browser_feature_unsupported", message: "headed" })
    await expect(engine().pdf()).rejects.toMatchObject({ code: "browser_feature_unsupported" })
  })

  it("refuses unstaged upload paths with a code that says how to stage them", async () => {
    await expect(engine().setFiles("f", ["docs/cv.pdf"])).rejects.toMatchObject({
      code: LOCAL_UPLOAD_NEEDS_STAGING,
      message: expect.stringContaining("picked in the browser pane"),
    })
    expect(mockRpc).not.toHaveBeenCalled()

    mockRpc.mockRejectedValueOnce(
      "browser_upload_path_denied: Upload path is outside the allowed roots"
    )
    await expect(engine().setFiles("f", ["/Users/me/project/cv.pdf"])).rejects.toMatchObject({
      code: LOCAL_UPLOAD_NEEDS_STAGING,
    })
    mockRpc.mockRejectedValueOnce("browser_upload_not_found: Upload file does not exist")
    await expect(engine().setFiles("f", ["C:\\uploads\\gone.pdf"])).rejects.toMatchObject({
      code: "browser_upload_not_found",
    })
    expect(mockRpc).toHaveBeenLastCalledWith("browser.files.set", {
      sessionId: "s1",
      ref: "f",
      paths: ["C:\\uploads\\gone.pdf"],
    })
  })
})

describe("LocalChromiumEngine addressing a tab", () => {
  it("names its tab on every op, letting an op's own pageId win", async () => {
    const e = new LocalChromiumEngine("s1", "local-chromium", { pageId: "p7" })
    expect(e.pageId).toBe("p7")
    await e.navigate("https://a.test")
    await e.readConsole()
    await e.activatePage("p2")
    await e.closePage("p3")
    expect(mockRpc.mock.calls).toEqual([
      ["browser.navigate", { sessionId: "s1", pageId: "p7", url: "https://a.test" }],
      ["browser.console", { sessionId: "s1", pageId: "p7" }],
      ["browser.page.activate", { sessionId: "s1", pageId: "p2" }],
      ["browser.page.close", { sessionId: "s1", pageId: "p3" }],
    ])
  })

  it("leaves the page in front alone when it does not name one", async () => {
    expect(engine().pageId).toBeNull()
    await engine().getPage()
    expect(mockRpc).toHaveBeenCalledWith("browser.page", { sessionId: "s1" })
  })

  it("opens a tab behind the one in front on request", async () => {
    await engine().createPage("https://b.test", { activate: false })
    await engine().createPage(undefined, { activate: true })
    expect(mockRpc.mock.calls).toEqual([
      ["browser.page.create", { sessionId: "s1", url: "https://b.test", activate: false }],
      ["browser.page.create", { sessionId: "s1" }],
    ])
  })
})

describe("toLocalBrowserError", () => {
  it("keeps typed errors and parses coded strings", () => {
    const typed = new BrowserSessionError("browser_page_not_found", "x")
    expect(toLocalBrowserError(typed)).toBe(typed)
    expect(toLocalBrowserError({ code: "op_denied" })).toMatchObject({
      code: "op_denied",
      message: "op_denied",
    })
    expect(toLocalBrowserError(new Error("runtime_unavailable: not running"))).toBeInstanceOf(
      LocalBrowserOpError
    )
    const plain = new Error("boom")
    expect(toLocalBrowserError(plain)).toBe(plain)
    expect(toLocalBrowserError("plain text")).toMatchObject({ message: "plain text" })
  })
})
