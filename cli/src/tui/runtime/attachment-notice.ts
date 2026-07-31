/**
 * Format the one-line "attachments" notice the chat shows after a turn whose
 * prompt referenced `@<path>` files — how each was handled (image/PDF blocks,
 * text inlined, OCR'd, unreadable, ignored). Pure + tested so the wording is
 * verified without driving a live turn. Mirrors {@link formatActiveSkillsNotice}.
 */
import type { AttachmentSummary } from "../../agent/session-runner"

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`

/**
 * One-line notice, e.g. `📎 1 image · 2 files inlined · 1 OCR'd · could not
 * read: bad.png`. Returns `null` when there is nothing to report. `injectedFiles`
 * already includes any OCR'd refs, so the inlined count excludes them to avoid
 * double-counting.
 */
export function formatAttachmentNotice(summary: AttachmentSummary): string | null {
  const parts: string[] = []
  if (summary.imageCount > 0) parts.push(plural(summary.imageCount, "image"))
  if (summary.documentCount > 0) parts.push(`${summary.documentCount} PDF`)
  const inlined = summary.injectedFiles.length - summary.ocr.length
  if (inlined > 0) parts.push(`${plural(inlined, "file")} inlined`)
  if (summary.ocr.length > 0) parts.push(`${summary.ocr.length} OCR'd`)
  if (summary.failed.length > 0) parts.push(`could not read: ${summary.failed.join(", ")}`)
  if (summary.skipped.length > 0) parts.push(`ignored: ${summary.skipped.join(", ")}`)
  if (parts.length === 0) return null
  return `📎 ${parts.join(" · ")}`
}
