/**
 * Host-side validation of a submission envelope.
 *
 * The extension enforces the same ceilings, but only so its preview can say
 * *what was cut*. A client-side limit is a courtesy; this is the boundary. The
 * JSON Schema in `protocol/companion-request-schemas.json` is a structural
 * guard rather than a second copy of it — its `maxLength` counts UTF-16 code
 * units, so a CJK page passes a 32768 `maxLength` while carrying nearly 100 KiB
 * of UTF-8. Bytes are what the wire and the model context actually cost, so
 * bytes are what is checked here.
 */
import {
  BROWSER_CAPTURE_MODES,
  BROWSER_CONTEXT_LIMITS,
  type BrowserAttachmentKind,
  type BrowserAttachmentRefV1,
  type BrowserContextLimits,
  type BrowserContextSubmitRequestV1,
  type BrowserPageContextV1,
  type BrowserPageMetadataV1,
} from "@/types/browser-companion"
import { utf8ByteLength } from "@cognia/companion-client"

export type BrowserSubmissionRejection =
  | { code: "malformed"; field: string }
  | { code: "too_large"; field: string; bytes: number; limit: number }
  | { code: "capture_mode_missing_content"; field: string }

export type BrowserSubmissionValidation =
  | { ok: true; request: BrowserContextSubmitRequestV1 }
  | { ok: false; rejection: BrowserSubmissionRejection }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/**
 * Validate a raw payload into a submission.
 *
 * Returns a rejection rather than throwing because every one of these is a
 * message the side panel has to render — "the page was too long" and "the
 * request was malformed" send the user to different remedies, and an exception
 * carrying an English sentence makes the panel string-match to tell them apart.
 */
export function validateBrowserSubmission(
  payload: unknown,
  limits: BrowserContextLimits = BROWSER_CONTEXT_LIMITS
): BrowserSubmissionValidation {
  if (!isRecord(payload)) return reject({ code: "malformed", field: "payload" })
  // The envelope ceiling is the OUTER guard, checked on what arrived rather
  // than on the request we would build from it. Checking the rebuilt request
  // instead would make this branch unreachable — the instruction plus the
  // total context budget sum to 520 KiB, comfortably under it — and an
  // unreachable limit is worse than no limit, because it reads as protection
  // that was never there. On the raw payload it does real work: it refuses a
  // body padded with megabytes of fields this contract does not name, before
  // any of them are parsed.
  const payloadBytes = utf8ByteLength(JSON.stringify(payload))
  if (payloadBytes > limits.requestBytes) {
    return reject({
      code: "too_large",
      field: "request",
      bytes: payloadBytes,
      limit: limits.requestBytes,
    })
  }
  const {
    submissionId,
    workspaceId,
    targetId,
    targetParams,
    instruction,
    suggestedTitle,
    context,
  } = payload
  if (!nonEmptyString(submissionId)) return reject({ code: "malformed", field: "submissionId" })
  if (!nonEmptyString(workspaceId)) return reject({ code: "malformed", field: "workspaceId" })
  if (!nonEmptyString(instruction)) return reject({ code: "malformed", field: "instruction" })
  if (suggestedTitle !== undefined && typeof suggestedTitle !== "string") {
    return reject({ code: "malformed", field: "suggestedTitle" })
  }
  // Shape only. Whether this names something that exists is not a validation
  // question: the answer lives in a catalogue only the Host can build, and
  // deciding it here would mean either duplicating that lookup or letting a
  // well-formed id through as if it had been checked.
  if (targetId !== undefined && !nonEmptyString(targetId)) {
    return reject({ code: "malformed", field: "targetId" })
  }
  // Shape only, again. Which ids are meaningful is the target declaration's
  // answer, and the Host reads that back rather than trusting this map — an
  // entry naming a parameter the target does not declare is dropped there, so
  // it cannot introduce a substitution by arriving here.
  if (targetParams !== undefined && !isStringRecord(targetParams)) {
    return reject({ code: "malformed", field: "targetParams" })
  }
  const instructionBytes = utf8ByteLength(instruction)
  if (instructionBytes > limits.instructionBytes) {
    return reject({
      code: "too_large",
      field: "instruction",
      bytes: instructionBytes,
      limit: limits.instructionBytes,
    })
  }

  const contextResult = validateContext(context, limits, "context")
  if (!contextResult.ok) return contextResult

  const { additionalContexts, attachments, browserAgent } = payload
  if (
    browserAgent !== undefined &&
    (!isRecord(browserAgent) ||
      typeof browserAgent.tabId !== "number" ||
      !Number.isInteger(browserAgent.tabId) ||
      browserAgent.tabId < 0)
  ) {
    return reject({ code: "malformed", field: "browserAgent" })
  }
  const extraPages: BrowserPageContextV1[] = []
  if (additionalContexts !== undefined) {
    if (!Array.isArray(additionalContexts)) {
      return reject({ code: "malformed", field: "additionalContexts" })
    }
    const maxPages = limits.maxPages ?? BROWSER_CONTEXT_LIMITS.maxPages
    if (additionalContexts.length + 1 > maxPages) {
      return reject({
        code: "too_large",
        field: "additionalContexts",
        bytes: additionalContexts.length + 1,
        limit: maxPages,
      })
    }
    for (const [index, page] of additionalContexts.entries()) {
      const pageResult = validateContext(page, limits, `additionalContexts[${index}]`)
      if (!pageResult.ok) return pageResult
      extraPages.push(pageResult.context)
    }
  }

  // The per-field caps bound one page; this bounds the submission. Without it
  // ten pages at their own ceilings would be well over a megabyte of prompt.
  const totalLimit = limits.totalContextBytes ?? BROWSER_CONTEXT_LIMITS.totalContextBytes
  const totalBytes = [contextResult.context, ...extraPages].reduce(
    (sum, page) => sum + pageContentBytes(page),
    0
  )
  if (totalBytes > totalLimit) {
    return reject({ code: "too_large", field: "contexts", bytes: totalBytes, limit: totalLimit })
  }

  const attachmentRefs: BrowserAttachmentRefV1[] = []
  if (attachments !== undefined) {
    if (!Array.isArray(attachments)) return reject({ code: "malformed", field: "attachments" })
    const maxAttachments = limits.maxAttachments ?? BROWSER_CONTEXT_LIMITS.maxAttachments
    if (attachments.length > maxAttachments) {
      return reject({
        code: "too_large",
        field: "attachments",
        bytes: attachments.length,
        limit: maxAttachments,
      })
    }
    const seen = new Set<string>()
    for (const [index, entry] of attachments.entries()) {
      if (
        !isRecord(entry) ||
        !nonEmptyString(entry.attachmentId) ||
        !BROWSER_ATTACHMENT_KINDS.includes(entry.kind as BrowserAttachmentKind) ||
        seen.has(entry.attachmentId)
      ) {
        return reject({ code: "malformed", field: `attachments[${index}]` })
      }
      seen.add(entry.attachmentId)
      attachmentRefs.push({
        attachmentId: entry.attachmentId,
        kind: entry.kind as BrowserAttachmentKind,
      })
    }
  }

  const request: BrowserContextSubmitRequestV1 = {
    submissionId,
    workspaceId,
    ...(typeof targetId === "string" ? { targetId } : {}),
    ...(isStringRecord(targetParams) ? { targetParams } : {}),
    instruction,
    ...(typeof suggestedTitle === "string" && suggestedTitle.trim()
      ? { suggestedTitle: suggestedTitle.trim() }
      : {}),
    context: contextResult.context,
    ...(extraPages.length > 0 ? { additionalContexts: extraPages } : {}),
    ...(attachmentRefs.length > 0 ? { attachments: attachmentRefs } : {}),
    ...(isRecord(browserAgent) && typeof browserAgent.tabId === "number"
      ? { browserAgent: { tabId: browserAgent.tabId } }
      : {}),
  }

  return { ok: true, request }
}

const BROWSER_ATTACHMENT_KINDS: readonly BrowserAttachmentKind[] = ["screenshot", "pdf", "image"]

/** The bytes of page content one page contributes to the total budget. */
export function pageContentBytes(page: BrowserPageContextV1): number {
  let bytes = 0
  if (page.selection) bytes += utf8ByteLength(page.selection.text)
  if (page.readableText) bytes += utf8ByteLength(page.readableText.text)
  if (page.article) bytes += utf8ByteLength(page.article.text)
  if (page.transcript?.status === "available") bytes += utf8ByteLength(page.transcript.text)
  return bytes
}

type ContextValidation =
  { ok: true; context: BrowserPageContextV1 } | { ok: false; rejection: BrowserSubmissionRejection }

/** Longest a metadata string may be; the page's own claim, kept to a line. */
const METADATA_FIELD_MAX = 2048

function validateContext(
  value: unknown,
  limits: BrowserContextLimits,
  path: string
): ContextValidation {
  if (!isRecord(value)) return reject({ code: "malformed", field: path })
  if (value.schemaVersion !== 1)
    return reject({ code: "malformed", field: `${path}.schemaVersion` })
  const captureMode = value.captureMode
  if (
    typeof captureMode !== "string" ||
    !BROWSER_CAPTURE_MODES.includes(captureMode as BrowserPageContextV1["captureMode"])
  ) {
    return reject({ code: "malformed", field: `${path}.captureMode` })
  }
  if (!nonEmptyString(value.url)) return reject({ code: "malformed", field: `${path}.url` })
  // Only http(s) reaches here. A `file:`, `chrome:` or `data:` URL means the
  // extension captured something it was told not to, and the Host is the
  // boundary that has to say so rather than assume the client behaved.
  if (!isHttpUrl(value.url)) return reject({ code: "malformed", field: `${path}.url` })
  if (typeof value.title !== "string") return reject({ code: "malformed", field: `${path}.title` })
  if (typeof value.capturedAt !== "number" || !Number.isFinite(value.capturedAt)) {
    return reject({ code: "malformed", field: `${path}.capturedAt` })
  }

  const context: BrowserPageContextV1 = {
    schemaVersion: 1,
    captureMode: captureMode as BrowserPageContextV1["captureMode"],
    url: value.url,
    title: value.title,
    capturedAt: value.capturedAt,
  }

  if (value.selection !== undefined) {
    const selection = value.selection
    if (
      !isRecord(selection) ||
      typeof selection.text !== "string" ||
      typeof selection.truncated !== "boolean" ||
      !isTextFormat(selection.format)
    ) {
      return reject({ code: "malformed", field: `${path}.selection` })
    }
    const bytes = utf8ByteLength(selection.text)
    if (bytes > limits.selectionBytes) {
      return reject({
        code: "too_large",
        field: `${path}.selection`,
        bytes,
        limit: limits.selectionBytes,
      })
    }
    context.selection = {
      text: selection.text,
      truncated: selection.truncated,
      ...(selection.format === "markdown" ? { format: "markdown" as const } : {}),
    }
  }

  const readable = readableField(
    value.readableText,
    `${path}.readableText`,
    limits.readableTextBytes
  )
  if (!readable.ok) return readable
  if (readable.value) context.readableText = readable.value

  const article = readableField(
    value.article,
    `${path}.article`,
    limits.articleBytes ?? BROWSER_CONTEXT_LIMITS.articleBytes
  )
  if (!article.ok) return article
  if (article.value) context.article = { ...article.value, format: "markdown" }

  if (value.metadata !== undefined) {
    const metadata = validateMetadata(value.metadata)
    if (!metadata) return reject({ code: "malformed", field: `${path}.metadata` })
    if (Object.keys(metadata).length > 0) context.metadata = metadata
  }

  if (value.transcript !== undefined) {
    const transcript = value.transcript
    if (!isRecord(transcript)) return reject({ code: "malformed", field: `${path}.transcript` })
    if (transcript.status === "available") {
      if (
        typeof transcript.text !== "string" ||
        typeof transcript.truncated !== "boolean" ||
        (transcript.language !== undefined && typeof transcript.language !== "string") ||
        (transcript.autoGenerated !== undefined && typeof transcript.autoGenerated !== "boolean")
      ) {
        return reject({ code: "malformed", field: `${path}.transcript` })
      }
      const transcriptLimit = limits.transcriptBytes ?? BROWSER_CONTEXT_LIMITS.transcriptBytes
      const bytes = utf8ByteLength(transcript.text)
      if (bytes > transcriptLimit) {
        return reject({
          code: "too_large",
          field: `${path}.transcript`,
          bytes,
          limit: transcriptLimit,
        })
      }
      context.transcript = {
        status: "available",
        text: transcript.text,
        truncated: transcript.truncated,
        ...(typeof transcript.language === "string" && transcript.language
          ? { language: transcript.language.slice(0, 35) }
          : {}),
        ...(typeof transcript.autoGenerated === "boolean"
          ? { autoGenerated: transcript.autoGenerated }
          : {}),
      }
    } else if (transcript.status === "unavailable") {
      if (
        transcript.reason !== "no_captions" &&
        transcript.reason !== "not_a_video" &&
        transcript.reason !== "fetch_failed"
      ) {
        return reject({ code: "malformed", field: `${path}.transcript` })
      }
      context.transcript = { status: "unavailable", reason: transcript.reason }
    } else {
      return reject({ code: "malformed", field: `${path}.transcript` })
    }
  }

  if (value.link !== undefined) {
    const link = value.link
    if (
      !isRecord(link) ||
      !nonEmptyString(link.url) ||
      !isHttpUrl(link.url) ||
      (link.text !== undefined && typeof link.text !== "string")
    ) {
      return reject({ code: "malformed", field: `${path}.link` })
    }
    context.link = {
      url: link.url.slice(0, 4096),
      ...(typeof link.text === "string" && link.text.trim()
        ? { text: link.text.trim().slice(0, METADATA_FIELD_MAX) }
        : {}),
    }
  }

  if (value.image !== undefined) {
    const image = value.image
    if (
      !isRecord(image) ||
      !nonEmptyString(image.url) ||
      !isHttpUrl(image.url) ||
      (image.alt !== undefined && typeof image.alt !== "string")
    ) {
      return reject({ code: "malformed", field: `${path}.image` })
    }
    context.image = {
      url: image.url.slice(0, 4096),
      ...(typeof image.alt === "string" && image.alt.trim()
        ? { alt: image.alt.trim().slice(0, METADATA_FIELD_MAX) }
        : {}),
    }
  }

  // A mode names what the user agreed to send, so an envelope whose payload
  // does not match it is a disagreement about consent rather than a harmless
  // shape difference — refuse rather than silently downgrade to what arrived.
  if (context.captureMode === "selection" && !context.selection) {
    return reject({ code: "capture_mode_missing_content", field: `${path}.selection` })
  }
  if (context.captureMode === "readable-page" && !context.readableText) {
    return reject({ code: "capture_mode_missing_content", field: `${path}.readableText` })
  }
  if (context.captureMode === "article" && !context.article) {
    return reject({ code: "capture_mode_missing_content", field: `${path}.article` })
  }
  if (
    context.captureMode === "metadata" &&
    (context.selection || context.readableText || context.article)
  ) {
    return reject({ code: "malformed", field: `${path}.captureMode` })
  }

  return { ok: true, context }
}

type ReadableField =
  | { ok: true; value: BrowserPageContextV1["readableText"] | undefined }
  | { ok: false; rejection: BrowserSubmissionRejection }

function readableField(value: unknown, field: string, limit: number): ReadableField {
  if (value === undefined) return { ok: true, value: undefined }
  if (
    !isRecord(value) ||
    typeof value.text !== "string" ||
    typeof value.truncated !== "boolean" ||
    typeof value.originalCharacterCount !== "number" ||
    !Number.isFinite(value.originalCharacterCount) ||
    value.originalCharacterCount < 0 ||
    !isTextFormat(value.format)
  ) {
    return reject({ code: "malformed", field })
  }
  const bytes = utf8ByteLength(value.text)
  if (bytes > limit) return reject({ code: "too_large", field, bytes, limit })
  return {
    ok: true,
    value: {
      text: value.text,
      truncated: value.truncated,
      originalCharacterCount: value.originalCharacterCount,
    },
  }
}

function isTextFormat(value: unknown): boolean {
  return value === undefined || value === "plain" || value === "markdown"
}

/**
 * Keep the metadata fields this contract names, as bounded strings.
 *
 * `null` for a value that is not a record or carries a non-string field: a
 * wrong type is a malformed client, while an unknown key is just a newer one
 * and is dropped like every other unknown key here.
 */
function validateMetadata(value: unknown): BrowserPageMetadataV1 | null {
  if (!isRecord(value)) return null
  const metadata: BrowserPageMetadataV1 = {}
  for (const key of METADATA_KEYS) {
    const field = value[key]
    if (field === undefined) continue
    if (typeof field !== "string") return null
    const trimmed = field.trim()
    if (!trimmed) continue
    if (key === "canonicalUrl" && !isHttpUrl(trimmed)) continue
    metadata[key] = trimmed.slice(0, METADATA_FIELD_MAX)
  }
  return metadata
}

const METADATA_KEYS: readonly (keyof BrowserPageMetadataV1)[] = [
  "byline",
  "publishedAt",
  "siteName",
  "lang",
  "description",
  "canonicalUrl",
  "kind",
]

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

/** A flat `Record<string, string>`, and nothing more decorated than one. */
function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string")
}

function reject(rejection: BrowserSubmissionRejection): {
  ok: false
  rejection: BrowserSubmissionRejection
} {
  return { ok: false, rejection }
}
