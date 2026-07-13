// Sanity tests for the HTML exporter. We don't try to validate the DOM in
// detail (jsdom would do that); we check that the output is syntactically
// valid-ish, theme tokens land in the inline stylesheet, and the conversation
// renders text + tool blocks.

import { exportToBeautifulHtml } from "./beautiful-html"
import { exportToAnimatedHtml } from "./animated-html"
import { THEMES } from "./syntax-themes"
import type { ChatSession, StoredMessage } from "@/lib/claude/types"

const session: ChatSession = {
  id: "s1",
  title: "<script>alert(1)</script> & friends",
  kind: "direct",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
}

const messages: StoredMessage[] = [
  {
    id: "m1",
    sessionId: "s1",
    role: "user",
    parts: [{ type: "text", text: "Hello https://example.com world" }],
    createdAt: 1_700_000_000_000,
  },
  {
    id: "m2",
    sessionId: "s1",
    role: "assistant",
    parts: [
      { type: "text", text: "Hi back" },
      {
        type: "tool-test",
        toolCallId: "t1",
        state: "output-available",
        input: { foo: "bar" },
        output: { ok: true },
      } as never,
    ],
    createdAt: 1_700_000_000_500,
  },
]

const exportedAt = new Date("2024-01-02T10:00:00Z")

describe("exportToBeautifulHtml", () => {
  it("escapes hostile characters in the title", () => {
    const html = exportToBeautifulHtml({ session, messages, exportedAt })
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).not.toContain("<script>alert(1)</script>")
  })

  it("inlines the chosen theme's tokens", () => {
    const html = exportToBeautifulHtml({ session, messages, exportedAt, theme: "dracula" })
    expect(html).toContain(THEMES.dracula.bg)
    expect(html).toContain(THEMES.dracula.accent)
  })

  it("supports an inline custom theme", () => {
    const html = exportToBeautifulHtml({
      session,
      messages,
      exportedAt,
      customTheme: { ...THEMES.light, accent: "#ff00ff" },
    })
    expect(html).toContain("#ff00ff")
  })

  it("linkifies plain http URLs in text parts", () => {
    const html = exportToBeautifulHtml({ session, messages, exportedAt })
    expect(html).toContain('<a href="https://example.com"')
  })

  it("renders tool calls into a <details> block", () => {
    const html = exportToBeautifulHtml({ session, messages, exportedAt })
    expect(html).toContain("<details")
    expect(html).toContain("🔧")
    expect(html).toContain("test")
  })

  it("respects includeTimestamps=false", () => {
    const html = exportToBeautifulHtml({
      session,
      messages,
      exportedAt,
      includeTimestamps: false,
    })
    expect(html).not.toContain("<time>")
  })
})

describe("exportToBeautifulHtml — style presets", () => {
  it("injects the arknights banner, footer tag, and preset CSS", () => {
    const html = exportToBeautifulHtml({ session, messages, exportedAt, theme: "arknights" })
    expect(html).toContain('class="preset-banner">TACTICAL COMMUNICATION LOG')
    expect(html).toContain("PRTS // RECORD SEALED")
    expect(html).toContain(".preset-banner")
    expect(html).toContain(THEMES.arknights.accent)
  })

  it("every theme now ships preset chrome (light renders its banner)", () => {
    const html = exportToBeautifulHtml({ session, messages, exportedAt, theme: "light" })
    expect(html).toContain('class="preset-banner">CONVERSATION')
    expect(html).toContain("Exported with Cognia")
  })

  it("renders the new immersive theme banners", () => {
    const gen = exportToBeautifulHtml({ session, messages, exportedAt, theme: "genshin" })
    expect(gen).toContain("TEYVAT ADVENTURE LOG")
    const hk = exportToBeautifulHtml({ session, messages, exportedAt, theme: "honkai" })
    expect(hk).toContain("ASTRAL EXPRESS LOG")
  })

  it("preset CSS uses custom tokens when a custom theme overrides a styled base", () => {
    const html = exportToBeautifulHtml({
      session,
      messages,
      exportedAt,
      theme: "arknights",
      customTheme: { ...THEMES.arknights, accent: "#123456" },
    })
    expect(html).toContain("#123456")
    expect(html).toContain("preset-banner")
  })

  it("sakura preset has a banner but no footer tagline", () => {
    const html = exportToBeautifulHtml({ session, messages, exportedAt, theme: "sakura" })
    expect(html).toContain("HANAMI LOG")
    expect(html).toMatch(/Exported from Cognia · [^·]*<\/footer>/)
  })
})

describe("exportToBeautifulHtml — theme wallpaper backdrop", () => {
  const dataUrl = "data:image/webp;base64,QUJD"

  it("inlines the wallpaper with a scrim and transparent body when provided", () => {
    const html = exportToBeautifulHtml({
      session,
      messages,
      exportedAt,
      theme: "arknights",
      wallpaperDataUrl: dataUrl,
    })
    expect(html).toContain(`url("${dataUrl}")`)
    expect(html).toContain("background-color: transparent")
    expect(html).toContain("linear-gradient(rgba(")
  })

  it("renders no backdrop when no wallpaper is provided", () => {
    const html = exportToBeautifulHtml({ session, messages, exportedAt, theme: "arknights" })
    expect(html).not.toContain("data:image/webp")
    expect(html).not.toContain("background-color: transparent")
  })
})

describe("exportToAnimatedHtml", () => {
  it("inherits the wallpaper backdrop from the base export", () => {
    const html = exportToAnimatedHtml({
      session,
      messages,
      exportedAt,
      theme: "aurora",
      wallpaperDataUrl: "data:image/webp;base64,WFla",
    })
    expect(html).toContain("data:image/webp;base64,WFla")
    expect(html).toContain("classList.add('show')")
  })

  it("keeps the preset chrome from the base export", () => {
    const html = exportToAnimatedHtml({ session, messages, exportedAt, theme: "arknights" })
    expect(html).toContain("preset-banner")
    expect(html).toContain("classList.add('show')")
  })

  it("includes the animation script", () => {
    const html = exportToAnimatedHtml({ session, messages, exportedAt })
    expect(html).toContain("<script>")
    expect(html).toContain("classList.add('show')")
  })

  it("uses a custom typingSpeedMs value", () => {
    const html = exportToAnimatedHtml({ session, messages, exportedAt, typingSpeedMs: 33 })
    expect(html).toContain("setTimeout(r, 33)")
  })
})

describe("exportToBeautifulHtml — additional rendering branches", () => {
  it("collapses metadata when includeMetadata=false (renderHeader short path)", () => {
    const html = exportToBeautifulHtml({
      session,
      messages,
      exportedAt,
      includeMetadata: false,
    })
    expect(html).toContain("<header><h1>")
    // No metadata <dl> when the flag is off.
    expect(html).not.toContain('<dl class="meta">')
  })

  it('renders reasoning parts in a <details class="reasoning"> block', () => {
    const html = exportToBeautifulHtml({
      session,
      messages: [
        {
          id: "r1",
          sessionId: "s1",
          role: "assistant",
          parts: [{ type: "reasoning", text: "let me think..." } as never],
          createdAt: 1_700_000_000_000,
        },
      ],
      exportedAt,
    })
    expect(html).toContain("💭 Thinking")
    expect(html).toContain("let me think...")
  })

  it("renders file parts with and without a download URL", () => {
    const html = exportToBeautifulHtml({
      session,
      messages: [
        {
          id: "f1",
          sessionId: "s1",
          role: "user",
          parts: [
            { type: "file", url: "https://files/x.png", filename: "x.png" } as never,
            { type: "file", filename: "noLink.txt" } as never,
          ],
          createdAt: 1_700_000_000_000,
        },
      ],
      exportedAt,
    })
    expect(html).toContain('href="https://files/x.png"')
    expect(html).toContain("noLink.txt")
  })

  it("renders source-url parts as plain anchor links", () => {
    const html = exportToBeautifulHtml({
      session,
      messages: [
        {
          id: "u1",
          sessionId: "s1",
          role: "assistant",
          parts: [
            { type: "source-url", url: "https://docs/example", title: "Example" } as never,
            { type: "source-url", url: "https://no-title.example" } as never,
          ],
          createdAt: 1_700_000_000_000,
        },
      ],
      exportedAt,
    })
    expect(html).toContain('href="https://docs/example"')
    expect(html).toContain("Example")
    expect(html).toContain("https://no-title.example")
  })

  it("returns an empty string for unknown part types", () => {
    const html = exportToBeautifulHtml({
      session,
      messages: [
        {
          id: "u2",
          sessionId: "s1",
          role: "user",
          parts: [{ type: "unknown-type" } as never],
          createdAt: 1_700_000_000_000,
        },
      ],
      exportedAt,
    })
    // No tool blocks / no text divs from this part.
    expect(html).toContain('class="parts">')
  })

  it("formats system role with the gear emoji and falls back for custom roles", () => {
    const html = exportToBeautifulHtml({
      session,
      messages: [
        {
          id: "sys",
          sessionId: "s1",
          role: "system",
          parts: [{ type: "text", text: "x" }],
          createdAt: 1_700_000_000_000,
        },
        {
          id: "weird",
          sessionId: "s1",
          role: "tool" as never,
          parts: [{ type: "text", text: "y" }],
          createdAt: 1_700_000_000_000,
        },
      ],
      exportedAt,
    })
    expect(html).toContain("⚙️ System")
    expect(html).toContain(">tool<")
  })

  it("renders tool errorText when the tool call failed", () => {
    const html = exportToBeautifulHtml({
      session,
      messages: [
        {
          id: "te",
          sessionId: "s1",
          role: "assistant",
          parts: [
            {
              type: "tool-broken",
              toolCallId: "t-err",
              state: "output-error",
              errorText: "boom",
            } as never,
          ],
          createdAt: 1_700_000_000_000,
        },
      ],
      exportedAt,
    })
    expect(html).toContain("boom")
    expect(html).toContain("❌")
  })

  it("renders dynamic-tool parts with the generic 'tool' label", () => {
    const html = exportToBeautifulHtml({
      session,
      messages: [
        {
          id: "dt",
          sessionId: "s1",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolCallId: "t-d",
              state: "output-available",
              input: { x: 1 },
              output: "raw string output",
            } as never,
          ],
          createdAt: 1_700_000_000_000,
        },
      ],
      exportedAt,
    })
    expect(html).toContain("🔧 tool")
    expect(html).toContain("raw string output")
  })

  it("falls back to String() in safeJson when value is non-serializable", () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    const html = exportToBeautifulHtml({
      session,
      messages: [
        {
          id: "cy",
          sessionId: "s1",
          role: "assistant",
          parts: [
            {
              type: "tool-cyclic",
              toolCallId: "t-c",
              state: "output-available",
              input: cyclic,
            } as never,
          ],
          createdAt: 1_700_000_000_000,
        },
      ],
      exportedAt,
    })
    // safeJson catch returns String(value) → "[object Object]".
    expect(html).toContain("[object Object]")
  })
})
