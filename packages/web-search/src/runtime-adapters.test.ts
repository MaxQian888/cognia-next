import {
  hasWebSearchRuntimeAdapters,
  resetWebSearchRuntimeAdaptersForTesting,
  setWebSearchRuntimeAdapters,
  webSearchFetch,
} from "./runtime-adapters"

describe("web-search runtime adapters", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    resetWebSearchRuntimeAdaptersForTesting()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    resetWebSearchRuntimeAdaptersForTesting()
  })

  it("falls back to a bare fetch until a host installs a transport", async () => {
    const bare = jest.fn().mockResolvedValue(new Response("ok"))
    globalThis.fetch = bare as unknown as typeof globalThis.fetch

    expect(hasWebSearchRuntimeAdapters()).toBe(false)
    await webSearchFetch("https://api.example.com/search", { method: "POST" })
    expect(bare).toHaveBeenCalledWith("https://api.example.com/search", { method: "POST" })
  })

  it("routes through the installed transport and reports itself installed", async () => {
    const bare = jest.fn().mockResolvedValue(new Response("bare"))
    globalThis.fetch = bare as unknown as typeof globalThis.fetch
    const proxied = jest.fn().mockResolvedValue(new Response("proxied"))

    setWebSearchRuntimeAdapters({ proxyFetch: proxied })

    expect(hasWebSearchRuntimeAdapters()).toBe(true)
    const response = await webSearchFetch("https://api.example.com/search")
    expect(await response.text()).toBe("proxied")
    expect(bare).not.toHaveBeenCalled()
  })

  it("keeps the previous transport when a partial install omits it", async () => {
    const proxied = jest.fn().mockResolvedValue(new Response("proxied"))
    setWebSearchRuntimeAdapters({ proxyFetch: proxied })
    setWebSearchRuntimeAdapters({})

    await webSearchFetch("https://api.example.com/search")
    expect(proxied).toHaveBeenCalledTimes(1)
  })

  it("resolves the transport per call, not at import time", async () => {
    const first = jest.fn().mockResolvedValue(new Response("first"))
    const second = jest.fn().mockResolvedValue(new Response("second"))

    setWebSearchRuntimeAdapters({ proxyFetch: first })
    await webSearchFetch("https://api.example.com/a")
    setWebSearchRuntimeAdapters({ proxyFetch: second })
    await webSearchFetch("https://api.example.com/b")

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it("restores the bare default on reset", async () => {
    const bare = jest.fn().mockResolvedValue(new Response("bare"))
    globalThis.fetch = bare as unknown as typeof globalThis.fetch
    setWebSearchRuntimeAdapters({ proxyFetch: jest.fn() })

    resetWebSearchRuntimeAdaptersForTesting()

    expect(hasWebSearchRuntimeAdapters()).toBe(false)
    await webSearchFetch("https://api.example.com/search")
    expect(bare).toHaveBeenCalled()
  })
})
