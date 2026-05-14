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

import { parseSource, type RawSource } from "@/lib/twin/ingest/parse"

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
