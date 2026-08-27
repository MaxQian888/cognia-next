import { isCapturableUrl, normalizeCaptureUrl } from "./normalize-url"

describe("normalizeCaptureUrl", () => {
  it("strips the query and fragment by default", () => {
    // A query string is not metadata: it routinely carries session tokens,
    // one-time reset links, tracking ids, and — on a results page — the thing
    // the person was searching for.
    const decision = normalizeCaptureUrl("https://example.com/a?token=abc123#section")
    expect(decision).toEqual({
      ok: true,
      url: "https://example.com/a",
      strippedQuery: true,
      strippedFragment: true,
    })
  })

  it("keeps them when the user explicitly asks", () => {
    const decision = normalizeCaptureUrl("https://example.com/a?q=cats#top", true)
    expect(decision).toMatchObject({ ok: true, url: "https://example.com/a?q=cats#top" })
  })

  it("strips credentials even when the full URL is requested", () => {
    // There is no capture for which a password in a field labelled "address"
    // is the right answer.
    const decision = normalizeCaptureUrl("https://user:hunter2@example.com/a?q=1", true)
    expect(decision).toMatchObject({ ok: true })
    if (!decision.ok) return
    expect(decision.url).not.toContain("hunter2")
    expect(decision.url).not.toContain("user")
    expect(decision.url).toContain("?q=1")
  })

  it("does not claim to have stripped what was not there", () => {
    const decision = normalizeCaptureUrl("https://example.com/a")
    expect(decision).toMatchObject({ strippedQuery: false, strippedFragment: false })
  })

  it("refuses every scheme that is not an ordinary web page", () => {
    for (const url of [
      "file:///etc/passwd",
      "chrome://settings",
      "about:blank",
      "data:text/html,<h1>x",
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop/panel.html",
      "javascript:alert(1)",
      "view-source:https://example.com",
    ]) {
      expect(normalizeCaptureUrl(url)).toEqual({ ok: false, reason: "unsupported-scheme" })
      expect(isCapturableUrl(url)).toBe(false)
    }
  })

  it("reports an unparseable address separately from a refused scheme", () => {
    // "we do not capture this kind of page" and "that is not an address" are
    // different sentences to show somebody.
    expect(normalizeCaptureUrl("not a url")).toEqual({ ok: false, reason: "unparseable" })
  })

  it("accepts plain http as well as https", () => {
    expect(isCapturableUrl("http://localhost:3000/x")).toBe(true)
    expect(isCapturableUrl("https://example.com")).toBe(true)
  })
})
