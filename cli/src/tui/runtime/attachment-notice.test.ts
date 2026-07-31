/**
 * @jest-environment node
 */
import { formatAttachmentNotice } from "./attachment-notice"
import type { AttachmentSummary } from "../../agent/session-runner"

const summary = (over: Partial<AttachmentSummary>): AttachmentSummary => ({
  imageCount: 0,
  documentCount: 0,
  injectedFiles: [],
  ocr: [],
  failed: [],
  skipped: [],
  ...over,
})

describe("formatAttachmentNotice", () => {
  it("returns null when nothing happened", () => {
    expect(formatAttachmentNotice(summary({}))).toBeNull()
  })

  it("lists images, PDFs, inlined files and pluralises", () => {
    expect(
      formatAttachmentNotice(summary({ imageCount: 2, documentCount: 1, injectedFiles: ["a.md"] }))
    ).toBe("📎 2 images · 1 PDF · 1 file inlined")
  })

  it("excludes OCR'd refs from the inlined count and reports OCR separately", () => {
    expect(
      formatAttachmentNotice(summary({ injectedFiles: ["scan.pdf", "a.md"], ocr: ["scan.pdf"] }))
    ).toBe("📎 1 file inlined · 1 OCR'd")
  })

  it("reports unreadable and ignored refs", () => {
    expect(formatAttachmentNotice(summary({ failed: ["bad.png"], skipped: ["x.zip"] }))).toBe(
      "📎 could not read: bad.png · ignored: x.zip"
    )
  })
})
