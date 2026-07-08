// Aider session-history source (ADR-0062, T3).
//
// On disk: `.aider.chat.history.md` — a Markdown transcript aider APPENDS to,
// per repo (no central location, so picker-only). Format:
//   `# aider chat started at YYYY-MM-DD HH:MM:SS`  → a session boundary
//   `#### <text>`                                  → a user turn line
//   `> <text>`                                     → aider's own notes (skipped)
//   anything else                                  → assistant prose
// Aider records no structured tool calls, so fidelity is naturally capped at
// text turns. One file → one imported (continuous) session.

import type { ImportedConversation } from "@/lib/data/importers/types"
import type { StoredMessage } from "@/lib/claude/types"
import { buildMessage, buildSession, deriveTitle, importedSessionId, textPart } from "../to-parts"
import type {
  AgentSessionSourceAdapter,
  PickedSessionFile,
  SessionRef,
  SessionScanInput,
  SessionSummary,
} from "../types"

type Part = StoredMessage["parts"][number]

const ACCEPTED = [".md"]
const STARTED_RE = /^#\s*aider chat started at\s+(.+)$/i

interface ParsedSession {
  originalSessionId: string
  title: string
  messages: StoredMessage[]
  createdAt: number
  updatedAt: number
}

export function parseAiderHistory(
  content: string,
  locatorId: string,
  projectId?: string
): ParsedSession {
  const finalId = importedSessionId("aider", locatorId)
  const messages: StoredMessage[] = []
  let counter = 0
  let firstUserText = ""
  let createdAt = 0
  let updatedAt = 0

  let mode: "user" | "assistant" | null = null
  let userBuf: string[] = []
  let asstBuf: string[] = []

  const flushUser = () => {
    const text = userBuf.join("\n").trim()
    userBuf = []
    if (!text) return
    if (!firstUserText) firstUserText = text
    messages.push(
      buildMessage({
        sessionId: finalId,
        projectId,
        index: counter++,
        role: "user",
        parts: [textPart(text)],
        createdAt: createdAt || 0,
      })
    )
  }
  const flushAsst = () => {
    const text = asstBuf.join("\n").trim()
    asstBuf = []
    if (!text) return
    messages.push(
      buildMessage({
        sessionId: finalId,
        projectId,
        index: counter++,
        role: "assistant",
        parts: [textPart(text)],
        createdAt: createdAt || 0,
      })
    )
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
    if (line.startsWith(">")) continue // aider note — skip
    // Regular prose → assistant.
    if (mode === "user") flushUser()
    mode = "assistant"
    asstBuf.push(line)
  }
  flushUser()
  flushAsst()

  const now = Date.now()
  return {
    originalSessionId: locatorId,
    title: deriveTitle(firstUserText, "Aider session"),
    messages,
    createdAt: createdAt || now,
    updatedAt: updatedAt || now,
  }
}

function summarize(parsed: ParsedSession, locator: string): SessionSummary {
  return {
    ref: { sourceId: "aider", originalSessionId: parsed.originalSessionId, locator },
    title: parsed.title,
    sourceId: "aider",
    messageCount: parsed.messages.length,
    updatedAt: parsed.updatedAt,
  }
}

function toConversation(parsed: ParsedSession): ImportedConversation {
  const id = importedSessionId("aider", parsed.originalSessionId)
  const session = buildSession({
    id,
    title: parsed.title,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    seedMessages: parsed.messages,
  })
  return { session, messages: parsed.messages }
}

export const aiderSessionSource: AgentSessionSourceAdapter = {
  id: "aider",
  displayName: "Aider",
  labelKey: "aider",
  acceptedExtensions: ACCEPTED,

  // Per-repo file with no central home — picker only.
  scanRoots() {
    return []
  },

  detect(files: PickedSessionFile[]) {
    if (files.length === 0) return "no"
    const hinted = files.filter((f) => f.name.toLowerCase().includes("aider.chat.history"))
    if (hinted.length > 0) return hinted.length === files.length ? "match" : "maybe"
    const looks = files.some(
      (f) => STARTED_RE.test(f.content.split("\n")[0] ?? "") || /\n####\s/.test(f.content)
    )
    return looks ? "maybe" : "no"
  },

  async listSessions(input: SessionScanInput) {
    if (!input.pickedFiles?.length) return [] // no scan root
    return input.pickedFiles
      .filter((f) => f.name.toLowerCase().endsWith(".md"))
      .map((f) => summarize(parseAiderHistory(f.content, f.path), f.path))
      .filter((s) => s.messageCount > 0)
  },

  async parseSession(ref: SessionRef, input: SessionScanInput) {
    let content: string
    if (input.pickedFiles?.length) {
      content = input.pickedFiles.find((f) => f.path === ref.locator)?.content ?? ""
    } else {
      content = await input.fs.readTextFile(ref.locator)
    }
    return toConversation(parseAiderHistory(content, ref.locator))
  },
}
