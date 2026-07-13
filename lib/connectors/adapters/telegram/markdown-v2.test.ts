import {
  escapeMdV2,
  escapeMdV2Code,
  escapeMdV2Url,
  chunkTelegramText,
  TELEGRAM_TEXT_LIMIT,
  TELEGRAM_CAPTION_LIMIT,
} from "./markdown-v2"

describe("escapeMdV2", () => {
  it("escapes all 18 special characters", () => {
    const input = "_*[]()~`>#+-=|{}.!"
    expect(escapeMdV2(input)).toBe("\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!")
  })

  it("escapes the backslash itself (audited fix #4b)", () => {
    // A literal backslash followed by a dot: both must be escaped, and the
    // backslash must not swallow the dot's escape.
    expect(escapeMdV2("\\.")).toBe("\\\\\\.")
    expect(escapeMdV2("a\\b")).toBe("a\\\\b")
  })

  it("round-trips text containing pre-escaped sequences without dropping input", () => {
    // "\\." (backslash + dot in the source string) — every char is prefixed
    // exactly once so Telegram renders the literal backslash + dot.
    const out = escapeMdV2("\\.")
    // unescaping (strip one level of backslash-prefix) restores the input
    expect(out.replace(/\\(.)/g, "$1")).toBe("\\.")
  })

  it("leaves normal text untouched", () => {
    expect(escapeMdV2("Hello World")).toBe("Hello World")
  })
})

describe("escapeMdV2Code", () => {
  it("escapes only backtick and backslash (code context)", () => {
    expect(escapeMdV2Code("a.b() + x_y! `tick` \\slash")).toBe(
      "a.b() + x_y! \\`tick\\` \\\\slash"
    )
  })

  it("leaves all other MarkdownV2 specials alone", () => {
    expect(escapeMdV2Code("_*[]()~>#+-=|{}.!")).toBe("_*[]()~>#+-=|{}.!")
  })
})

describe("escapeMdV2Url", () => {
  it("escapes only ) and backslash (link-url context)", () => {
    expect(escapeMdV2Url("https://x.dev/a_(b)\\c")).toBe("https://x.dev/a_(b\\)\\\\c")
  })

  it("leaves plain URLs untouched", () => {
    expect(escapeMdV2Url("https://example.com/path?q=1")).toBe("https://example.com/path?q=1")
  })
})

describe("chunkTelegramText", () => {
  it("returns the text unchanged when under the limit", () => {
    expect(chunkTelegramText("short", 10)).toEqual(["short"])
  })

  it("returns [] for empty text", () => {
    expect(chunkTelegramText("", 10)).toEqual([])
  })

  it("prefers newline boundaries", () => {
    const text = "line one\nline two\nline three"
    const chunks = chunkTelegramText(text, 12)
    expect(chunks).toEqual(["line one", "line two", "line three"])
  })

  it("falls back to space boundaries when no newline fits", () => {
    const chunks = chunkTelegramText("aaaa bbbb cccc", 11)
    expect(chunks).toEqual(["aaaa bbbb", "cccc"])
  })

  it("hard-cuts when no boundary exists in the window", () => {
    const chunks = chunkTelegramText("x".repeat(25), 10)
    expect(chunks).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)])
  })

  it("every chunk respects the limit and no content is lost", () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n")
    const chunks = chunkTelegramText(text, 100)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100)
    expect(chunks.join("\n")).toBe(text)
  })

  it("defaults to the Telegram 4096 text limit", () => {
    expect(TELEGRAM_TEXT_LIMIT).toBe(4096)
    expect(TELEGRAM_CAPTION_LIMIT).toBe(1024)
    const chunks = chunkTelegramText("a".repeat(5000))
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toHaveLength(4096)
  })
})
