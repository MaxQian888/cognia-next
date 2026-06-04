/**
 * Tests for `parseSource` dispatch.
 *
 * `parseSource` is the boundary between the ingest job runner and the
 * format-specific parsers. The document-family (markdown / pdf / docx / …)
 * goes through `lib/document/document-processor`; the importer family
 * (chat-export / email / git-repo) goes through `lib/twin/importers/*`
 * and concatenates their fan-out into one ParsedSource.
 *
 * These tests cover the path-selection logic — actual parser correctness
 * lives in each importer's own test file.
 */

import { computePdfPageMap, parseSource, type RawSource } from "@/lib/twin/ingest/parse"

describe("parseSource — document family", () => {
  it("routes markdown through the document processor", async () => {
    const raw: RawSource = {
      id: "src_md_1",
      filename: "notes.md",
      format: "markdown",
      text: "# Notes\n\nSome body.",
    }
    const parsed = await parseSource(raw)
    expect(parsed.id).toBe("src_md_1")
    expect(parsed.kind).toBe("document")
    expect(parsed.format).toBe("markdown")
    expect(parsed.originalText).toContain("Some body")
  })

  it("routes code through the document processor with kind=code", async () => {
    const raw: RawSource = {
      id: "src_code_1",
      filename: "hello.ts",
      format: "code",
      text: "export const x = 1\n",
    }
    const parsed = await parseSource(raw)
    expect(parsed.kind).toBe("code")
    expect(parsed.originalText).toContain("export const x = 1")
  })

  it("rejects text-based formats without raw.text", async () => {
    await expect(parseSource({ id: "x", filename: "x.md", format: "markdown" })).rejects.toThrow(
      /requires .text/
    )
  })
})

describe("parseSource — importer family", () => {
  it("routes mbox through the importer and concatenates fan-out", async () => {
    const mbox = `From foo@example 1
Subject: First message
From: alice@example
To: bob@example

Hello world.

From foo@example 2
Subject: Second message
From: charlie@example

Second body.
`
    const raw: RawSource = {
      id: "src_mbox_1",
      filename: "inbox.mbox",
      format: "mbox",
      text: mbox,
    }
    const parsed = await parseSource(raw)
    expect(parsed.kind).toBe("email")
    expect(parsed.format).toBe("mbox")
    // Two messages → one combined ParsedSource with separator.
    expect(parsed.originalText).toContain("First message")
    expect(parsed.originalText).toContain("Second message")
    expect(parsed.originalText).toContain("---")
  })

  it("routes eml through the importer", async () => {
    const eml = `Subject: Single eml
From: dave@example
To: erin@example

Single message body.
`
    const raw: RawSource = {
      id: "src_eml_1",
      filename: "x.eml",
      format: "eml",
      text: eml,
    }
    const parsed = await parseSource(raw)
    expect(parsed.kind).toBe("email")
    expect(parsed.format).toBe("eml")
    expect(parsed.originalText).toContain("Single message body")
  })

  it("routes chatgpt-export through the importer", async () => {
    // Minimal mapping-tree shape: one node, one message, one current_node.
    const conv = {
      title: "Test conversation",
      mapping: {
        node_1: {
          id: "node_1",
          parent: null,
          children: [],
          message: {
            id: "msg_1",
            author: { role: "user" },
            create_time: 1700000000,
            content: { content_type: "text", parts: ["Hello"] },
          },
        },
      },
      current_node: "node_1",
    }
    const raw: RawSource = {
      id: "src_chatgpt_1",
      filename: "conversations.json",
      format: "chatgpt-export",
      text: JSON.stringify([conv]),
    }
    const parsed = await parseSource(raw)
    expect(parsed.kind).toBe("chat")
    expect(parsed.format).toBe("chatgpt-export")
    expect(parsed.originalText).toContain("Hello")
  })

  it("falls back to raw text when importer produces nothing usable", async () => {
    // Malformed claude-export JSON — importer returns []; we should
    // still get back the original text so the chunker has something.
    const raw: RawSource = {
      id: "src_claude_1",
      filename: "claude.json",
      format: "claude-export",
      text: "[]",
    }
    const parsed = await parseSource(raw)
    expect(parsed.kind).toBe("chat")
    expect(parsed.originalText.length).toBeGreaterThan(0)
  })

  it("surfaces importer parse errors with a clear prefix", async () => {
    // Invalid JSON triggers the importer's JSON.parse throw which our
    // dispatch translates into a `parseSource: importer "..." failed` error.
    const raw: RawSource = {
      id: "src_bad_1",
      filename: "x.json",
      format: "chatgpt-export",
      text: "{this is not json",
    }
    await expect(parseSource(raw)).rejects.toThrow(/importer .* failed/)
  })
})

describe("computePdfPageMap", () => {
  function pdfResult(pages: Array<{ text: string; items?: object[] }>) {
    return {
      text: pages.map((p) => p.text).join("\n\n"),
      pageCount: pages.length,
      pages: pages.map((p, i) => ({
        pageNumber: i + 1,
        text: p.text,
        width: 612,
        height: 792,
        ...(p.items ? { items: p.items } : {}),
      })),
      metadata: {},
    }
  }

  const ITEM_A = { text: "alpha", x: 10, y: 20, width: 100, height: 12 }
  const ITEM_B = { text: "beta", x: 50, y: 700, width: 80, height: 14 }

  it("maps page char ranges with the embeddable prefix offset applied", () => {
    const result = pdfResult([
      { text: "page one body", items: [ITEM_A] },
      { text: "page two body", items: [ITEM_B] },
    ])
    const embeddable = `Title: Doc\n\n${result.text}`

    const map = computePdfPageMap("pdf", result, embeddable)

    expect(map).toHaveLength(2)
    const base = embeddable.indexOf(result.text)
    expect(map![0]).toMatchObject({ pageNumber: 1, charStart: base })
    expect(embeddable.slice(map![0].charStart, map![0].charEnd)).toBe("page one body")
    expect(embeddable.slice(map![1].charStart, map![1].charEnd)).toBe("page two body")
  })

  it("computes bboxUnion across a page's items", () => {
    const result = pdfResult([{ text: "body", items: [ITEM_A, ITEM_B] }])

    const map = computePdfPageMap("pdf", result, result.text)

    // Union of (10,20,100x12) and (50,700,80x14): x 10..130, y 20..714.
    expect(map![0].bboxUnion).toEqual({ x: 10, y: 20, width: 120, height: 694 })
  })

  it("omits bboxUnion for a page without items", () => {
    const result = pdfResult([{ text: "with items", items: [ITEM_A] }, { text: "without items" }])

    const map = computePdfPageMap("pdf", result, result.text)

    expect(map![0].bboxUnion).toBeDefined()
    expect(map![1].bboxUnion).toBeUndefined()
  })

  it("returns undefined when no page carries items (pdfjs path)", () => {
    const result = pdfResult([{ text: "plain" }, { text: "pages" }])
    expect(computePdfPageMap("pdf", result, result.text)).toBeUndefined()
  })

  it("returns undefined for non-pdf formats", () => {
    const result = pdfResult([{ text: "body", items: [ITEM_A] }])
    expect(computePdfPageMap("markdown", result, result.text)).toBeUndefined()
  })

  it("returns undefined when parseResult is missing or not PDF-shaped", () => {
    expect(computePdfPageMap("pdf", undefined, "text")).toBeUndefined()
    expect(computePdfPageMap("pdf", { html: "<p/>" }, "text")).toBeUndefined()
  })

  it("returns undefined when the page text cannot be located in the embeddable text", () => {
    const result = pdfResult([{ text: "needle", items: [ITEM_A] }])
    expect(computePdfPageMap("pdf", result, "completely different haystack")).toBeUndefined()
  })
})
