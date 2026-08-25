/**
 * @jest-environment jsdom
 */
import { onBrowserUrlRequest, requestBrowserUrl } from "./open-url-request"

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
})
