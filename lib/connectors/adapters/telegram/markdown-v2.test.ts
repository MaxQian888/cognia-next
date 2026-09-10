import {
  escapeMdV2,
  escapeMdV2Code,
  escapeMdV2Url,
  chunkTelegramText,
  chunkTelegramMarkdownV2,
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

describe("chunkTelegramMarkdownV2", () => {
  it("handles each emitted style and empty formatting without losing text", () => {
    expect(chunkTelegramMarkdownV2("__under__ ~strike~ ||secret|| *bold* _italic_ **")[0]).toEqual({
      text: "under strike secret bold italic ",
      entities: [
        { type: "underline", offset: 0, length: 5 },
        { type: "strikethrough", offset: 6, length: 6 },
        { type: "spoiler", offset: 13, length: 6 },
        { type: "bold", offset: 20, length: 4 },
        { type: "italic", offset: 25, length: 6 },
      ],
    })
    expect(chunkTelegramMarkdownV2(">quoted")[0].entities).toEqual([
      { type: "blockquote", offset: 0, length: 6 },
    ])
    expect(chunkTelegramMarkdownV2("```\nno language\n```")[0]).toEqual({
      text: "no language",
      entities: [{ type: "pre", offset: 0, length: 11 }],
    })
    expect(chunkTelegramMarkdownV2("```no newline```")[0].text).toBe("no newline")
    expect(chunkTelegramMarkdownV2("[*bold*](https://example.com)")[0].entities).toHaveLength(2)
  })

  it.each(["*unclosed", "`unclosed", "[label", "[label](url"])(
    "rejects malformed markup %s",
    (source) => {
      expect(() => chunkTelegramMarkdownV2(source)).toThrow(/Unclosed/)
    }
  )
  it("splits nested bold and links into independently valid entity ranges", () => {
    const chunks = chunkTelegramMarkdownV2("*ab_[cdefgh](https://example.com/a\\))_ij*", 4)
    expect(chunks).toEqual([
      {
        text: "abcd",
        entities: [
          { type: "bold", offset: 0, length: 4 },
          { type: "italic", offset: 2, length: 2 },
          { type: "text_link", offset: 2, length: 2, url: "https://example.com/a)" },
        ],
      },
      {
        text: "efgh",
        entities: [
          { type: "bold", offset: 0, length: 4 },
          { type: "italic", offset: 0, length: 4 },
          { type: "text_link", offset: 0, length: 4, url: "https://example.com/a)" },
        ],
      },
      { text: "ij", entities: [{ type: "bold", offset: 0, length: 2 }] },
    ])
  })

  it("preserves code, language, escaped syntax, whitespace and Unicode", () => {
    const code = "a😀 = `x`;\\n\nend"
    const chunks = chunkTelegramMarkdownV2("```ts\n" + escapeMdV2Code(code) + "\n```", 6)
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(code)
    for (const chunk of chunks) {
      expect(chunk.entities).toEqual([
        { type: "pre", offset: 0, length: chunk.text.length, language: "ts" },
      ])
      expect(chunk.text).not.toMatch(/[\uD800-\uDBFF]$/u)
    }
  })

  it("retains blockquotes and inline code as explicit entities", () => {
    const chunks = chunkTelegramMarkdownV2(">*hello*\n>world\n`a\\`b` \\*literal\\*", 100)
    expect(chunks[0].text).toBe("hello\nworld\na`b *literal*")
    expect(chunks[0].entities).toEqual([
      { type: "blockquote", offset: 0, length: 11 },
      { type: "bold", offset: 0, length: 5 },
      { type: "code", offset: 12, length: 3 },
    ])
  })
})

describe("escapeMdV2Code", () => {
  it("escapes only backtick and backslash (code context)", () => {
    expect(escapeMdV2Code("a.b() + x_y! `tick` \\slash")).toBe("a.b() + x_y! \\`tick\\` \\\\slash")
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
  it.each([0, -1, 1.5])("rejects invalid limit %s", (limit) => {
    expect(() => chunkTelegramText("text", limit)).toThrow(RangeError)
  })
  it("rejects a limit too small for a Unicode character", () => {
    expect(() => chunkTelegramText("😀", 1)).toThrow(RangeError)
  })
  it("returns the text unchanged when under the limit", () => {
    expect(chunkTelegramText("short", 10)).toEqual(["short"])
  })

  it("returns [] for empty text", () => {
    expect(chunkTelegramText("", 10)).toEqual([])
  })

  it("prefers newline boundaries", () => {
    const text = "line one\nline two\nline three"
    const chunks = chunkTelegramText(text, 12)
    expect(chunks).toEqual(["line one\n", "line two\n", "line three"])
  })

  it("falls back to space boundaries when no newline fits", () => {
    const chunks = chunkTelegramText("aaaa bbbb cccc", 11)
    expect(chunks).toEqual(["aaaa bbbb ", "cccc"])
  })

  it("hard-cuts when no boundary exists in the window", () => {
    const chunks = chunkTelegramText("x".repeat(25), 10)
    expect(chunks).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)])
  })

  it("every chunk respects the limit and no content is lost", () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n")
    const chunks = chunkTelegramText(text, 100)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100)
    expect(chunks.join("")).toBe(text)
  })

  it("preserves UTF-16 surrogate pairs and boundary whitespace", () => {
    const text = "abc😀   xyz\n\nend"
    const chunks = chunkTelegramText(text, 4)
    expect(chunks.join("")).toBe(text)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4)
      expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/u)
      expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]/u)
    }
  })

  it("defaults to the Telegram 4096 text limit", () => {
    expect(TELEGRAM_TEXT_LIMIT).toBe(4096)
    expect(TELEGRAM_CAPTION_LIMIT).toBe(1024)
    const chunks = chunkTelegramText("a".repeat(5000))
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toHaveLength(4096)
  })
})
