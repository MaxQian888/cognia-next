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
  type BrowserContextLimits,
  type BrowserContextSubmitRequestV1,
  type BrowserPageContextV1,
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
  // instead would make this branch unreachable — the per-field caps sum to
  // 168 KiB, comfortably under it — and an unreachable limit is worse than no
  // limit, because it reads as protection that was never there. On the raw
  // payload it does real work: it refuses a body padded with megabytes of
  // fields this contract does not name, before any of them are parsed.
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

  const contextResult = validateContext(context, limits)
  if (!contextResult.ok) return contextResult

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
  }

  return { ok: true, request }
}

type ContextValidation =
  { ok: true; context: BrowserPageContextV1 } | { ok: false; rejection: BrowserSubmissionRejection }

function validateContext(value: unknown, limits: BrowserContextLimits): ContextValidation {
  if (!isRecord(value)) return reject({ code: "malformed", field: "context" })
  if (value.schemaVersion !== 1)
    return reject({ code: "malformed", field: "context.schemaVersion" })
  const captureMode = value.captureMode
  if (
    typeof captureMode !== "string" ||
    !BROWSER_CAPTURE_MODES.includes(captureMode as BrowserPageContextV1["captureMode"])
  ) {
    return reject({ code: "malformed", field: "context.captureMode" })
  }
  if (!nonEmptyString(value.url)) return reject({ code: "malformed", field: "context.url" })
  // Only http(s) reaches here. A `file:`, `chrome:` or `data:` URL means the
  // extension captured something it was told not to, and the Host is the
  // boundary that has to say so rather than assume the client behaved.
  if (!isHttpUrl(value.url)) return reject({ code: "malformed", field: "context.url" })
  if (typeof value.title !== "string") return reject({ code: "malformed", field: "context.title" })
  if (typeof value.capturedAt !== "number" || !Number.isFinite(value.capturedAt)) {
    return reject({ code: "malformed", field: "context.capturedAt" })
  }

  const context: BrowserPageContextV1 = {
    schemaVersion: 1,
    captureMode: captureMode as BrowserPageContextV1["captureMode"],
    url: value.url,
    title: value.title,
    capturedAt: value.capturedAt,
  }

  if (value.selection !== undefined) {
    if (!isRecord(value.selection)) return reject({ code: "malformed", field: "context.selection" })
    if (
      typeof value.selection.text !== "string" ||
      typeof value.selection.truncated !== "boolean"
    ) {
      return reject({ code: "malformed", field: "context.selection" })
    }
    const bytes = utf8ByteLength(value.selection.text)
    if (bytes > limits.selectionBytes) {
      return reject({
        code: "too_large",
        field: "context.selection",
        bytes,
        limit: limits.selectionBytes,
      })
    }
    context.selection = { text: value.selection.text, truncated: value.selection.truncated }
  }

  if (value.readableText !== undefined) {
    const readable = value.readableText
    if (
      !isRecord(readable) ||
      typeof readable.text !== "string" ||
      typeof readable.truncated !== "boolean" ||
      typeof readable.originalCharacterCount !== "number" ||
      !Number.isFinite(readable.originalCharacterCount)
    ) {
      return reject({ code: "malformed", field: "context.readableText" })
    }
    const bytes = utf8ByteLength(readable.text)
    if (bytes > limits.readableTextBytes) {
      return reject({
        code: "too_large",
        field: "context.readableText",
        bytes,
        limit: limits.readableTextBytes,
      })
    }
    context.readableText = {
      text: readable.text,
      truncated: readable.truncated,
      originalCharacterCount: readable.originalCharacterCount,
    }
  }

  // A mode names what the user agreed to send, so an envelope whose payload
  // does not match it is a disagreement about consent rather than a harmless
  // shape difference — refuse rather than silently downgrade to what arrived.
  if (context.captureMode === "selection" && !context.selection) {
    return reject({ code: "capture_mode_missing_content", field: "context.selection" })
  }
  if (context.captureMode === "readable-page" && !context.readableText) {
    return reject({ code: "capture_mode_missing_content", field: "context.readableText" })
  }
  if (context.captureMode === "metadata" && (context.selection || context.readableText)) {
    return reject({ code: "malformed", field: "context.captureMode" })
  }

  return { ok: true, context }
}

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
