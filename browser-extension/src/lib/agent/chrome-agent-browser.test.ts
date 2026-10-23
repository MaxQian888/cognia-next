/** @jest-environment jsdom */
import {
  chromeStorageArea,
  cookieUrl,
  createChromeAgentBrowser,
  toDownloadRecord,
} from "./chrome-agent-browser"

function stub() {
  const listeners: ((changes: Record<string, { newValue?: unknown }>, area: string) => void)[] = []
  const chromeStub = {
    tabs: {
      get: jest.fn(async (id: number) => {
        if (id === 404) throw new Error("No tab with id")
        return {
          id,
          windowId: 3,
          url: "",
          pendingUrl: "https://example.com/next",
          title: "T",
          status: "loading",
          active: true,
          groupId: -1,
        }
      }),
      create: jest.fn(async (input: { url: string; active: boolean }) => ({
        id: 9,
        windowId: 3,
        url: input.url,
        title: "",
        status: "complete",
        active: input.active,
        groupId: -1,
      })),
      update: jest.fn(async () => null),
      remove: jest.fn(async () => undefined),
      goBack: jest.fn(async () => undefined),
      goForward: jest.fn(async () => undefined),
      reload: jest.fn(async () => undefined),
      group: jest.fn(async () => 11),
      ungroup: jest.fn(async () => undefined),
      captureVisibleTab: jest.fn(async () => "data:image/png;base64,AA=="),
      setZoom: jest.fn(async () => undefined),
      getZoom: jest.fn(async () => 1.25),
    },
    tabGroups: {
      get: jest.fn(async (id: number) => {
        if (id === 99) throw new Error("No group")
        return { id }
      }),
      update: jest.fn(async () => undefined),
    },
    scripting: { executeScript: jest.fn(async () => [{ result: { ok: true } }]) },
    permissions: { contains: jest.fn(async () => true) },
    downloads: {
      search: jest.fn(async () => [
        {
          id: 4,
          url: "https://a/f",
          finalUrl: "https://b/f",
          filename: "/d/f.pdf",
          mime: "application/pdf",
          startTime: "2026-10-16T00:00:00.000Z",
          endTime: "2026-10-16T00:00:05.000Z",
          state: "complete",
          bytesReceived: 10,
          totalBytes: 10,
          fileSize: 10,
          exists: true,
        },
      ]),
      cancel: jest.fn(async () => undefined),
      removeFile: jest.fn(async () => undefined),
      erase: jest.fn(async () => [4]),
    },
    cookies: {
      getAll: jest.fn(async () => [
        {
          name: "sid",
          value: "v",
          domain: ".example.com",
          path: "/app",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
          storeId: "0",
          hostOnly: false,
          session: true,
        },
      ]),
      remove: jest.fn(async () => undefined),
    },
    storage: {
      local: {
        get: jest.fn(async () => ({ k: 1 })),
        set: jest.fn(async () => undefined),
        remove: jest.fn(async () => undefined),
      },
      session: {
        get: jest.fn(async () => ({})),
        set: jest.fn(async () => undefined),
        remove: jest.fn(async () => undefined),
      },
      onChanged: {
        addListener: jest.fn((listener: (typeof listeners)[number]) => listeners.push(listener)),
        removeListener: jest.fn(),
      },
    },
    i18n: { getMessage: jest.fn((key: string) => (key === "known" ? "Known" : "")) },
  }
  ;(globalThis as unknown as { chrome: unknown }).chrome = chromeStub
  return { chromeStub, listeners }
}

describe("createChromeAgentBrowser", () => {
  it("does not group tabs after revocation during the group lookup", async () => {
    const { chromeStub } = stub()
    let resolve: (value: { id: number }) => void = () => undefined
    chromeStub.tabGroups.get.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const controller = new AbortController()
    const pending = createChromeAgentBrowser().group([1], 12, 3, () =>
      controller.signal.throwIfAborted()
    )
    const error = new Error("revoked")
    controller.abort(error)
    resolve({ id: 12 })
    await expect(pending).rejects.toBe(error)
    expect(chromeStub.tabs.group).not.toHaveBeenCalled()
  })

  it("does not remove or erase downloads after revocation during search", async () => {
    const { chromeStub } = stub()
    const items = await chromeStub.downloads.search()
    let resolve: (value: typeof items) => void = () => undefined
    chromeStub.downloads.search.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const controller = new AbortController()
    const pending = createChromeAgentBrowser().deleteDownload(4, () =>
      controller.signal.throwIfAborted()
    )
    const error = new Error("revoked")
    controller.abort(error)
    resolve(items)
    await expect(pending).rejects.toBe(error)
    expect(chromeStub.downloads.removeFile).not.toHaveBeenCalled()
    expect(chromeStub.downloads.erase).not.toHaveBeenCalled()
  })
  it("reads tabs, using the pending URL of a tab still loading, and null for a closed one", async () => {
    stub()
    const browser = createChromeAgentBrowser()
    await expect(browser.getTab(5)).resolves.toMatchObject({
      id: 5,
      url: "https://example.com/next",
      status: "loading",
      windowId: 3,
    })
    await expect(browser.getTab(404)).resolves.toBeNull()
  })

  it("joins an existing group, and starts a new one when it was dissolved", async () => {
    const { chromeStub } = stub()
    const browser = createChromeAgentBrowser()
    await browser.group([1, 2], 12, 3)
    expect(chromeStub.tabs.group).toHaveBeenLastCalledWith({ tabIds: [1, 2], groupId: 12 })
    await browser.group([1], 99, 3)
    expect(chromeStub.tabs.group).toHaveBeenLastCalledWith({
      tabIds: [1],
      createProperties: { windowId: 3 },
    })
    await browser.styleGroup(11, "Cognia")
    expect(chromeStub.tabGroups.update).toHaveBeenCalledWith(11, { title: "Cognia", color: "blue" })
    await expect(browser.group([], null, null)).rejects.toThrow("no tabs")
  })

  it("injects files and runs functions in the named world", async () => {
    const { chromeStub } = stub()
    const browser = createChromeAgentBrowser()
    await browser.injectFile(5, "/page-hooks.js", "MAIN")
    expect(chromeStub.scripting.executeScript).toHaveBeenLastCalledWith({
      target: { tabId: 5 },
      files: ["/page-hooks.js"],
      world: "MAIN",
    })
    const func = (a: number) => a + 1
    await expect(browser.run(5, "ISOLATED", func, [1])).resolves.toEqual({ ok: true })
    expect(chromeStub.scripting.executeScript).toHaveBeenLastCalledWith({
      target: { tabId: 5 },
      world: "ISOLATED",
      func,
      args: [1],
    })
  })

  it("captures PNG and reads zoom", async () => {
    const { chromeStub } = stub()
    const browser = createChromeAgentBrowser()
    await expect(browser.captureVisible(3)).resolves.toBe("data:image/png;base64,AA==")
    expect(chromeStub.tabs.captureVisibleTab).toHaveBeenCalledWith(3, { format: "png" })
    await expect(browser.getZoom(5)).resolves.toBe(1.25)
  })

  it("searches downloads from just before the conversation started, and deletes file then entry", async () => {
    const { chromeStub } = stub()
    const browser = createChromeAgentBrowser()
    const [item] = await browser.searchDownloads(Date.parse("2026-10-16T00:00:00.000Z"))
    expect(chromeStub.downloads.search).toHaveBeenCalledWith({
      startedAfter: "2026-10-15T23:59:59.999Z",
      orderBy: ["-startTime"],
    })
    expect(item).toMatchObject({
      id: 4,
      url: "https://b/f",
      startTime: Date.parse("2026-10-16T00:00:00.000Z"),
    })
    await browser.deleteDownload(4)
    expect(chromeStub.downloads.removeFile).toHaveBeenCalledWith(4)
    expect(chromeStub.downloads.erase).toHaveBeenCalledWith({ id: 4 })
    expect(chromeStub.downloads.cancel).not.toHaveBeenCalled()
  })

  it("reads and removes cookies by their own URL and store", async () => {
    const { chromeStub } = stub()
    const browser = createChromeAgentBrowser()
    const [cookie] = await browser.getCookies("example.com")
    expect(cookie).toEqual({
      name: "sid",
      value: "v",
      domain: ".example.com",
      path: "/app",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      storeId: "0",
    })
    await browser.removeCookie(cookie!)
    expect(chromeStub.cookies.remove).toHaveBeenCalledWith({
      url: "https://example.com/app",
      name: "sid",
      storeId: "0",
    })
  })

  it("falls back to the key for a missing message", () => {
    stub()
    const browser = createChromeAgentBrowser()
    expect(browser.message("known")).toBe("Known")
    expect(browser.message("missing")).toBe("missing")
  })
})

describe("helpers", () => {
  it("builds cookie URLs", () => {
    expect(cookieUrl({ domain: "a.test", path: "", secure: false })).toBe("http://a.test/")
  })

  it("keeps an interrupted download's error", () => {
    expect(
      toDownloadRecord({
        id: 1,
        url: "u",
        finalUrl: "",
        filename: "f",
        mime: "m",
        startTime: "bad",
        state: "interrupted",
        error: "NETWORK_FAILED",
        bytesReceived: 1,
        totalBytes: 2,
        fileSize: 0,
        exists: false,
      } as unknown as chrome.downloads.DownloadItem)
    ).toEqual({
      id: 1,
      url: "u",
      filename: "f",
      mime: "m",
      startTime: 0,
      state: "interrupted",
      error: "NETWORK_FAILED",
      bytesReceived: 1,
      totalBytes: 2,
      fileSize: 0,
      exists: false,
    })
  })
})

describe("chromeStorageArea", () => {
  it("reads, writes and listens to one area only", async () => {
    const { chromeStub, listeners } = stub()
    const area = chromeStorageArea("session")
    await expect(area.get("missing")).resolves.toBeNull()
    await area.set("k", 2)
    expect(chromeStub.storage.session.set).toHaveBeenCalledWith({ k: 2 })
    const seen: unknown[] = []
    area.onChange("k", (value) => seen.push(value))
    listeners[0]?.({ k: { newValue: 3 } }, "local")
    listeners[0]?.({ k: { newValue: 4 } }, "session")
    listeners[0]?.({ k: {} }, "session")
    expect(seen).toEqual([4, null])
  })
})
