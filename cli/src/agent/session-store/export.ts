/**
 * Session export: canonical JSON / canonical JSONL / Markdown / HTML.
 *
 * Export always reads the FULL log, so history stays available after a
 * compaction — compaction shrinks what the model sees, not what the user
 * recorded. That is the whole reason the log is append-only.
 *
 * On escaping: the repo's two existing `escapeHtml` helpers are both unusable
 * from the CLI bundle — `lib/artifacts/preview-utils` imports DOMPurify (a
 * browser-only dep) and `lib/connectors/adapters/matrix/serialize` drags the
 * connector type graph in for six lines. A local escape keeps the CLI bundle
 * from growing a browser dependency just to print a transcript.
 */

import type { AgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"
import type { CanonicalSession, CanonicalTurn } from "@cognia/agent-config-types/canonical-session"

export type SessionExportFormat = "json" | "jsonl" | "markdown" | "html"

export const SESSION_EXPORT_FORMATS: readonly SessionExportFormat[] = [
  "json",
  "jsonl",
  "markdown",
  "html",
]

export interface SessionExportOptions {
  format: SessionExportFormat
  /** Include tool calls/results in the human-readable formats. Default true. */
  includeToolCalls?: boolean
}

export interface SessionExportResult {
  format: SessionExportFormat
  /** `application/json`, `application/x-ndjson`, `text/markdown`, `text/html`. */
  mediaType: string
  content: string
}

const MEDIA_TYPES: Record<SessionExportFormat, string> = {
  json: "application/json",
  jsonl: "application/x-ndjson",
  markdown: "text/markdown",
  html: "text/html",
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function roleLabel(role: CanonicalTurn["role"]): string {
  return role === "user" ? "User" : role === "assistant" ? "Assistant" : "System"
}

function renderMarkdown(session: CanonicalSession, includeToolCalls: boolean): string {
  const lines: string[] = []
  lines.push(`# ${session.header.title ?? session.header.canonicalSessionId}`)
  lines.push("")
  lines.push(`- Session: \`${session.header.canonicalSessionId}\``)
  lines.push(`- Runtime: ${session.header.sourceRuntime}`)
  lines.push(`- Created: ${session.header.createdAt}`)
  lines.push(`- Updated: ${session.header.updatedAt}`)
  lines.push(`- Turns: ${session.header.turnCount}`)
  lines.push(`- Import fidelity: ${session.header.importFidelity}`)
  lines.push("")

  for (const turn of session.turns) {
    lines.push(`## ${roleLabel(turn.role)}${turn.at ? ` — ${turn.at}` : ""}`)
    lines.push("")
    if (turn.text.length > 0) {
      lines.push(turn.text)
      lines.push("")
    }
    if (includeToolCalls && turn.toolCalls && turn.toolCalls.length > 0) {
      for (const call of turn.toolCalls) {
        lines.push(
          `<details><summary>🔧 ${call.toolName}${call.isError ? " (error)" : ""}</summary>`
        )
        lines.push("")
        if (call.input) {
          lines.push("```json")
          lines.push(JSON.stringify(call.input, null, 2))
          lines.push("```")
        }
        if (call.resultText !== undefined) {
          lines.push("```")
          lines.push(call.resultText)
          lines.push("```")
        }
        lines.push("")
        lines.push("</details>")
        lines.push("")
      }
    }
  }
  return lines.join("\n")
}

function renderHtml(session: CanonicalSession, includeToolCalls: boolean): string {
  const parts: string[] = []
  const title = escapeHtml(session.header.title ?? session.header.canonicalSessionId)
  parts.push("<!doctype html>")
  parts.push('<html lang="en"><head><meta charset="utf-8">')
  parts.push(`<title>${title}</title>`)
  parts.push(
    "<style>body{font:15px/1.6 system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem}" +
      ".turn{border-left:3px solid #ccc;padding:.25rem 0 .25rem 1rem;margin:1.25rem 0}" +
      ".user{border-color:#3b82f6}.assistant{border-color:#10b981}.system{border-color:#a3a3a3}" +
      ".role{font-weight:600;font-size:.85rem;text-transform:uppercase;letter-spacing:.04em}" +
      ".at{color:#777;font-weight:400;text-transform:none;letter-spacing:0}" +
      "pre{background:#f5f5f5;padding:.6rem;border-radius:6px;overflow-x:auto}" +
      "@media(prefers-color-scheme:dark){body{background:#111;color:#eee}pre{background:#1e1e1e}}</style>"
  )
  parts.push("</head><body>")
  parts.push(`<h1>${title}</h1>`)
  parts.push(
    `<p><code>${escapeHtml(session.header.canonicalSessionId)}</code> · ${escapeHtml(
      session.header.sourceRuntime
    )} · ${session.header.turnCount} turns · fidelity ${escapeHtml(
      session.header.importFidelity
    )}</p>`
  )

  for (const turn of session.turns) {
    parts.push(`<div class="turn ${turn.role}">`)
    parts.push(
      `<div class="role">${roleLabel(turn.role)}${
        turn.at ? ` <span class="at">${escapeHtml(turn.at)}</span>` : ""
      }</div>`
    )
    if (turn.text.length > 0) parts.push(`<pre>${escapeHtml(turn.text)}</pre>`)
    if (includeToolCalls && turn.toolCalls) {
      for (const call of turn.toolCalls) {
        parts.push(
          `<details><summary>🔧 ${escapeHtml(call.toolName)}${
            call.isError ? " (error)" : ""
          }</summary>`
        )
        if (call.input) {
          parts.push(`<pre>${escapeHtml(JSON.stringify(call.input, null, 2))}</pre>`)
        }
        if (call.resultText !== undefined) {
          parts.push(`<pre>${escapeHtml(call.resultText)}</pre>`)
        }
        parts.push("</details>")
      }
    }
    parts.push("</div>")
  }
  parts.push("</body></html>")
  return parts.join("\n")
}

/**
 * Render a session export.
 *
 * `jsonl` emits the RAW envelope log (the authoritative record); the other
 * three render the materialized canonical session.
 */
export function exportSession(
  session: CanonicalSession,
  envelopes: readonly AgentEventEnvelope[],
  options: SessionExportOptions
): SessionExportResult {
  const includeToolCalls = options.includeToolCalls !== false
  const mediaType = MEDIA_TYPES[options.format]
  switch (options.format) {
    case "json":
      return { format: "json", mediaType, content: `${JSON.stringify(session, null, 2)}\n` }
    case "jsonl":
      return {
        format: "jsonl",
        mediaType,
        content: envelopes.map((envelope) => JSON.stringify(envelope)).join("\n") + "\n",
      }
    case "markdown":
      return { format: "markdown", mediaType, content: renderMarkdown(session, includeToolCalls) }
    case "html":
      return { format: "html", mediaType, content: renderHtml(session, includeToolCalls) }
  }
}

export function isSessionExportFormat(value: unknown): value is SessionExportFormat {
  return typeof value === "string" && (SESSION_EXPORT_FORMATS as readonly string[]).includes(value)
}
