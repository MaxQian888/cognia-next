import {
  compactMemoryText,
  MAX_KEEP_TOKENS,
  MAX_SUMMARY_BYTES,
  mineKeepTokens,
  summaryLine,
  truncateUtf8,
} from "./compaction"

const bytes = (text: string) => new TextEncoder().encode(text).length
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe("truncateUtf8", () => {
  it("returns text within budget unchanged", () => {
    expect(truncateUtf8("hello", 5)).toBe("hello")
    expect(truncateUtf8("", 0)).toBe("")
  })

  it("cuts on a character boundary, trims trailing space, and appends an ellipsis", () => {
    // budget = 9 - 3 (ellipsis) = 6 → "hello " → trimEnd → "hello"
    expect(truncateUtf8("hello world", 9)).toBe("hello…")
  })

  it("never exceeds the byte budget for multi-byte characters", () => {
    const out = truncateUtf8("中文中文中文", 10)
    // budget 7 → two 3-byte chars
    expect(out).toBe("中文…")
    expect(bytes(out)).toBeLessThanOrEqual(10)
  })

  it("never splits a surrogate pair", () => {
    const out = truncateUtf8("😀😀😀😀", 10)
    // budget 7 → one 4-byte emoji
    expect(out).toBe("😀…")
    expect(LONE_SURROGATE.test(out)).toBe(false)
  })

  it("cuts without an ellipsis when the budget cannot hold one", () => {
    expect(truncateUtf8("abcdef", 2)).toBe("ab")
    expect(truncateUtf8("中文", 2)).toBe("")
  })
})

describe("mineKeepTokens", () => {
  it("returns tokens in priority-class order, not text order", () => {
    const text =
      "Call fooBar with API_KEY then `pnpm build`; got HTTP 404 and E0433 in src/lib/util.ts, see https://example.com/docs"
    expect(mineKeepTokens(text)).toEqual([
      "https://example.com/docs",
      "src/lib/util.ts",
      "util.ts",
      "E0433",
      "HTTP 404",
      "pnpm build",
      "API_KEY",
      "fooBar",
    ])
  })

  it("captures snake_case and camelCase identifiers", () => {
    expect(mineKeepTokens("use snake_case_name and camelCaseName")).toEqual([
      "snake_case_name",
      "camelCaseName",
    ])
  })

  it("recognises bare filenames with known extensions only", () => {
    expect(mineKeepTokens("edit Cargo.toml and README.md, not photo.jpeg")).toEqual([
      "Cargo.toml",
      "README.md",
    ])
  })

  it("dedupes within and across classes (first occurrence wins)", () => {
    const tokens = mineKeepTokens("open `config.json` then config.json again; config.json")
    expect(tokens).toEqual(["config.json"])
  })

  it("strips edge punctuation", () => {
    expect(mineKeepTokens("see https://example.com/a.")).toEqual(["https://example.com/a"])
    expect(mineKeepTokens('quote "`(wrapped)`"')).toEqual(["wrapped"])
  })

  it("drops tokens shorter than 2 bytes or longer than 128 bytes", () => {
    expect(mineKeepTokens("inline `x` code")).toEqual([])
    const longUrl = `https://example.com/${"a".repeat(200)}`
    expect(mineKeepTokens(longUrl)).toEqual([])
  })

  it(`caps the list at ${MAX_KEEP_TOKENS}`, () => {
    const text = Array.from({ length: 60 }, (_, i) => `var_${i}`).join(" ")
    const tokens = mineKeepTokens(text)
    expect(tokens).toHaveLength(MAX_KEEP_TOKENS)
    expect(tokens[0]).toBe("var_0")
    expect(tokens[MAX_KEEP_TOKENS - 1]).toBe(`var_${MAX_KEEP_TOKENS - 1}`)
  })

  it("keeps high-priority classes when the cap is hit", () => {
    const identifiers = Array.from({ length: 60 }, (_, i) => `id_${i}`).join(" ")
    const tokens = mineKeepTokens(`${identifiers} https://example.com/x`)
    expect(tokens[0]).toBe("https://example.com/x")
    expect(tokens).toHaveLength(MAX_KEEP_TOKENS)
  })

  it("is stable across repeated calls (global regex state reset)", () => {
    const text = "fix src/a.ts and E0001"
    expect(mineKeepTokens(text)).toEqual(mineKeepTokens(text))
  })

  it("returns [] for plain prose", () => {
    expect(mineKeepTokens("we had lunch and talked about the weather")).toEqual([])
  })
})

describe("summaryLine", () => {
  it("takes the first non-heading paragraph and collapses whitespace", () => {
    const text = "# Title\n\n## Sub\n\n  First   paragraph\n  continues here  \n\nSecond paragraph"
    expect(summaryLine(text)).toBe("First paragraph continues here")
  })

  it("treats a paragraph separator with trailing spaces as a break", () => {
    expect(summaryLine("one\n   \ntwo")).toBe("one")
  })

  it("returns '' when every paragraph is a heading", () => {
    expect(summaryLine("# a\n\n# b")).toBe("")
    expect(summaryLine("")).toBe("")
  })

  it(`caps at ${MAX_SUMMARY_BYTES} bytes for ASCII`, () => {
    const out = summaryLine("a".repeat(600))
    expect(bytes(out)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES)
    expect(out.endsWith("…")).toBe(true)
    expect(out).toBe(`${"a".repeat(497)}…`)
  })

  it("caps on a character boundary for CJK", () => {
    const out = summaryLine("中".repeat(200))
    expect(bytes(out)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES)
    expect(out).toBe(`${"中".repeat(165)}…`)
  })

  it("caps on a character boundary for emoji", () => {
    const out = summaryLine("😀".repeat(200))
    expect(bytes(out)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES)
    expect(LONE_SURROGATE.test(out)).toBe(false)
    expect(out).toBe(`${"😀".repeat(124)}…`)
  })

  it("leaves a short paragraph intact", () => {
    expect(summaryLine("short")).toBe("short")
  })
})

describe("compactMemoryText", () => {
  it("returns null for empty or whitespace-only text", () => {
    expect(compactMemoryText("")).toBeNull()
    expect(compactMemoryText("   \n ")).toBeNull()
    expect(compactMemoryText("", { force: true })).toBeNull()
  })

  it("returns null when compaction would not shrink the text", () => {
    expect(compactMemoryText("Use pnpm for installs.")).toBeNull()
  })

  it("returns null when there is no summary, even with force", () => {
    expect(compactMemoryText("# only a heading", { force: true })).toBeNull()
  })

  it("force returns a result even when it is not shorter", () => {
    expect(compactMemoryText("Use pnpm for installs.", { force: true })).toEqual({
      text: "Use pnpm for installs.",
      summary: "Use pnpm for installs.",
      keepTokens: [],
    })
  })

  it("keeps the first paragraph and appends durable tokens from the rest", () => {
    const text = [
      "Debugged the build failure together.",
      "The long discussion wandered through many unrelated topics before landing on the root cause, which took the better part of an afternoon to track down and verify carefully.",
      "It was in `scripts/build/stage.mjs`, which threw E0433 whenever NODE_ENV was unset.",
    ].join("\n\n")
    const result = compactMemoryText(text)
    expect(result).not.toBeNull()
    expect(result!.summary).toBe("Debugged the build failure together.")
    expect(result!.keepTokens).toEqual(
      expect.arrayContaining(["scripts/build/stage.mjs", "E0433", "NODE_ENV"])
    )
    expect(result!.text).toBe(
      `Debugged the build failure together.\nRetained facts: ${result!.keepTokens
        .map((token) => `\`${token}\``)
        .join(", ")}`
    )
    expect(bytes(result!.text)).toBeLessThan(bytes(text))
  })

  it("does not repeat tokens already present in the summary", () => {
    const text = [
      "Fixed src/app/page.tsx today.",
      "Lengthy notes follow that pad the memory out well past the size of its summary so compaction is worthwhile, including the helper renderPage.",
    ].join("\n\n")
    const result = compactMemoryText(text)!
    expect(result.keepTokens).not.toContain("src/app/page.tsx")
    expect(result.keepTokens).not.toContain("page.tsx")
    expect(result.keepTokens).toContain("renderPage")
  })

  it("omits the Retained facts line when no tokens remain", () => {
    const text = `Short summary.\n\n${"plain words without identifiers ".repeat(10)}`
    const result = compactMemoryText(text)!
    expect(result.text).toBe("Short summary.")
    expect(result.keepTokens).toEqual([])
  })
})
