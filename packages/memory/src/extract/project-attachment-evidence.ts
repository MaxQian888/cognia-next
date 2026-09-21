/** Durable attachment citations shared by mining, persistence, and revalidation. */
export interface ProjectAttachmentEvidenceSource {
  messageId: string
  partIndex: number
  attachmentId: string
  contentHash: string
  segmentId: string
  /** JSON serialization of the extraction pipeline's structured locator. */
  locator: string
  /** Exact UTF-16 interval in the extracted segment, before memory redaction. */
  start: number
  end: number
}

export function attachmentEvidenceSourceId(source: ProjectAttachmentEvidenceSource): string {
  return `attachment:${JSON.stringify([
    source.messageId,
    source.partIndex,
    source.attachmentId,
    source.contentHash,
    source.segmentId,
    source.locator,
    source.start,
    source.end,
  ])}`
}

export function parseAttachmentEvidenceSourceId(
  value: string
): ProjectAttachmentEvidenceSource | undefined {
  if (!value.startsWith("attachment:")) return undefined
  try {
    const fields: unknown = JSON.parse(value.slice("attachment:".length))
    if (!Array.isArray(fields) || fields.length !== 8) return undefined
    const [messageId, partIndex, attachmentId, contentHash, segmentId, locator, start, end] = fields
    if (
      ![messageId, attachmentId, contentHash, segmentId, locator].every(
        (item) => typeof item === "string" && item.length > 0
      )
    )
      return undefined
    if (
      ![partIndex, start, end].every((item) => Number.isSafeInteger(item) && item >= 0) ||
      end <= start
    )
      return undefined
    return { messageId, partIndex, attachmentId, contentHash, segmentId, locator, start, end }
  } catch {
    return undefined
  }
}
