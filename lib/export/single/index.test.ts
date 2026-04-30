jest.mock("@/lib/export/text/rich-markdown", () => ({
  exportToRichMarkdown: jest.fn(() => "MD"),
  exportToRichJSON: jest.fn(() => "JSON"),
  exportToPlainText: jest.fn(() => "TXT"),
}))
jest.mock("@/lib/export/html/beautiful-html", () => ({
  exportToBeautifulHtml: jest.fn(() => "<html>BEAUTIFUL</html>"),
}))
jest.mock("@/lib/export/html/animated-html", () => ({
  exportToAnimatedHtml: jest.fn(() => "<html>ANIMATED</html>"),
}))

import { renderSingleExport } from "./index"
import type { ChatSession, StoredMessage } from "@/lib/claude/types"
import * as md from "@/lib/export/text/rich-markdown"
import * as bh from "@/lib/export/html/beautiful-html"
import * as ah from "@/lib/export/html/animated-html"

const session: ChatSession = {
  id: "s",
  title: "My Conversation: With/Symbols!",
} as unknown as ChatSession
const messages: StoredMessage[] = []
const date = new Date("2024-01-01T00:00:00Z")

describe("renderSingleExport", () => {
  it("renders markdown with slug-derived filename", () => {
    const out = renderSingleExport({
      format: "markdown",
      session,
      messages,
      exportedAt: date,
    })
    expect(out.content).toBe("MD")
    expect(out.filename).toBe("my-conversation-with-symbols.md")
    expect(out.mimeType).toBe("text/markdown")
    expect(md.exportToRichMarkdown).toHaveBeenCalled()
  })

  it("renders JSON", () => {
    const out = renderSingleExport({
      format: "json",
      session,
      messages,
      exportedAt: date,
    })
    expect(out.content).toBe("JSON")
    expect(out.filename.endsWith(".json")).toBe(true)
    expect(out.mimeType).toBe("application/json")
  })

  it("renders plain text", () => {
    const out = renderSingleExport({
      format: "text",
      session,
      messages,
      exportedAt: date,
    })
    expect(out.content).toBe("TXT")
    expect(out.filename.endsWith(".txt")).toBe(true)
    expect(out.mimeType).toBe("text/plain")
  })

  it("renders HTML and forwards theme/customTheme/metadata flags", () => {
    const out = renderSingleExport({
      format: "html",
      session,
      messages,
      exportedAt: date,
      theme: "dark",
      includeMetadata: true,
      includeTimestamps: false,
    })
    expect(out.content).toBe("<html>BEAUTIFUL</html>")
    expect(out.filename.endsWith(".html")).toBe(true)
    expect(out.mimeType).toBe("text/html")
    expect(bh.exportToBeautifulHtml).toHaveBeenCalledWith(
      expect.objectContaining({
        session,
        theme: "dark",
        includeMetadata: true,
        includeTimestamps: false,
      })
    )
  })

  it("renders animated HTML with .animated.html suffix", () => {
    const out = renderSingleExport({
      format: "animated",
      session,
      messages,
      exportedAt: date,
    })
    expect(out.content).toBe("<html>ANIMATED</html>")
    expect(out.filename.endsWith(".animated.html")).toBe(true)
    expect(out.mimeType).toBe("text/html")
    expect(ah.exportToAnimatedHtml).toHaveBeenCalled()
  })

  it("falls back to 'conversation' slug when title produces empty slug", () => {
    const out = renderSingleExport({
      format: "markdown",
      session: { id: "x", title: "..." } as unknown as ChatSession,
      messages,
      exportedAt: date,
    })
    expect(out.filename).toBe("conversation.md")
  })

  it("uses Date.now()-based exportedAt when omitted", () => {
    const out = renderSingleExport({
      format: "markdown",
      session,
      messages,
    })
    expect(out.content).toBe("MD")
  })

  it("trims slugs longer than 60 chars", () => {
    const long = "X".repeat(80)
    const out = renderSingleExport({
      format: "json",
      session: { id: "x", title: long } as unknown as ChatSession,
      messages,
    })
    // .slice(0, 60) yields 60 'x' chars
    expect(out.filename).toBe(`${"x".repeat(60)}.json`)
  })
})
