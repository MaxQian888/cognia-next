/** @jest-environment jsdom */
import { isCapacitor } from "@/lib/platform/detect"

import { PROVIDERS } from "@cognia/provider-types/provider"

import {
  BROWSER_STREAMING_PROVIDER_IDS,
  browserDirectHeaders,
  getStreamingFetch,
  streamsDirectFromBrowser,
} from "./streaming-fetch"

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

describe("streamsDirectFromBrowser", () => {
  it("accepts the three providers whose official endpoint allows a browser origin", () => {
    expect(streamsDirectFromBrowser("anthropic")).toBe(true)
    expect(streamsDirectFromBrowser("openai")).toBe(true)
    expect(streamsDirectFromBrowser("google")).toBe(true)
  })

  it("rejects a provider that is not on the list", () => {
    // deepseek speaks the `openai` protocol, so `browserDirectHeaders` is happy
    // to send it nothing extra. That is a statement about the wire format, not
    // about api.deepseek.com's CORS policy, which is exactly why this predicate
    // is keyed by id rather than derived from the protocol.
    expect(streamsDirectFromBrowser("deepseek")).toBe(false)
    expect(streamsDirectFromBrowser("ollama")).toBe(false)
  })

  it("rejects a missing id instead of throwing", () => {
    expect(streamsDirectFromBrowser(undefined)).toBe(false)
    expect(streamsDirectFromBrowser(null)).toBe(false)
    expect(streamsDirectFromBrowser("")).toBe(false)
  })

  it("names real catalog entries", () => {
    // The list is hand written, so nothing else would catch a typo or a
    // provider id that gets renamed out from under it.
    for (const id of BROWSER_STREAMING_PROVIDER_IDS) {
      expect(PROVIDERS[id]).toBeDefined()
      expect(PROVIDERS[id]?.apiKeyRequired).toBe(true)
    }
  })
})
