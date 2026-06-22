import {
  getProviderCoreLogger,
  isTauri,
  proxyFetch,
  resetProviderCoreRuntimeAdaptersForTesting,
  setProviderCoreRuntimeAdapters,
} from "./runtime-adapters"

describe("provider-core runtime adapters", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    resetProviderCoreRuntimeAdaptersForTesting()
    globalThis.fetch = jest.fn().mockResolvedValue(new Response("ok")) as unknown as typeof fetch
    delete (globalThis.window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  afterEach(() => {
    resetProviderCoreRuntimeAdaptersForTesting()
    globalThis.fetch = originalFetch
    delete (globalThis.window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it("detects Tauri from the default window marker", () => {
    expect(isTauri()).toBe(false)
    ;(globalThis.window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    expect(isTauri()).toBe(true)
  })

  it("uses an injected platform detector when wired by the host", () => {
    setProviderCoreRuntimeAdapters({ isTauri: () => true })
    expect(isTauri()).toBe(true)
  })

  it("uses the default fetch adapter with timeout support", async () => {
    await proxyFetch("https://example.com", { method: "GET", timeout: 1000 })
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
      })
    )
  })

  it("uses an injected proxyFetch implementation", async () => {
    const injected = jest.fn().mockResolvedValue(new Response("wired"))
    setProviderCoreRuntimeAdapters({ proxyFetch: injected })

    const response = await proxyFetch("https://example.com", { method: "POST" })

    expect(await response.text()).toBe("wired")
    expect(injected).toHaveBeenCalledWith("https://example.com", { method: "POST" })
  })

  it("forwards logger calls through the currently wired logger", () => {
    const first = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
    const second = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
    const log = getProviderCoreLogger("ai")

    setProviderCoreRuntimeAdapters({ loggers: { ai: first } })
    log.info("first", { providerId: "openai" })

    setProviderCoreRuntimeAdapters({ loggers: { ai: second } })
    log.warn("second", { providerId: "anthropic" })

    expect(first.info).toHaveBeenCalledWith("first", { providerId: "openai" })
    expect(second.warn).toHaveBeenCalledWith("second", { providerId: "anthropic" })
  })
})
