/**
 * @jest-environment jsdom
 */
import {
  isBrowserSurfaceVisible,
  onBrowserUrlRequest,
  onBrowserUrlReveal,
  requestBrowserUrl,
} from "./open-url-request"

describe("browser open-url request", () => {
  it("reports false when nothing is listening, so the caller can fall back", () => {
    expect(requestBrowserUrl("https://x.dev")).toBe(false)
  })

  it("hands the URL to a listener that claims it", () => {
    const seen: string[] = []
    const off = onBrowserUrlRequest((url) => {
      seen.push(url)
      return true
    })
    expect(requestBrowserUrl("https://x.dev/a")).toBe(true)
    expect(seen).toEqual(["https://x.dev/a"])
    off()
  })

  it("carries the conversation to the listener", () => {
    const seen: unknown[] = []
    const off = onBrowserUrlReveal((_url, request) => {
      seen.push(request.chatSessionId)
      return true
    })
    expect(requestBrowserUrl("https://x.dev", { chatSessionId: "c1" })).toBe(true)
    requestBrowserUrl("https://x.dev")
    expect(seen).toEqual(["c1", undefined])
    off()
  })

  it("stays unclaimed when the listener declines", () => {
    const off = onBrowserUrlRequest(() => false)
    expect(requestBrowserUrl("https://x.dev")).toBe(false)
    off()
  })

  it("stops at the first listener that claims it", () => {
    const first = jest.fn(() => true)
    const second = jest.fn(() => true)
    const offA = onBrowserUrlRequest(first)
    const offB = onBrowserUrlRequest(second)
    expect(requestBrowserUrl("https://x.dev")).toBe(true)
    expect(first).toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    offA()
    offB()
  })

  it("unsubscribes", () => {
    const handler = jest.fn(() => true)
    onBrowserUrlRequest(handler)()
    expect(requestBrowserUrl("https://x.dev")).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it("falls through to a host that can reveal a pane", () => {
    const seen: string[] = []
    const off = onBrowserUrlReveal((url) => {
      seen.push(url)
      return true
    })
    expect(requestBrowserUrl("https://x.dev/first-click")).toBe(true)
    expect(seen).toEqual(["https://x.dev/first-click"])
    off()
  })

  it("prefers a visible pane over a host reveal", () => {
    const pane = jest.fn(() => true)
    const host = jest.fn(() => true)
    // Registered host-first on purpose. The pane has to win because it is
    // already on screen, not because it subscribed earlier.
    const offHost = onBrowserUrlReveal(host)
    const offPane = onBrowserUrlRequest(pane)
    expect(requestBrowserUrl("https://x.dev")).toBe(true)
    expect(pane).toHaveBeenCalled()
    expect(host).not.toHaveBeenCalled()
    offHost()
    offPane()
  })

  it("stays unclaimed when the host declines as well", () => {
    const offPane = onBrowserUrlRequest(() => false)
    const offHost = onBrowserUrlReveal(() => false)
    expect(requestBrowserUrl("https://x.dev")).toBe(false)
    offPane()
    offHost()
  })

  it("carries the requested backend and source to pane and host (ADR-0201 browser_open)", () => {
    const seen: unknown[] = []
    const offPane = onBrowserUrlRequest((url, request) => {
      seen.push(["pane", url, request.backend, request.source])
      return false
    })
    const offHost = onBrowserUrlReveal((url, request) => {
      seen.push(["host", url, request.backend, request.source])
      return true
    })
    expect(requestBrowserUrl("https://x.dev", { backend: "local-chromium", source: "agent" })).toBe(
      true
    )
    expect(seen).toEqual([
      ["pane", "https://x.dev", "local-chromium", "agent"],
      ["host", "https://x.dev", "local-chromium", "agent"],
    ])
    offPane()
    offHost()
  })
})

describe("isBrowserSurfaceVisible", () => {
  it("follows the document visibility", () => {
    const spy = jest.spyOn(document, "visibilityState", "get")
    spy.mockReturnValue("visible")
    expect(isBrowserSurfaceVisible()).toBe(true)
    spy.mockReturnValue("hidden")
    expect(isBrowserSurfaceVisible()).toBe(false)
    spy.mockRestore()
  })
})
