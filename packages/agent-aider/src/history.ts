/**
 * Aider chat-history reader (ADR-0217).
 *
 * On disk: `.aider.chat.history.md`, a Markdown transcript Aider appends to,
 * per repository (no central location). Format:
 *
 *   `# aider chat started at YYYY-MM-DD HH:MM:SS`  → a session boundary
 *   `#### <text>`                                  → a user turn line
 *   `> <text>`                                     → Aider's own notes (skipped)
 *   anything else                                  → assistant prose
 *
 * Aider records no structured tool calls, so fidelity is capped at text turns.
 * One file is one continuous session. Pure functions over file content: the
 * host finds and reads the file and maps the result into its own rows.
 */

import type { SessionLossEntry } from "@cognia/agent-contracts/canonical-session"
import type {
  HistoryDetectVerdict,
  HistoryFormatInfo,
  HistoryMessage,
  HistoryPickedFile,
  HistorySessionSummary,
  ParsedHistorySession,
} from "@cognia/agent-contracts/history"
import { deriveTitle, historyText } from "@cognia/agent-runtime-kit/history"
import { AIDER_SESSION_SOURCE_ID } from "./manifest"

/** The Aider version this reader was last verified against. */
export const AIDER_HISTORY_FORMAT: HistoryFormatInfo = Object.freeze({
  sourceId: AIDER_SESSION_SOURCE_ID,
  verifiedVersion: "0.86.2",
  verifiedAt: "2026-08-29",
  acceptedExtensions: Object.freeze([".md"]),
})

/** What every Aider transcript loses, whatever its content. */
export const AIDER_HISTORY_LOSSES: readonly SessionLossEntry[] = Object.freeze([
  Object.freeze({
    path: "markdown",
    kind: "summarized",
    detail: "Aider Markdown history does not carry structured tool, task, or runtime state.",
  }),
])

const STARTED_RE = /^#\s*aider chat started at\s+(.+)$/i

interface Scan {
  title: string
  messages: HistoryMessage[]
  messageCount: number
  createdAt: number
  updatedAt: number
}

function scan(content: string, summaryOnly: boolean): Scan {
  const messages: HistoryMessage[] = []
  let count = 0
  let firstUserText = ""
  let createdAt = 0
  let updatedAt = 0

  let mode: "user" | "assistant" | null = null
  let userBuf: string[] = []
  let asstBuf: string[] = []

  const flush = (role: "user" | "assistant", lines: string[]) => {
    const text = lines.join("\n").trim()
    if (!text) return
    if (role === "user" && !firstUserText) firstUserText = text
    count++
    if (!summaryOnly) messages.push({ role, parts: [historyText(text)], createdAt })
  }
  const flushUser = () => {
    flush("user", userBuf)
    userBuf = []
  }
  const flushAsst = () => {
    flush("assistant", asstBuf)
    asstBuf = []
  }

  for (const line of content.split("\n")) {
    const started = STARTED_RE.exec(line)
    if (started) {
      flushUser()
      flushAsst()
      mode = null
      const ms = Date.parse(started[1].trim())
      if (!Number.isNaN(ms)) {
        if (!createdAt) createdAt = ms
        updatedAt = Math.max(updatedAt, ms)
      }
      continue
    }
    if (line.startsWith("####")) {
      if (mode === "assistant") flushAsst()
      mode = "user"
      userBuf.push(line.replace(/^####\s?/, ""))
      continue
    }
    if (line.startsWith(">")) continue // Aider note: skipped
    if (mode === "user") flushUser()
    mode = "assistant"
    asstBuf.push(line)
  }
  flushUser()
  flushAsst()

  const now = Date.now()
  return {
    title: deriveTitle(firstUserText, "Aider session"),
    messages,
    messageCount: count,
    createdAt: createdAt || now,
    updatedAt: updatedAt || now,
  }
}

/**
 * Parse one chat-history file. `locatorId` (the file path) is the session id:
 * Aider writes none. Messages carry the session's first start time, the only
 * timestamp the format records per turn.
 */
export function parseAiderHistory(content: string, locatorId: string): ParsedHistorySession {
  const parsed = scan(content, false)
  return {
    sourceId: AIDER_SESSION_SOURCE_ID,
    originalSessionId: locatorId,
    title: parsed.title,
    messages: parsed.messages,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    goals: [],
    plans: [],
    tasks: [],
    history: [],
    interAgentMessages: [],
    recordedEvents: [],
    losses: AIDER_HISTORY_LOSSES.map((loss) => ({ ...loss })),
  }
}

/** A picker row for one file, counting turns without building them. */
export function summarizeAiderHistory(content: string, locatorId: string): HistorySessionSummary {
  const parsed = scan(content, true)
  return {
    sourceId: AIDER_SESSION_SOURCE_ID,
    originalSessionId: locatorId,
    title: parsed.title,
    messageCount: parsed.messageCount,
    updatedAt: parsed.updatedAt,
  }
}

/**
 * `match` when every picked file is named like Aider's history, `maybe` when
 * some are or the content looks like one, otherwise `no`.
 */
export function detectAiderHistory(files: readonly HistoryPickedFile[]): HistoryDetectVerdict {
  if (files.length === 0) return "no"
  const hinted = files.filter((f) => f.name.toLowerCase().includes("aider.chat.history"))
  if (hinted.length > 0) return hinted.length === files.length ? "match" : "maybe"
  const looks = files.some(
    (f) => STARTED_RE.test(f.content.split("\n")[0] ?? "") || /\n####\s/.test(f.content)
  )
  return looks ? "maybe" : "no"
}
