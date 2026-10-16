import {
  CAPTURE_COMMANDS,
  CAPTURE_MENU_IDS,
  CAPTURE_REQUEST_TTL_MS,
  MAX_OMNIBOX_INSTRUCTION,
  captureRequestForCommand,
  captureRequestForMenu,
  captureRequestForOmnibox,
  isFreshCaptureRequest,
  parseCaptureRequest,
  quickActionMenuId,
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

  it("carries a right-clicked link or image, web addresses only", () => {
    expect(
      captureRequestForMenu(
        {
          menuItemId: CAPTURE_MENU_IDS.link,
          linkUrl: "https://a.test/x",
          selectionText: " Read me ",
        },
        7,
        100
      )
    ).toEqual({
      tabId: 7,
      mode: "link",
      requestedAt: 100,
      linkUrl: "https://a.test/x",
      linkText: "Read me",
    })
    expect(
      captureRequestForMenu(
        { menuItemId: CAPTURE_MENU_IDS.link, linkUrl: "javascript:alert(1)" },
        7,
        1
      )
    ).toBeNull()
    expect(
      captureRequestForMenu(
        { menuItemId: CAPTURE_MENU_IDS.image, srcUrl: "https://a.test/i.png" },
        7,
        1
      )
    ).toMatchObject({ mode: "image", srcUrl: "https://a.test/i.png" })
    expect(
      captureRequestForMenu(
        { menuItemId: CAPTURE_MENU_IDS.image, srcUrl: "data:image/png;base64,AA" },
        7,
        1
      )
    ).toBeNull()
    expect(captureRequestForMenu(CAPTURE_MENU_IDS.article, 7, 1)).toMatchObject({ mode: "article" })
  })

  it("runs a quick action on the selection when there is one, else the article", () => {
    expect(
      captureRequestForMenu(
        { menuItemId: quickActionMenuId("translate"), selectionText: "hola" },
        7,
        1
      )
    ).toEqual({ tabId: 7, mode: "selection", requestedAt: 1, quickAction: "translate" })
    expect(
      captureRequestForMenu({ menuItemId: quickActionMenuId("summarize") }, 7, 1)
    ).toMatchObject({
      mode: "article",
      quickAction: "summarize",
    })
    expect(captureRequestForMenu(CAPTURE_MENU_IDS.quick, 7, 1)).toBeNull()
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

describe("captureRequestForCommand", () => {
  it("maps each shortcut", () => {
    expect(captureRequestForCommand(CAPTURE_COMMANDS.page, 3, 9)).toEqual({
      tabId: 3,
      mode: "auto",
      requestedAt: 9,
    })
    expect(captureRequestForCommand(CAPTURE_COMMANDS.selection, 3, 9)).toMatchObject({
      mode: "selection",
    })
    expect(captureRequestForCommand(CAPTURE_COMMANDS.article, 3, 9)).toMatchObject({
      mode: "article",
    })
    expect(captureRequestForCommand("_execute_action", 3, 9)).toBeNull()
  })
})

describe("captureRequestForOmnibox", () => {
  it("uses the typed text as the instruction, bounded", () => {
    expect(captureRequestForOmnibox("  summarize this ", 3, 9)).toEqual({
      tabId: 3,
      mode: "auto",
      requestedAt: 9,
      instruction: "summarize this",
    })
    expect(captureRequestForOmnibox("   ", 3, 9)).toBeNull()
    expect(captureRequestForOmnibox("x".repeat(5_000), 3, 9)?.instruction).toHaveLength(
      MAX_OMNIBOX_INSTRUCTION
    )
  })
})

describe("parseCaptureRequest", () => {
  it("keeps what is well-formed and drops the rest", () => {
    expect(
      parseCaptureRequest({
        tabId: 1,
        mode: "link",
        requestedAt: 2,
        linkUrl: "https://a.test",
        quickAction: "explain",
        extra: true,
      })
    ).toEqual({
      tabId: 1,
      mode: "link",
      requestedAt: 2,
      linkUrl: "https://a.test",
      quickAction: "explain",
    })
    expect(parseCaptureRequest({ tabId: 1, mode: "link", requestedAt: 2 })).toBeNull()
    expect(parseCaptureRequest({ tabId: 1, mode: "teleport", requestedAt: 2 })).toBeNull()
    expect(
      parseCaptureRequest({ tabId: 1, mode: "auto", requestedAt: 2, quickAction: "rm" })
    ).toEqual({
      tabId: 1,
      mode: "auto",
      requestedAt: 2,
    })
    expect(parseCaptureRequest(null)).toBeNull()
  })
})
