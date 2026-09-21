/** Source-located attachment text. File content is evidence, never user authority. */
export type AttachmentLocator =
  | { type: "page"; page: number }
  | { type: "sheet"; sheet: string; range?: string }
  | { type: "slide"; slide: number }
  | { type: "time"; startSec: number; endSec: number }
  | { type: "image"; region?: { x: number; y: number; width: number; height: number } }
  | { type: "text"; start: number; end: number }

export interface AttachmentSegment {
  id: string
  text: string
  locator: AttachmentLocator
  /** Identifies inferred descriptions separately from extracted source text. */
  derivation?: "text" | "ocr" | "transcription" | "description"
}

export interface AttachmentExtractedContent {
  attachmentId: string
  /** SHA-256 of the original bytes, not of the filename or derived preview. */
  contentHash: string
  status: "ready" | "partial" | "failed" | "cancelled"
  segments: AttachmentSegment[]
  processor: { id: string; version: string }
  coverage?: { processed: number; total: number; unit: "pages" | "seconds" | "segments" }
  issues?: string[]
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

export function isAttachmentLocator(value: unknown): value is AttachmentLocator {
  if (!object(value)) return false
  switch (value.type) {
    case "page":
      return Number.isInteger(value.page) && (value.page as number) > 0
    case "slide":
      return Number.isInteger(value.slide) && (value.slide as number) > 0
    case "sheet":
      return (
        typeof value.sheet === "string" &&
        !!value.sheet &&
        (value.range === undefined || typeof value.range === "string")
      )
    case "time":
      return (
        nonnegative(value.startSec) && nonnegative(value.endSec) && value.endSec >= value.startSec
      )
    case "text":
      return (
        nonnegative(value.start) &&
        nonnegative(value.end) &&
        Number.isInteger(value.start) &&
        Number.isInteger(value.end) &&
        value.end >= value.start
      )
    case "image": {
      const region = value.region
      return (
        region === undefined ||
        (object(region) &&
          nonnegative(region.x) &&
          nonnegative(region.y) &&
          nonnegative(region.width) &&
          nonnegative(region.height) &&
          region.width > 0 &&
          region.height > 0)
      )
    }
    default:
      return false
  }
}

/** Validate at persistence/transport boundaries; do not coerce malformed evidence. */
export function readAttachmentExtractedContent(value: unknown): AttachmentExtractedContent | null {
  if (
    !object(value) ||
    typeof value.attachmentId !== "string" ||
    !value.attachmentId ||
    typeof value.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.contentHash) ||
    !["ready", "partial", "failed", "cancelled"].includes(String(value.status)) ||
    !object(value.processor) ||
    typeof value.processor.id !== "string" ||
    !value.processor.id ||
    typeof value.processor.version !== "string" ||
    !value.processor.version ||
    !Array.isArray(value.segments)
  )
    return null
  const ids = new Set<string>()
  for (const segment of value.segments) {
    if (
      !object(segment) ||
      typeof segment.id !== "string" ||
      !segment.id ||
      ids.has(segment.id) ||
      typeof segment.text !== "string" ||
      !isAttachmentLocator(segment.locator) ||
      (segment.derivation !== undefined &&
        !["text", "ocr", "transcription", "description"].includes(String(segment.derivation)))
    )
      return null
    ids.add(segment.id)
  }
  if (value.coverage !== undefined) {
    const c = value.coverage
    if (
      !object(c) ||
      !nonnegative(c.processed) ||
      !nonnegative(c.total) ||
      c.processed > c.total ||
      !["pages", "seconds", "segments"].includes(String(c.unit))
    )
      return null
  }
  if (
    value.issues !== undefined &&
    (!Array.isArray(value.issues) || !value.issues.every((issue) => typeof issue === "string"))
  )
    return null
  return value as unknown as AttachmentExtractedContent
}

export function formatAttachmentLocator(locator: AttachmentLocator): string {
  switch (locator.type) {
    case "page":
      return `page ${locator.page}`
    case "slide":
      return `slide ${locator.slide}`
    case "sheet":
      return `sheet ${JSON.stringify(locator.sheet)}${locator.range ? ` ${locator.range}` : ""}`
    case "time":
      return `${locator.startSec}s–${locator.endSec}s`
    case "text":
      return `characters ${locator.start}–${locator.end}`
    case "image":
      return locator.region ? `image region ${JSON.stringify(locator.region)}` : "image"
  }
}
