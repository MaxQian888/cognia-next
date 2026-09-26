// The PII gate on tool output: the last check before a tool result reaches a
// model, on every rail. The ai-sdk adapter runs it inside each tool's execute,
// the Claude Agent SDK rail wraps each registered handler with it, and the MCP
// tool bridge and tool host run it on every result they return.
//
// Output that already carries no PII passes through unchanged. Otherwise the
// gate redacts every string inside it; if PII still shows after that, the
// result is withheld and the call fails with `TOOL_RESULT_PII_ERROR`.

import { hasNoLeakingPiiDeep, redactText } from "@cognia/redact"

export const TOOL_RESULT_PII_ERROR = "Tool result blocked by the PII redaction gate"

const CIRCULAR = "[circular tool output omitted]"

function isTextualMediaType(mediaType: unknown): boolean {
  const mime = String(mediaType ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase()
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime.endsWith("+json") ||
    mime === "application/xml" ||
    mime.endsWith("+xml") ||
    mime === "application/javascript" ||
    mime === "application/x-www-form-urlencoded"
  )
}

/**
 * Decode a textual resource's base64 blob. Anything that is not canonical
 * base64 of valid UTF-8 could hide text the scan cannot see, so it fails the
 * gate instead of passing as an opaque token.
 */
function decodeBase64Utf8(data: string): string {
  const compact = data.replace(/\s/g, "")
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new Error(TOOL_RESULT_PII_ERROR)
  }
  const bytes = Buffer.from(compact, "base64")
  const canonical = bytes.toString("base64").replace(/=+$/, "")
  if (canonical !== compact.replace(/=+$/, "")) throw new Error(TOOL_RESULT_PII_ERROR)
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error(TOOL_RESULT_PII_ERROR)
  }
}

/** Copy `value`, re-encoding every textual resource blob with its text redacted. */
function redactTextualResourceBlobs(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined || typeof value !== "object") return value
  if (value instanceof Date) return value
  if (seen.has(value)) return CIRCULAR
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((item) => redactTextualResourceBlobs(item, seen))
  }
  if (value instanceof Map) {
    return new Map(
      [...value.entries()].map(([key, inner]) => [
        redactTextualResourceBlobs(key, seen),
        redactTextualResourceBlobs(inner, seen),
      ])
    )
  }
  if (value instanceof Set) {
    return new Set([...value].map((item) => redactTextualResourceBlobs(item, seen)))
  }
  const record = value as Record<string, unknown>
  const copy: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(record)) {
    copy[key] = redactTextualResourceBlobs(inner, seen)
  }
  const resource = record.resource as { blob?: unknown; mimeType?: unknown } | null | undefined
  if (
    record.type === "resource" &&
    resource &&
    typeof resource === "object" &&
    typeof resource.blob === "string" &&
    isTextualMediaType(resource.mimeType)
  ) {
    const decoded = decodeBase64Utf8(resource.blob)
    ;(copy.resource as Record<string, unknown>).blob = Buffer.from(
      redactText(decoded).redacted,
      "utf8"
    ).toString("base64")
  }
  return copy
}

function redactToolOutputDeep(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim()
    // Text-only tools often flatten structured output to JSON. Redacting the
    // entire serialized string can classify long numeric timestamps as PII and
    // splice placeholders into number tokens, producing invalid JSON. Parse
    // object/array JSON first so only its actual string values are redacted.
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.stringify(redactToolOutputDeep(JSON.parse(value), seen))
      } catch {
        // Ordinary text can begin with a brace; fall through to text redaction.
      }
    }
    return redactText(value).redacted
  }
  if (value === null || value === undefined) return value
  if (typeof value !== "object" || value instanceof Date) return value
  if (seen.has(value)) return CIRCULAR
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redactToolOutputDeep(item, seen))
  if (value instanceof Map) {
    return new Map(
      [...value.entries()].map(([key, inner]) => [
        redactToolOutputDeep(key, seen),
        redactToolOutputDeep(inner, seen),
      ])
    )
  }
  if (value instanceof Set) {
    return new Set([...value].map((item) => redactToolOutputDeep(item, seen)))
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [key, redactToolOutputDeep(inner, seen)])
  )
}

function hasNoLeakingPiiToolOutput(output: unknown): boolean {
  if (typeof output === "string") {
    const trimmed = output.trim()
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return hasNoLeakingPiiDeep(JSON.parse(output))
      } catch {
        // Not valid structured output; scan it as ordinary text below.
      }
    }
  }
  return hasNoLeakingPiiDeep(output)
}

/**
 * Return `output` in a form safe to hand a model: unchanged when it carries no
 * PII, redacted when redaction clears it. Throws `TOOL_RESULT_PII_ERROR` when
 * PII survives redaction, or when a textual resource blob cannot be decoded.
 */
export function assertModelSafeToolOutput(output: unknown): unknown {
  // Embedded textual resources cross the provider boundary as base64 file
  // parts. Decode them before scanning; otherwise the encoded bytes look like
  // an opaque safe token while the model decodes the original PII.
  const decodedSafe = redactTextualResourceBlobs(output)
  if (hasNoLeakingPiiToolOutput(decodedSafe)) return decodedSafe
  const redacted = redactToolOutputDeep(decodedSafe)
  if (!hasNoLeakingPiiToolOutput(redacted)) throw new Error(TOOL_RESULT_PII_ERROR)
  return redacted
}
