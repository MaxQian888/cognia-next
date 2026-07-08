// Gemini CLI session-history source (ADR-0062, T3).
//
// On disk: `~/.gemini/tmp/<projectHash>/chats/*.jsonl` (JSONL). The first line is
// a metadata record { sessionId, projectHash, startTime, lastUpdated, summary?,
// directories, kind }; each following line is a MessageRecord:
//   { id, timestamp, content: Part[], type: "user"|"gemini"|"info"|"error",
//     toolCalls?: [{ id, name, args, result, status }], thoughts?, tokens?, model? }
// where a Part is { text } | { functionCall:{name,args} } | { functionResponse }.
// `$set` / `$rewindTo` update records are ignored.

import { joinPath } from "@/lib/claude/instructions/paths"
import type { ImportedConversation } from "@/lib/data/importers/types"
import type { StoredMessage } from "@/lib/claude/types"
import { walkFiles } from "../fs"
import { importedUsageMetadata } from "../usage"
import {
  buildMessage,
  buildSession,
  deriveTitle,
  importedSessionId,
  reasoningPart,
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

interface GeminiToolCall {
  id?: string
  name?: string
  args?: unknown
  result?: unknown
  status?: string
}
interface GeminiRecord {
  sessionId?: string
  directories?: string[]
  startTime?: string
  // message record:
  id?: string
  timestamp?: string
  content?: unknown
  type?: string
  toolCalls?: GeminiToolCall[]
  thoughts?: Array<{ description?: string; subject?: string; text?: string }>
  tokens?: { input?: number; output?: number; total?: number; cached?: number }
  model?: string
}

const ACCEPTED = [".jsonl"]

/** Concatenate the `text` of a Gemini `Part[]` (functionCall/Response ignored). */
function partsText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((p) => p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string")
    .map((p) => (p as { text: string }).text)
    .join("")
}

function resultToOutput(result: unknown): unknown {
  if (typeof result === "string") return result
  if (Array.isArray(result)) return partsText(result)
  return result ?? ""
}

function thoughtsText(thoughts: GeminiRecord["thoughts"]): string {
  if (!Array.isArray(thoughts)) return ""
  return thoughts
    .map((t) => t.text || t.description || t.subject || "")
    .filter(Boolean)
    .join("\n")
}

function tsToMs(ts: string | undefined, fallback: number): number {
  if (!ts) return fallback
  const n = Date.parse(ts)
  return Number.isNaN(n) ? fallback : n
}

interface ParsedSession {
  originalSessionId: string
  cwd?: string
  model?: string
  title: string
  messages: StoredMessage[]
  createdAt: number
  updatedAt: number
}

export function parseGeminiChat(
  content: string,
  locatorId: string,
  projectId?: string
): ParsedSession {
  const records: GeminiRecord[] = []
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const rec = JSON.parse(trimmed) as Record<string, unknown>
      // Skip `$set` / `$rewindTo` update records.
      if (Object.keys(rec).some((k) => k.startsWith("$"))) continue
      records.push(rec as GeminiRecord)
    } catch {
      // Skip corrupt line.
    }
  }

  let sessionId = ""
  let cwd: string | undefined
  let model: string | undefined
  let firstUserText = ""
  let createdAt = 0
  let updatedAt = 0
  const messages: StoredMessage[] = []
  let counter = 0
  const finalId = () => importedSessionId("gemini-cli", sessionId || locatorId)

  for (const rec of records) {
    if (rec.sessionId && !sessionId) sessionId = rec.sessionId
    if (rec.directories?.[0] && !cwd) cwd = rec.directories[0]
    if (rec.model && !model) model = rec.model
    const ms = tsToMs(rec.timestamp || rec.startTime, updatedAt || Date.now())
    if (rec.timestamp || rec.startTime) {
      if (!createdAt) createdAt = ms
      updatedAt = Math.max(updatedAt, ms)
    }

    if (rec.type === "user") {
      const text = partsText(rec.content)
      if (!text) continue
      if (!firstUserText) firstUserText = text
      messages.push(
        buildMessage({
          sessionId: finalId(),
          projectId,
          index: counter++,
          role: "user",
          parts: [textPart(text)],
          createdAt: ms,
        })
      )
      continue
    }

    if (rec.type === "gemini") {
      const parts: Part[] = []
      const thoughts = thoughtsText(rec.thoughts)
      if (thoughts) parts.push(reasoningPart(thoughts))
      const text = partsText(rec.content)
      if (text) parts.push(textPart(text))
      for (const tc of rec.toolCalls ?? []) {
        const isError = tc.status === "error"
        const hasResult = tc.result !== undefined || isError
        parts.push(
          toolPart({
            name: tc.name || "tool",
            toolCallId: tc.id || `call-${counter}-${parts.length}`,
            input: tc.args ?? {},
            ...(hasResult ? { output: resultToOutput(tc.result), isError } : {}),
          })
        )
      }
      if (parts.length === 0) continue
      const usage = rec.tokens
        ? importedUsageMetadata(
            { inputTokens: rec.tokens.input ?? 0, outputTokens: rec.tokens.output ?? 0 },
            model
          )
        : undefined
      messages.push(
        buildMessage({
          sessionId: finalId(),
          projectId,
          index: counter++,
          role: "assistant",
          parts,
          createdAt: ms,
          ...(usage ? { metadata: usage } : {}),
        })
      )
      continue
    }

    if (rec.type === "info" || rec.type === "error") {
      const text = partsText(rec.content)
      if (!text) continue
      messages.push(
        buildMessage({
          sessionId: finalId(),
          projectId,
          index: counter++,
          role: "system",
          parts: [textPart(text)],
          createdAt: ms,
        })
      )
    }
  }

  const now = Date.now()
  return {
    originalSessionId: sessionId || locatorId,
    cwd,
    model,
    title: deriveTitle(firstUserText, "Gemini CLI session"),
    messages,
    createdAt: createdAt || now,
    updatedAt: updatedAt || now,
  }
}

function summarize(parsed: ParsedSession, locator: string): SessionSummary {
  return {
    ref: { sourceId: "gemini-cli", originalSessionId: parsed.originalSessionId, locator },
    title: parsed.title,
    sourceId: "gemini-cli",
    messageCount: parsed.messages.length,
    updatedAt: parsed.updatedAt,
    cwd: parsed.cwd,
  }
}

function toConversation(parsed: ParsedSession): ImportedConversation {
  const id = importedSessionId("gemini-cli", parsed.originalSessionId)
  const session = buildSession({
    id,
    title: parsed.title,
    model: parsed.model,
    workingDir: parsed.cwd,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    seedMessages: parsed.messages,
  })
  return { session, messages: parsed.messages }
}

export const geminiCliSessionSource: AgentSessionSourceAdapter = {
  id: "gemini-cli",
  displayName: "Gemini CLI",
  labelKey: "gemini-cli",
  acceptedExtensions: ACCEPTED,

  scanRoots(home) {
    return home ? [joinPath(joinPath(home, ".gemini"), "tmp")] : []
  },

  detect(files: PickedSessionFile[]) {
    if (files.length === 0) return "no"
    const hinted = files.filter((f) => f.path.replace(/\\/g, "/").includes(".gemini/tmp"))
    if (hinted.length > 0) return hinted.length === files.length ? "match" : "maybe"
    const looks = files.some((f) => {
      const first = f.content.split("\n").find((l) => l.trim())
      if (!first) return false
      try {
        const rec = JSON.parse(first) as GeminiRecord
        return typeof rec.sessionId === "string" && "projectHash" in (rec as object)
      } catch {
        return false
      }
    })
    return looks ? "maybe" : "no"
  },

  async listSessions(input: SessionScanInput) {
    if (input.pickedFiles?.length) {
      return input.pickedFiles
        .filter((f) => f.name.toLowerCase().endsWith(".jsonl"))
        .map((f) => summarize(parseGeminiChat(f.content, f.name), f.path))
        .filter((s) => s.messageCount > 0)
    }
    const summaries: SessionSummary[] = []
    for (const root of this.scanRoots(input.home)) {
      const files = await walkFiles(input.fs, root, (n) => n.toLowerCase().endsWith(".jsonl"))
      for (const file of files) {
        try {
          const parsed = parseGeminiChat(await input.fs.readTextFile(file), file)
          if (parsed.messages.length > 0) summaries.push(summarize(parsed, file))
        } catch {
          // Skip unreadable chat.
        }
      }
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
  },

  async parseSession(ref: SessionRef, input: SessionScanInput) {
    let content: string
    if (input.pickedFiles?.length) {
      content = input.pickedFiles.find((f) => f.path === ref.locator)?.content ?? ""
    } else {
      content = await input.fs.readTextFile(ref.locator)
    }
    return toConversation(parseGeminiChat(content, ref.locator))
  },
}
