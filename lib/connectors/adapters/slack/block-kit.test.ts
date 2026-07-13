import {
  clampBlocks,
  escapeSlackMrkdwn,
  MAX_BLOCKS_PER_MESSAGE,
  segmentToBlock,
  segmentsToBlocks,
} from "./block-kit"
import type { MessageSegment } from "@/types/connectors/segment"

describe("escapeSlackMrkdwn", () => {
  it("escapes & to &amp;", () => {
    expect(escapeSlackMrkdwn("a & b")).toBe("a &amp; b")
  })

  it("escapes < to &lt;", () => {
    expect(escapeSlackMrkdwn("a < b")).toBe("a &lt; b")
  })

  it("escapes > to &gt;", () => {
    expect(escapeSlackMrkdwn("a > b")).toBe("a &gt; b")
  })

  it("escapes all three in one string", () => {
    expect(escapeSlackMrkdwn("<foo & bar>")).toBe("&lt;foo &amp; bar&gt;")
  })

  it("does not escape * _ ` ~ (mrkdwn formatting)", () => {
    expect(escapeSlackMrkdwn("*bold* _italic_ `code`")).toBe("*bold* _italic_ `code`")
  })

  it("returns empty string unchanged", () => {
    expect(escapeSlackMrkdwn("")).toBe("")
  })
})

describe("segmentToBlock", () => {
  it("text segment → section with escaped mrkdwn", () => {
    const seg: MessageSegment = { type: "text", text: "hello <world>" }
    const block = segmentToBlock(seg)
    expect(block).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "hello &lt;world&gt;" },
    })
  })

  it("markdown segment → section with mrkdwn", () => {
    const seg: MessageSegment = { type: "markdown", md: "**bold** text" }
    const block = segmentToBlock(seg)
    expect(block).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "**bold** text" },
    })
  })

  it("image segment → image block with image_url and alt_text", () => {
    const seg: MessageSegment = { type: "image", url: "https://example.com/img.png", alt: "a pic" }
    const block = segmentToBlock(seg)
    expect(block).toEqual({
      type: "image",
      image_url: "https://example.com/img.png",
      alt_text: "a pic",
    })
  })

  it("image segment without alt defaults alt_text to 'image'", () => {
    const seg: MessageSegment = { type: "image", url: "https://example.com/img.png" }
    const block = segmentToBlock(seg)
    expect(block).toMatchObject({ type: "image", alt_text: "image" })
  })

  it("code segment → section with triple-backtick wrapper (no lang)", () => {
    const seg: MessageSegment = { type: "code", code: "console.log(1)" }
    const block = segmentToBlock(seg)
    expect(block).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "```\nconsole.log(1)\n```" },
    })
  })

  it("code segment with language includes lang in fence", () => {
    const seg: MessageSegment = { type: "code", language: "typescript", code: "const x = 1" }
    const block = segmentToBlock(seg)
    expect(block).toMatchObject({
      type: "section",
      text: { type: "mrkdwn", text: "```typescript\nconst x = 1\n```" },
    })
  })

  it("mention segment → section with <@userId>", () => {
    const seg: MessageSegment = { type: "mention", userId: "U123" }
    const block = segmentToBlock(seg)
    expect(block).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "<@U123>" },
    })
  })

  it("card segment → section with [card] placeholder", () => {
    const seg: MessageSegment = { type: "card", card: { kind: "test", payload: {} } }
    const block = segmentToBlock(seg)
    expect(block).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "[card]" },
    })
  })

  it("reply segment → null (dropped in Phase 1)", () => {
    const seg: MessageSegment = { type: "reply", messageId: "ts-123", snippet: "..." }
    expect(segmentToBlock(seg)).toBeNull()
  })

  it("voice segment → null (dropped in Phase 1)", () => {
    const seg: MessageSegment = { type: "voice", url: "https://example.com/v.ogg" }
    expect(segmentToBlock(seg)).toBeNull()
  })
})

describe("segmentsToBlocks", () => {
  it("converts mixed segments dropping nulls", () => {
    const segments: MessageSegment[] = [
      { type: "text", text: "hello" },
      { type: "reply", messageId: "x", snippet: "..." },
      { type: "image", url: "https://example.com/img.png" },
    ]
    const blocks = segmentsToBlocks(segments)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].type).toBe("section")
    expect(blocks[1].type).toBe("image")
  })

  it("returns empty array for empty input", () => {
    expect(segmentsToBlocks([])).toEqual([])
  })
})

describe("clampBlocks", () => {
  it("truncates to Slack's 50-blocks-per-message cap", () => {
    const blocks = Array.from({ length: 60 }, (_, i) => ({ i }))
    expect(clampBlocks(blocks)).toHaveLength(MAX_BLOCKS_PER_MESSAGE)
  })

  it("leaves lists at or under the cap untouched", () => {
    const blocks = Array.from({ length: 50 }, (_, i) => ({ i }))
    expect(clampBlocks(blocks)).toBe(blocks)
  })
})
