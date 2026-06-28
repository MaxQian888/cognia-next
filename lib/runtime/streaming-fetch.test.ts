import { isCapacitor } from "@/lib/platform/detect"

import { browserDirectHeaders, getStreamingFetch } from "./streaming-fetch"

jest.mock("@/lib/platform/detect", () => ({ isCapacitor: jest.fn() }))

const mockIsCapacitor = isCapacitor as jest.MockedFunction<typeof isCapacitor>

describe("getStreamingFetch", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
    delete (window as unknown as { CapacitorWebFetch?: unknown }).CapacitorWebFetch
    jest.clearAllMocks()
  })

  it("uses the global fetch off Capacitor", async () => {
    mockIsCapacitor.mockReturnValue(false)
    const global = jest.fn().mockResolvedValue(new Response("ok"))
    globalThis.fetch = global as unknown as typeof fetch
    const native = jest.fn()
    ;(window as unknown as { CapacitorWebFetch?: unknown }).CapacitorWebFetch = native

    await getStreamingFetch()("https://x")
    expect(global).toHaveBeenCalledWith("https://x")
    expect(native).not.toHaveBeenCalled()
  })

  it("uses the stashed native browser fetch on Capacitor (bypasses the buffering patch)", async () => {
    mockIsCapacitor.mockReturnValue(true)
    const native = jest.fn().mockResolvedValue(new Response("stream"))
    ;(window as unknown as { CapacitorWebFetch?: unknown }).CapacitorWebFetch = native
    const global = jest.fn()
    globalThis.fetch = global as unknown as typeof fetch

    await getStreamingFetch()("https://api.anthropic.com")
    expect(native).toHaveBeenCalledWith("https://api.anthropic.com")
    expect(global).not.toHaveBeenCalled()
  })

  it("falls back to global fetch on Capacitor when the native fetch is missing", async () => {
    mockIsCapacitor.mockReturnValue(true)
    const global = jest.fn().mockResolvedValue(new Response("ok"))
    globalThis.fetch = global as unknown as typeof fetch

    await getStreamingFetch()("https://x")
    expect(global).toHaveBeenCalledWith("https://x")
  })

  it("returns the (undefined) global when no fetch exists, without throwing", () => {
    mockIsCapacitor.mockReturnValue(false)
    // @ts-expect-error simulate an environment without a global fetch
    globalThis.fetch = undefined
    expect(() => getStreamingFetch()).not.toThrow()
    expect(getStreamingFetch()).toBeUndefined()
  })
})

describe("browserDirectHeaders", () => {
  it("adds the Anthropic browser-direct opt-in header", () => {
    expect(browserDirectHeaders("anthropic")).toEqual({
      "anthropic-dangerous-direct-browser-access": "true",
    })
  })
  it("adds nothing for OpenAI / Google / unknown", () => {
    expect(browserDirectHeaders("openai")).toEqual({})
    expect(browserDirectHeaders("google")).toEqual({})
    expect(browserDirectHeaders(undefined)).toEqual({})
  })
})
