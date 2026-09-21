import { formatAttachmentLocator, readAttachmentExtractedContent } from "./attachment"

const content = {
  attachmentId: "file-1",
  contentHash: "a".repeat(64),
  status: "ready",
  processor: { id: "pdf", version: "2" },
  segments: [{ id: "page-1", text: "A source statement", locator: { type: "page", page: 1 } }],
}

describe("attachment source contract", () => {
  it("preserves validated source identity and locators", () => {
    expect(readAttachmentExtractedContent(content)).toBe(content)
    expect(formatAttachmentLocator({ type: "time", startSec: 4, endSec: 8 })).toBe("4s–8s")
  })
  it.each([
    { contentHash: "filename.pdf" },
    { attachmentId: "" },
    { processor: {} },
    { coverage: { processed: 5, total: 2, unit: "pages" } },
    { segments: [...content.segments, ...content.segments] },
    { segments: [{ id: "bad", text: "a", locator: { type: "time", startSec: 8, endSec: 4 } }] },
    { segments: [{ id: "bad", text: "a", locator: { type: "page", page: 0 } }] },
  ])("rejects malformed evidence %j", (patch) => {
    expect(readAttachmentExtractedContent({ ...content, ...patch })).toBeNull()
  })
})
