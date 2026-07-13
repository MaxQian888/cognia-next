import { renderQuoteCardFragment, buildQuoteCardHtml, inlineMarkdown } from "./quote-card"
import { THEMES } from "./syntax-themes"

const base = {
  role: "assistant" as const,
  text: "Hello world",
  timestamp: new Date("2026-01-10T12:00:00Z"),
}

describe("renderQuoteCardFragment", () => {
  it("renders a themed card with author, model and timestamp", () => {
    const frag = renderQuoteCardFragment({
      ...base,
      authorName: "Amiya",
      model: "opus",
      theme: "arknights",
    })
    expect(frag).toContain('class="qcard"')
    expect(frag).toContain('data-theme="arknights"')
    expect(frag).toContain('data-role="assistant"')
    expect(frag).toContain("Amiya")
    expect(frag).toContain("opus")
    expect(frag).toContain("Hello world")
    // arknights preset banner is reused as the card banner.
    expect(frag).toContain("TACTICAL COMMUNICATION LOG")
    expect(frag).toContain(THEMES.arknights.accent)
  })

  it("falls back to a role label + glyph for every role", () => {
    expect(renderQuoteCardFragment({ ...base, role: "user" })).toContain("You")
    expect(renderQuoteCardFragment({ ...base, role: "assistant" })).toContain("Assistant")
    const sys = renderQuoteCardFragment({ ...base, role: "system" })
    expect(sys).toContain("System")
    expect(sys).toContain("⚙️")
    // Unknown role → generic glyph + raw role as the label.
    const other = renderQuoteCardFragment({ ...base, role: "tool" })
    expect(other).toContain("💬")
    expect(other).toContain(">tool<")
  })

  it("omits the model segment when none is given", () => {
    const frag = renderQuoteCardFragment({ ...base, role: "user" })
    expect(frag).not.toContain(" · opus")
  })

  it("linkifies plain URLs in the quoted text", () => {
    const frag = renderQuoteCardFragment({ ...base, text: "see https://example.com now" })
    expect(frag).toContain('<a href="https://example.com"')
  })

  it("renders across the flagship and immersive presets without throwing", () => {
    for (const theme of [
      "cyberpunk",
      "terminal",
      "sakura",
      "aurora",
      "genshin",
      "honkai",
      "light",
    ] as const) {
      const frag = renderQuoteCardFragment({ ...base, theme })
      expect(frag).toContain(`data-theme="${theme}"`)
    }
  })

  it("escapes hostile message text (no script injection)", () => {
    const frag = renderQuoteCardFragment({
      ...base,
      text: "<script>alert(1)</script>",
    })
    expect(frag).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(frag).not.toContain("<script>alert(1)</script>")
  })

  it("inlines a wallpaper backdrop when provided", () => {
    const url = "data:image/webp;base64,QUJD"
    const frag = renderQuoteCardFragment({ ...base, theme: "honkai", wallpaperDataUrl: url })
    expect(frag).toContain(".ucard, .qcard")
    expect(frag).toContain(`url("${url}")`)
  })

  it("shows the session title in the footer", () => {
    const frag = renderQuoteCardFragment({ ...base, sessionTitle: "My chat" })
    expect(frag).toContain("My chat")
    expect(frag).toContain("Shared via Cognia")
  })
})

describe("buildQuoteCardHtml", () => {
  it("wraps the fragment in a self-contained document", () => {
    const html = buildQuoteCardHtml({ ...base, sessionTitle: "T", theme: "light" })
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true)
    expect(html).toContain('class="qcard"')
    expect(html).toContain(THEMES.light.bg)
  })
})

describe("inlineMarkdown", () => {
  it("formats bold, italic and code on already-escaped text", () => {
    expect(inlineMarkdown("a **b** c")).toBe("a <strong>b</strong> c")
    expect(inlineMarkdown("a *b* c")).toBe("a <em>b</em> c")
    expect(inlineMarkdown("run `npm i` now")).toBe("run <code>npm i</code> now")
    expect(inlineMarkdown("a __b__ c")).toBe("a <strong>b</strong> c")
  })

  it("does not treat escaped angle brackets as markup", () => {
    // Input is pre-escaped; there are no raw tags to reopen.
    expect(inlineMarkdown("&lt;b&gt;")).toBe("&lt;b&gt;")
  })
})
