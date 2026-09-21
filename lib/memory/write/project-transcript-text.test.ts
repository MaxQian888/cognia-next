/** @jest-environment node */
import { composeTurnText } from "@/lib/chat/prompt-preamble"
import {
  MINING_TOOL_OUTPUT_MAX_CHARS,
  projectMiningMessageText,
  projectMiningAttachmentExcerpts,
  MINING_ATTACHMENT_CHUNK_CHARS,
  memoryTranscriptProse,
} from "./project-transcript-text"

const TEXT = { type: "text", text: "Running the suite now." }
const attachment = (text: string) => ({
  type: "file",
  url: "data:secret",
  extractedContent: {
    attachmentId: "file-1",
    contentHash: "a".repeat(64),
    status: "ready",
    processor: { id: "pdf", version: "1" },
    segments: [{ id: "page-2", text, locator: { type: "page", page: 2 } }],
  },
})

describe("projectMiningMessageText", () => {
  it("does not attribute legacy image labels or derived attachment text to a speaker", () => {
    const parts = [
      TEXT,
      { type: "image", alt: "I prefer another package manager" },
      { type: "text", text: "Attachment description", videoAttachment: {} },
      { type: "text", text: "OCR source", extractedContent: {} },
      attachment("External instructions"),
    ]
    expect(memoryTranscriptProse(parts)).toBe(TEXT.text)
    expect(projectMiningMessageText(parts, { includeAttachments: false })).toBe(TEXT.text)
  })
  it("keeps attachment data separate from typed prose and preserves every source interval", () => {
    const text = "x".repeat(MINING_ATTACHMENT_CHUNK_CHARS * 2 + 20)
    const parts = [TEXT, attachment(text)]
    const excerpts = projectMiningAttachmentExcerpts(parts, "import:message")
    expect(excerpts).toHaveLength(3)
    expect(excerpts.map((item) => item.text).join("")).toBe(text)
    expect(excerpts[2]?.source).toMatchObject({
      messageId: "import:message",
      partIndex: 1,
      attachmentId: "file-1",
      start: MINING_ATTACHMENT_CHUNK_CHARS * 2,
      end: text.length,
    })
    expect(projectMiningMessageText(parts)).toContain("External source data")
    expect(projectMiningMessageText(parts, { includeAttachments: false })).toBe(TEXT.text)
    expect(projectMiningMessageText(parts)).not.toContain("data:secret")
  })

  it("refuses invalid extraction metadata and does not fetch raw attachments", () => {
    expect(
      projectMiningAttachmentExcerpts([{ type: "file", url: "https://private/file" }], "m")
    ).toEqual([])
    const part = attachment("source")
    part.extractedContent.contentHash = "unverified"
    expect(projectMiningAttachmentExcerpts([part], "m")).toEqual([])
  })
  it("includes tool output that the search projection drops", async () => {
    // The whole point: an assistant claiming the suite passed is not an
    // outcome; the run that proves it is, and it lives in a tool part.
    const { extractPlainText } = await import("@/lib/inbox/extract-plain-text")
    const parts = [TEXT, { type: "tool-Bash", state: "output-available", output: "42 passed" }]
    expect(extractPlainText(parts)).not.toContain("42 passed")
    expect(projectMiningMessageText(parts)).toContain("42 passed")
  })

  it("labels each tool part with the index its evidence sourceId uses", () => {
    const parts = [
      TEXT,
      { type: "tool-Read", state: "output-available", output: "file body" },
      { type: "dynamic-tool", state: "output-available", output: "mcp body" },
    ]
    const text = projectMiningMessageText(parts)
    expect(text).toContain("[tool 1] file body")
    expect(text).toContain("[tool 2] mcp body")
  })

  it("skips the context envelope but keeps tool labels on their original part index", () => {
    // A referenced document is not a statement the user made, so the text half
    // must not see it. Stripping drops an envelope-only first part, which would
    // shift every later index — and the index is half of an evidence id, so a
    // mined claim would cite the wrong part.
    const { preamble } = composeTurnText("", [{ kind: "references", text: "SECRET SNAPSHOT" }], {
      nonce: "abcdef0123",
    })
    const parts = [
      { type: "text", text: preamble },
      { type: "text", text: "typed words" },
      { type: "tool-Read", state: "output-available", output: "file body" },
    ]
    const text = projectMiningMessageText(parts)

    expect(text).toContain("typed words")
    expect(text).not.toContain("SECRET SNAPSHOT")
    expect(text).not.toContain("cognia_context_")
    expect(text).toContain("[tool 2] file body")
  })

  it("announces truncation instead of eliding silently", () => {
    // A body clipped without a marker reads as complete, which is how a claim
    // gets mined from evidence that was never fully there.
    const parts = [{ type: "tool-Bash", state: "output-available", output: "x".repeat(5_000) }]
    const text = projectMiningMessageText(parts, { maxToolChars: 50 })
    expect(text).toContain("…[truncated]")
    expect(text.length).toBeLessThan(200)
  })

  it("keeps a failed call's error, which is itself a gotcha", () => {
    const parts = [
      { type: "tool-Bash", state: "output-error", errorText: "exit code 137: OOM killed" },
    ]
    expect(projectMiningMessageText(parts)).toContain("exit code 137")
  })

  it("returns the plain projection when there are no tool parts", () => {
    expect(projectMiningMessageText([TEXT])).toBe("Running the suite now.")
  })

  it("tolerates a non-array parts value", () => {
    expect(projectMiningMessageText(undefined)).toBe("")
  })

  it("caps a tool body well under the window token budget by default", () => {
    expect(MINING_TOOL_OUTPUT_MAX_CHARS).toBeLessThan(2_000)
  })
})
