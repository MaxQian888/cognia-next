import {
  findUrlSpans,
  isHttpUrlToken,
  startsWithHttpScheme,
  trimUrlPunctuation,
} from "./link-token"

describe("isHttpUrlToken", () => {
  it("accepts an http(s) token, including a half-typed one", () => {
    expect(isHttpUrlToken("https://github.com/a/b")).toBe(true)
    expect(isHttpUrlToken("http://localhost:3000")).toBe(true)
    // The composer sees a URL one keystroke at a time.
    expect(isHttpUrlToken("https://gi")).toBe(true)
    expect(isHttpUrlToken("HTTPS://EXAMPLE.COM")).toBe(true)
  })

  it("rejects a bare scheme, other schemes, and anything with whitespace", () => {
    expect(isHttpUrlToken("https://")).toBe(false)
    expect(isHttpUrlToken("http://")).toBe(false)
    expect(isHttpUrlToken("ftp://example.com")).toBe(false)
    expect(isHttpUrlToken("file:///etc/hosts")).toBe(false)
    expect(isHttpUrlToken("/usr/local")).toBe(false)
    expect(isHttpUrlToken("github.com/a/b")).toBe(false)
    expect(isHttpUrlToken("https://a b")).toBe(false)
  })
})

describe("startsWithHttpScheme", () => {
  it("reads a scheme at an arbitrary offset", () => {
    expect(startsWithHttpScheme("see https://x.dev", 4)).toBe(true)
    expect(startsWithHttpScheme("see https://x.dev", 0)).toBe(false)
  })
})

describe("trimUrlPunctuation", () => {
  it("drops sentence punctuation and unbalanced closers", () => {
    expect(trimUrlPunctuation("https://x.dev/a.")).toBe("https://x.dev/a")
    expect(trimUrlPunctuation("https://x.dev/a),")).toBe("https://x.dev/a")
  })

  it("keeps a balanced pair the URL really owns", () => {
    expect(trimUrlPunctuation("https://x.dev/a_(b)")).toBe("https://x.dev/a_(b)")
  })
})

describe("findUrlSpans", () => {
  it("reports each URL with indices that slice back to its own text", () => {
    const text = "see https://github.com/a/b and http://x.dev now"
    const spans = findUrlSpans(text)
    expect(spans.map((s) => s.raw)).toEqual(["https://github.com/a/b", "http://x.dev"])
    for (const span of spans) {
      expect(text.slice(span.start, span.end)).toBe(span.raw)
    }
  })

  it("excludes the trailing punctuation from the span", () => {
    const text = "(https://x.dev/a)."
    const [span] = findUrlSpans(text)
    expect(span.raw).toBe("https://x.dev/a")
    expect(text.slice(span.start, span.end)).toBe("https://x.dev/a")
  })

  it("returns nothing for text without a scheme", () => {
    expect(findUrlSpans("github.com/a/b is not a link token")).toEqual([])
  })

  it("does not carry regex state between calls", () => {
    const text = "https://a.dev https://b.dev"
    expect(findUrlSpans(text)).toHaveLength(2)
    expect(findUrlSpans(text)).toHaveLength(2)
  })
})
