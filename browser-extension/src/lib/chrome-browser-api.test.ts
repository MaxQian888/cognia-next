/** @jest-environment jsdom */
import { createChromeBrowserApi } from "./chrome-browser-api"

interface ChromeStub {
  tabs: { query: jest.Mock; create: jest.Mock }
  scripting: { executeScript: jest.Mock }
  storage: { local: { get: jest.Mock; set: jest.Mock; remove: jest.Mock } }
  permissions: { contains: jest.Mock; request: jest.Mock }
  runtime: { getURL: jest.Mock }
  i18n: { getMessage: jest.Mock }
}

function stub(): ChromeStub {
  const chromeStub: ChromeStub = {
    tabs: {
      query: jest.fn(async () => [{ id: 7, url: "https://example.com/a", title: "A" }]),
      create: jest.fn(async () => undefined),
    },
    scripting: { executeScript: jest.fn(async () => [{ result: { title: "A" } }]) },
    storage: {
      local: {
        get: jest.fn(async () => ({ "a.key": 42 })),
        set: jest.fn(async () => undefined),
        remove: jest.fn(async () => undefined),
      },
    },
    permissions: { contains: jest.fn(async () => true), request: jest.fn(async () => true) },
    runtime: { getURL: jest.fn(() => "chrome-extension://abcdefghijklmnopabcdefghijklmnop/") },
    i18n: { getMessage: jest.fn(() => "translated") },
  }
  ;(globalThis as unknown as { chrome: ChromeStub }).chrome = chromeStub
  return chromeStub
}

describe("createChromeBrowserApi", () => {
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

  it("injects the extractor by value into exactly one tab", async () => {
    const chromeStub = stub()
    await createChromeBrowserApi().extract(7, true)
    const call = chromeStub.scripting.executeScript.mock.calls[0][0]
    expect(call.target).toEqual({ tabId: 7 })
    expect(typeof call.func).toBe("function")
    expect(call.args).toEqual([true])
    // `files` would put the extractor in a separate bundle whose behaviour
    // could only be asserted indirectly.
    expect(call.files).toBeUndefined()
  })

  it("fails loudly when the page could not be read", async () => {
    // A silent `undefined` here would become an empty capture the user
    // reviewed and approved.
    const chromeStub = stub()
    chromeStub.scripting.executeScript.mockResolvedValueOnce([{ result: undefined }])
    await expect(createChromeBrowserApi().extract(7, false)).rejects.toThrow()
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

  it("passes substitutions through to the locale lookup", async () => {
    const chromeStub = stub()
    createChromeBrowserApi().message("pairFailed", ["boom"])
    expect(chromeStub.i18n.getMessage).toHaveBeenCalledWith("pairFailed", ["boom"])
  })
})
