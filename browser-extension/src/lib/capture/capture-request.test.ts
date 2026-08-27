import {
  CAPTURE_MENU_IDS,
  CAPTURE_REQUEST_TTL_MS,
  captureRequestForMenu,
  isFreshCaptureRequest,
  shouldOfferCaptureMenu,
} from "./capture-request"

describe("shouldOfferCaptureMenu", () => {
  it("offers only on ordinary web pages", () => {
    expect(shouldOfferCaptureMenu("https://example.com")).toBe(true)
    expect(shouldOfferCaptureMenu("http://localhost:3000")).toBe(true)
    for (const url of ["chrome://extensions", "file:///tmp/a", "about:blank", ""]) {
      expect(shouldOfferCaptureMenu(url)).toBe(false)
    }
  })
})

describe("captureRequestForMenu", () => {
  it("maps each menu entry to its mode", () => {
    expect(captureRequestForMenu(CAPTURE_MENU_IDS.selection, 7, 100)).toEqual({
      tabId: 7,
      mode: "selection",
      requestedAt: 100,
    })
    expect(captureRequestForMenu(CAPTURE_MENU_IDS.page, 7, 100)).toMatchObject({ mode: "page" })
  })

  it("ignores menu ids that are not ours", () => {
    // Other extensions' entries arrive on the same listener.
    expect(captureRequestForMenu("some-other-extension-item", 7, 100)).toBeNull()
  })
})

describe("isFreshCaptureRequest", () => {
  it("accepts a request made moments ago", () => {
    expect(isFreshCaptureRequest({ tabId: 1, mode: "auto", requestedAt: 1_000 }, 1_500)).toBe(true)
  })

  it("rejects one the browser held while the panel was shut", () => {
    // Tab ids are reused. Acting on a stale request captures whatever tab now
    // holds that id, which is not what anybody asked for.
    const request = { tabId: 1, mode: "auto" as const, requestedAt: 1_000 }
    expect(isFreshCaptureRequest(request, 1_000 + CAPTURE_REQUEST_TTL_MS)).toBe(false)
  })

  it("rejects one stamped in the future rather than trusting it", () => {
    // A clock change makes this reachable, and "very fresh" is the wrong
    // reading of a timestamp that has not happened yet.
    expect(isFreshCaptureRequest({ tabId: 1, mode: "auto", requestedAt: 5_000 }, 1_000)).toBe(false)
  })
})
