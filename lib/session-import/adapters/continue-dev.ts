// Continue.dev IDE-extension session-history source (ADR-0062, T3).
//
// On disk: `~/.continue/sessions/<sessionId>.json`, one JSON object per session:
//   { sessionId, title, workspaceDirectory, history: ChatHistoryItem[] }
// where each item.message = { role: "user"|"assistant"|"system"|"tool",
//   content: string | MessagePart[], toolCalls?: [{ id, function:{name,arguments}}] }.
// A `tool`-role message carries a tool call's output (correlated by toolCallId).
// `~/.continue/sessions/sessions.json` is a lightweight index we ignore (we read
// the per-session files directly, which is robust to a stale index).

import { joinPath } from "@/lib/claude/instructions/paths"
import type { ImportedConversation } from "@/lib/data/importers/types"
import type { StoredMessage } from "@/lib/claude/types"
import { walkFiles } from "../fs"
import {
  buildMessage,
  buildSession,
  deriveTitle,
  filePart,
  importedSessionId,
  textPart,
  toolPart,
} from "../to-parts"
import type {
  AgentSessionSourceAdapter,
  PickedSessionFile,
  SessionRef,
  SessionScanInput,
  SessionSummary,
} from "../types"

type Part = StoredMessage["parts"][number]

interface ContinueMessage {
  role?: string
  content?: unknown
  toolCallId?: string
  toolCalls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>
}
interface ContinueItem {
  message?: ContinueMessage
}
interface ContinueSession {
  sessionId?: string
  title?: string
  workspaceDirectory?: string
  history?: ContinueItem[]
}

const ACCEPTED = [".json"]

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v ?? {}
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

/** Continue message content: a plain string or an array of typed parts. */
function contentToParts(content: unknown): Part[] {
  if (typeof content === "string") return content ? [textPart(content)] : []
  if (!Array.isArray(content)) return []
  const parts: Part[] = []
  for (const p of content) {
    if (!p || typeof p !== "object") continue
    const rec = p as { type?: string; text?: string; imageUrl?: { url?: string } | string }
    if (rec.type === "text" && typeof rec.text === "string" && rec.text) {
      parts.push(textPart(rec.text))
    } else if (rec.type === "imageUrl") {
      const url = typeof rec.imageUrl === "string" ? rec.imageUrl : rec.imageUrl?.url
      if (url) parts.push(filePart({ mediaType: "image/png", url }))
    }
  }
  return parts
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && typeof p === "object" && (p as { type?: string }).type === "text")
      .map((p) => (p as { text?: string }).text ?? "")
      .join("\n")
  }
  return ""
}

interface ParsedSession {
  originalSessionId: string
  cwd?: string
  title: string
  messages: StoredMessage[]
}

export function parseContinueSession(
  raw: string,
  locatorId: string,
  projectId?: string
): ParsedSession {
  let data: ContinueSession
  try {
    data = JSON.parse(raw) as ContinueSession
  } catch {
    return { originalSessionId: locatorId, title: "Continue session", messages: [] }
  }
  const originalSessionId = data.sessionId || locatorId
  const finalId = importedSessionId("continue-dev", originalSessionId)
  const history = Array.isArray(data.history) ? data.history : []

  const messages: StoredMessage[] = []
  const toolIndex = new Map<string, { m: number; p: number }>()
  let firstUserText = ""
  let counter = 0

  for (const item of history) {
    const msg = item?.message
    if (!msg || typeof msg.role !== "string") continue

    // A `tool` message is a tool result — patch the matching call in place.
    if (msg.role === "tool") {
      const loc = msg.toolCallId ? toolIndex.get(msg.toolCallId) : undefined
      if (!loc) continue
      const target = messages[loc.m]?.parts[loc.p] as Record<string, unknown> | undefined
      if (!target) continue
      messages[loc.m].parts[loc.p] = {
        ...target,
        state: "output-available",
        output: contentToText(msg.content),
      } as unknown as Part
      continue
    }

    const parts: Part[] = contentToParts(msg.content)
    if (msg.role === "assistant" && Array.isArray(msg.toolCalls)) {
      for (const tc of msg.toolCalls) {
        const id = tc.id || `call-${counter}-${parts.length}`
        parts.push(
          toolPart({
            name: tc.function?.name || "tool",
            toolCallId: id,
            input: parseMaybeJson(tc.function?.arguments),
          })
        )
        toolIndex.set(id, { m: messages.length, p: parts.length - 1 })
      }
    }
    if (parts.length === 0) continue

    const role = (
      msg.role === "assistant" ? "assistant" : msg.role === "system" ? "system" : "user"
    ) as StoredMessage["role"]
    if (role === "user" && !firstUserText) firstUserText = contentToText(msg.content)
    messages.push(
      buildMessage({ sessionId: finalId, projectId, index: counter++, role, parts, createdAt: 0 })
    )
  }

  return {
    originalSessionId,
    cwd: data.workspaceDirectory,
    title: data.title || deriveTitle(firstUserText, "Continue session"),
    messages,
  }
}

function summarize(parsed: ParsedSession, locator: string): SessionSummary {
  return {
    ref: { sourceId: "continue-dev", originalSessionId: parsed.originalSessionId, locator },
    title: parsed.title,
    sourceId: "continue-dev",
    messageCount: parsed.messages.length,
    updatedAt: 0,
    cwd: parsed.cwd,
  }
}

function toConversation(parsed: ParsedSession): ImportedConversation {
  const id = importedSessionId("continue-dev", parsed.originalSessionId)
  const session = buildSession({
    id,
    title: parsed.title,
    workingDir: parsed.cwd,
    createdAt: 0,
    updatedAt: 0,
    seedMessages: parsed.messages,
  })
  return { session, messages: parsed.messages }
}

export const continueDevSessionSource: AgentSessionSourceAdapter = {
  id: "continue-dev",
  displayName: "Continue",
  labelKey: "continue-dev",
  acceptedExtensions: ACCEPTED,

  scanRoots(home) {
    return home ? [joinPath(joinPath(home, ".continue"), "sessions")] : []
  },

  detect(files: PickedSessionFile[]) {
    if (files.length === 0) return "no"
    const hinted = files.filter((f) => f.path.replace(/\\/g, "/").includes(".continue/sessions"))
    if (hinted.length > 0) return hinted.length === files.length ? "match" : "maybe"
    const looks = files.some((f) => {
      try {
        const d = JSON.parse(f.content) as ContinueSession
        return Array.isArray(d.history) && typeof d.sessionId === "string"
      } catch {
        return false
      }
    })
    return looks ? "maybe" : "no"
  },

  async listSessions(input: SessionScanInput) {
    if (input.pickedFiles?.length) {
      return input.pickedFiles
        .filter((f) => f.name.toLowerCase().endsWith(".json") && f.name !== "sessions.json")
        .map((f) => summarize(parseContinueSession(f.content, f.name), f.path))
        .filter((s) => s.messageCount > 0)
    }
    const summaries: SessionSummary[] = []
    for (const root of this.scanRoots(input.home)) {
      const files = await walkFiles(
        input.fs,
        root,
        (n) => n.toLowerCase().endsWith(".json") && n !== "sessions.json"
      )
      for (const file of files) {
        try {
          const parsed = parseContinueSession(await input.fs.readTextFile(file), file)
          if (parsed.messages.length > 0) summaries.push(summarize(parsed, file))
        } catch {
          // Skip unreadable session.
        }
      }
    }
    return summaries
  },

  async parseSession(ref: SessionRef, input: SessionScanInput) {
    let content: string
    if (input.pickedFiles?.length) {
      content = input.pickedFiles.find((f) => f.path === ref.locator)?.content ?? ""
    } else {
      content = await input.fs.readTextFile(ref.locator)
    }
    return toConversation(parseContinueSession(content, ref.locator))
  },
}
