import { domainOf, normalizeUrl, sameUrl } from "./url"

describe("normalizeUrl", () => {
  it("drops the fragment and trailing slash, lowercases", () => {
    expect(normalizeUrl("https://Example.com/Path/#section")).toBe("https://example.com/path")
  })

  it("strips utm_* and common tracking params", () => {
    expect(normalizeUrl("https://x.com/a?utm_source=z&q=1&fbclid=abc")).toBe("https://x.com/a?q=1")
  })

  it("falls back to a lowercased trim for non-URLs", () => {
    expect(normalizeUrl("  NOT a url ")).toBe("not a url")
  })
})

describe("sameUrl", () => {
  it("matches across fragment/case/trailing-slash differences", () => {
    expect(sameUrl("https://x.com/a/", "https://X.com/a#top")).toBe(true)
  })

  it("distinguishes different paths", () => {
    expect(sameUrl("https://x.com/a", "https://x.com/b")).toBe(false)
  })
})

describe("domainOf", () => {
  it("lowercases the host and strips a leading www", () => {
    expect(domainOf("https://WWW.Example.com/path")).toBe("example.com")
  })

  it("keeps subdomains distinct from the apex", () => {
    expect(domainOf("https://en.wikipedia.org/a")).toBe("en.wikipedia.org")
  })

  it("returns an empty bucket for non-URLs", () => {
    expect(domainOf("not a url")).toBe("")
  })
})
