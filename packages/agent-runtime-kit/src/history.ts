/**
 * Building blocks for history readers (ADR-0217): part constructors, the
 * stable ids a re-import must reproduce, and the bounded diagnostic every
 * reader keeps for records it cannot map.
 */

import type {
  HistoryPart,
  HistoryReaderHost,
  HistoryToolPart,
  HistoryToolResult,
} from "@cognia/agent-contracts/history"

export function historyText(text: string): Extract<HistoryPart, { type: "text" }> {
  return { type: "text", text }
}

export function historyReasoning(text: string): Extract<HistoryPart, { type: "reasoning" }> {
  return { type: "reasoning", text }
}

export function historyFile(opts: {
  mediaType: string
  url: string
  filename?: string
}): Extract<HistoryPart, { type: "file" }> {
  return {
    type: "file",
    mediaType: opts.mediaType,
    url: opts.url,
    ...(opts.filename ? { filename: opts.filename } : {}),
  }
}

/** A tool call; `result` stays absent until the transcript records one. */
export function historyTool(opts: {
  name: string
  toolCallId: string
  input?: unknown
  result?: HistoryToolResult
  status?: string
}): HistoryToolPart {
  return {
    type: "tool",
    name: opts.name,
    toolCallId: opts.toolCallId,
    input: opts.input ?? {},
    ...(opts.result ? { result: opts.result } : {}),
    ...(opts.status !== undefined ? { status: opts.status } : {}),
  }
}

/** A tool result's text form, for an error the transcript recorded as data. */
export function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

/**
 * Stable id of an imported session, derived from the source and the
 * runtime's own id, so re-reading the same file updates the session instead
 * of duplicating it.
 */
export function importedSessionId(sourceId: string, originalSessionId: string): string {
  return `import:${sourceId}:${originalSessionId}`
}

/** Deterministic id of the `index`-th message of an imported session. */
export function importedMessageId(sessionId: string, index: number): string {
  return `${sessionId}:m${index}`
}

/** First-line, whitespace-collapsed title, truncated to 80 characters. */
export function deriveTitle(firstUserText: string, fallback: string): string {
  const cleaned = firstUserText.replace(/\s+/g, " ").trim()
  if (!cleaned) return fallback
  return cleaned.length > 80 ? `${cleaned.slice(0, 79)}…` : cleaned
}

const SECRET_KEY = /token|secret|password|authorization|api[_-]?key/i

/**
 * A bounded copy of a record a reader could not map, safe to keep in the
 * session's recorded events: at most 5 levels, 20 array items and 30 keys,
 * strings cut at 1,000 characters and passed through the host's redactor, and
 * any value under a credential-looking key replaced outright.
 */
export function boundedDiagnostic(value: unknown, host: HistoryReaderHost, depth = 0): unknown {
  if (depth > 4) return "[truncated]"
  if (typeof value === "string") {
    const bounded = value.length > 1000 ? `${value.slice(0, 1000)}…` : value
    return host.redactText(bounded)
  }
  if (typeof value !== "object" || value === null) return value
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => boundedDiagnostic(item, host, depth + 1))
  }
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value).slice(0, 30)) {
    out[key] = SECRET_KEY.test(key) ? "[redacted]" : boundedDiagnostic(child, host, depth + 1)
  }
  return out
}
