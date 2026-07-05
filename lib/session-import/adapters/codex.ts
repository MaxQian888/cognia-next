// OpenAI Codex CLI session-history source.
//
// On disk: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (honors
// $CODEX_HOME). Each line is a `RolloutLine` = `{ timestamp, type, payload }`,
// with `type` ∈ session_meta | response_item | event_msg | turn_context |
// compacted. We reconstruct the conversation from `response_item` payloads:
//
//   message (role + content[input_text|output_text]) → text
//   reasoning (summary/text)                          → reasoning
//   function_call (name, arguments, call_id)          → tool-<name> (input)
//   function_call_output (call_id, output)            → patch tool output
//   custom_tool_call[_output]                         → tool + patch
//   ghost_snapshot                                    → filtered out
//
// Item taxonomy reference: lib/ai/agent/external/codex-app-server-client.ts.

import { joinPath } from "@/lib/claude/instructions/paths"
import type { ImportedConversation } from "@/lib/data/importers/types"
import type { StoredMessage } from "@/lib/claude/types"
import type { UsageInfo } from "@/lib/claude/adapter"
import { walkFiles } from "../fs"
import { importedUsageMetadata } from "../usage"
import {
  buildMessage,
  buildSession,
  deriveTitle,
  importedMessageId,
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

const ACCEPTED = [".jsonl"]

interface RolloutLine {
  timestamp?: string
  type?: string
  payload?: Record<string, unknown>
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

function tsToMs(ts: string | undefined, fallback: number): number {
  if (!ts) return fallback
  const n = Date.parse(ts)
  return Number.isNaN(n) ? fallback : n
}

/** Codex token accounting block (fields best-effort; names vary by version). */
interface CodexTokenUsage {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  total_tokens?: number
}

/** Cumulative token totals threaded across the rollout to derive per-turn deltas. */
interface CumulativeTokens {
  input: number
  output: number
  cacheRead: number
}

const ZERO_CUMULATIVE: CumulativeTokens = { input: 0, output: 0, cacheRead: 0 }

function numOf(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

function toUsageInfo(u: CodexTokenUsage): UsageInfo {
  return {
    inputTokens: numOf(u.input_tokens),
    outputTokens: numOf(u.output_tokens),
    cacheReadInputTokens: numOf(u.cached_input_tokens),
    ...(u.reasoning_output_tokens ? { reasoningTokens: numOf(u.reasoning_output_tokens) } : {}),
  }
}

/**
 * Resolve one `token_count` event to per-turn usage. Prefers the event's own
 * `last_token_usage`; otherwise derives the turn's delta from the running
 * `total_token_usage`. Returns `null` (and leaves `prev` untouched) when the
 * event carries no usable counts. Mutates `prev` to the new cumulative totals.
 */
function codexTurnUsage(info: Record<string, unknown>, prev: CumulativeTokens): UsageInfo | null {
  const last = info.last_token_usage as CodexTokenUsage | undefined
  const total = info.total_token_usage as CodexTokenUsage | undefined
  if (last && (last.input_tokens || last.output_tokens || last.cached_input_tokens)) {
    return toUsageInfo(last)
  }
  if (total) {
    const input = numOf(total.input_tokens)
    const output = numOf(total.output_tokens)
    const cacheRead = numOf(total.cached_input_tokens)
    const delta: UsageInfo = {
      inputTokens: Math.max(0, input - prev.input),
      outputTokens: Math.max(0, output - prev.output),
      cacheReadInputTokens: Math.max(0, cacheRead - prev.cacheRead),
    }
    prev.input = input
    prev.output = output
    prev.cacheRead = cacheRead
    if (!delta.inputTokens && !delta.outputTokens && !delta.cacheReadInputTokens) return null
    return delta
  }
  return null
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : ""
}

/** Extract the concatenated text from a Codex message payload's content array. */
function messageText(payload: Record<string, unknown>): string {
  const content = payload.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const out: string[] = []
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>
      if (typeof b.text === "string") out.push(b.text)
    }
  }
  return out.join("")
}

/** Extract reasoning text (summary or text arrays / plain string). */
function reasoningText(payload: Record<string, unknown>): string {
  for (const key of ["summary", "content", "text"]) {
    const v = payload[key]
    if (typeof v === "string" && v) return v
    if (Array.isArray(v)) {
      const texts = v
        .map((b) =>
          b && typeof b === "object" ? asString((b as Record<string, unknown>).text) : ""
        )
        .filter(Boolean)
      if (texts.length) return texts.join("\n")
    }
  }
  return ""
}

export function parseCodexRollout(
  content: string,
  locatorId: string,
  projectId?: string
): ParsedSession {
  const messages: StoredMessage[] = []
  const toolIndex = new Map<string, { m: number; p: number }>()
  let sessionId = ""
  let cwd: string | undefined
  let model: string | undefined
  let firstUserText = ""
  let createdAt = 0
  let updatedAt = 0
  let msgCounter = 0
  // Codex emits token accounting as a standalone `event_msg` after each turn,
  // so we attach it to the turn's last-seen assistant message.
  let lastAssistantIndex = -1
  const prevTotal: CumulativeTokens = { ...ZERO_CUMULATIVE }

  const sid = () => importedSessionId("codex", sessionId || locatorId)

  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec: RolloutLine
    try {
      rec = JSON.parse(trimmed) as RolloutLine
    } catch {
      continue
    }
    const ms = tsToMs(rec.timestamp, updatedAt || Date.now())
    if (!createdAt) createdAt = ms
    updatedAt = Math.max(updatedAt, ms)
    const payload = rec.payload ?? {}

    if (rec.type === "session_meta") {
      sessionId = asString(payload.id) || asString(payload.session_id) || sessionId
      cwd = asString(payload.cwd) || cwd
      model = asString(payload.model) || asString(payload.model_provider) || model
      continue
    }
    if (rec.type === "turn_context") {
      model = asString(payload.model) || model
      continue
    }
    if (rec.type === "event_msg") {
      if (asString(payload.type) === "token_count") {
        const info = (
          payload.info && typeof payload.info === "object" ? payload.info : payload
        ) as Record<string, unknown>
        const usage = codexTurnUsage(info, prevTotal)
        if (usage && lastAssistantIndex >= 0) {
          messages[lastAssistantIndex] = {
            ...messages[lastAssistantIndex],
            metadata: importedUsageMetadata(usage, model),
          }
        }
      }
      continue
    }
    if (rec.type !== "response_item") continue

    const itemType = asString(payload.type)
    if (itemType === "ghost_snapshot") continue

    if (itemType === "message") {
      const role = asString(payload.role) === "assistant" ? "assistant" : "user"
      const text = messageText(payload)
      if (!text) continue
      if (role === "user" && !firstUserText) firstUserText = text
      messages.push(
        buildMessage({
          sessionId: sid(),
          projectId,
          index: msgCounter++,
          role,
          parts: [textPart(text)],
          createdAt: ms,
        })
      )
      if (role === "assistant") lastAssistantIndex = messages.length - 1
      continue
    }

    if (itemType === "reasoning") {
      const text = reasoningText(payload)
      if (!text) continue
      messages.push(
        buildMessage({
          sessionId: sid(),
          projectId,
          index: msgCounter++,
          role: "assistant",
          parts: [reasoningPart(text)],
          createdAt: ms,
        })
      )
      lastAssistantIndex = messages.length - 1
      continue
    }

    if (itemType === "function_call" || itemType === "custom_tool_call") {
      const callId = asString(payload.call_id) || asString(payload.id) || `call-${msgCounter}`
      const name = asString(payload.name) || "tool"
      const rawArgs = payload.arguments ?? payload.input
      const input = parseMaybeJson(rawArgs)
      const part = toolPart({ name, toolCallId: callId, input })
      messages.push(
        buildMessage({
          sessionId: sid(),
          projectId,
          index: msgCounter++,
          role: "assistant",
          parts: [part],
          createdAt: ms,
        })
      )
      lastAssistantIndex = messages.length - 1
      toolIndex.set(callId, { m: messages.length - 1, p: 0 })
      continue
    }

    if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
      const callId = asString(payload.call_id) || asString(payload.id)
      const loc = callId ? toolIndex.get(callId) : undefined
      if (!loc) continue
      const msg = messages[loc.m]
      const part = msg?.parts[loc.p] as Record<string, unknown> | undefined
      if (!part) continue
      const output = extractOutput(payload.output)
      msg.parts[loc.p] = {
        ...part,
        state: "output-available",
        output,
      } as unknown as Part
    }
  }

  const finalId = sid()
  messages.forEach((m, i) => {
    m.sessionId = finalId
    m.id = importedMessageId(finalId, i)
  })

  const now = Date.now()
  return {
    originalSessionId: sessionId || locatorId,
    cwd,
    model,
    title: deriveTitle(firstUserText, "Codex session"),
    messages,
    createdAt: createdAt || now,
    updatedAt: updatedAt || now,
  }
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v ?? {}
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

function extractOutput(output: unknown): unknown {
  if (typeof output === "string") return parseMaybeJson(output)
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>
    if (typeof o.output === "string") return o.output
    if (typeof o.content === "string") return o.content
  }
  return output ?? ""
}

function summarize(parsed: ParsedSession, locator: string): SessionSummary {
  return {
    ref: { sourceId: "codex", originalSessionId: parsed.originalSessionId, locator },
    title: parsed.title,
    sourceId: "codex",
    messageCount: parsed.messages.length,
    updatedAt: parsed.updatedAt,
    cwd: parsed.cwd,
  }
}

function toConversation(parsed: ParsedSession, projectId?: string): ImportedConversation {
  const id = importedSessionId("codex", parsed.originalSessionId)
  const session = buildSession({
    id,
    projectId,
    title: parsed.title,
    model: parsed.model,
    workingDir: parsed.cwd,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    seedMessages: parsed.messages,
  })
  return { session, messages: parsed.messages }
}

export const codexSessionSource: AgentSessionSourceAdapter = {
  id: "codex",
  displayName: "Codex CLI",
  labelKey: "codex",
  acceptedExtensions: ACCEPTED,

  scanRoots(home) {
    return home ? [joinPath(joinPath(home, ".codex"), "sessions")] : []
  },

  detect(files: PickedSessionFile[]) {
    if (files.length === 0) return "no"
    const hinted = files.filter((f) => {
      const p = f.path.replace(/\\/g, "/")
      return p.includes(".codex/sessions") || /rollout-.*\.jsonl$/.test(f.name)
    })
    if (hinted.length > 0) return hinted.length === files.length ? "match" : "maybe"
    const looksCodex = files.some((f) => {
      const first = f.content.split("\n").find((l) => l.trim())
      if (!first) return false
      try {
        const rec = JSON.parse(first) as RolloutLine
        return rec.type === "session_meta" || (!!rec.type && !!rec.payload)
      } catch {
        return false
      }
    })
    return looksCodex ? "maybe" : "no"
  },

  async listSessions(input: SessionScanInput) {
    if (input.pickedFiles?.length) {
      return input.pickedFiles
        .filter((f) => f.name.toLowerCase().endsWith(".jsonl"))
        .map((f) => summarize(parseCodexRollout(f.content, f.name), f.path))
    }
    const roots = this.scanRoots(input.home)
    const summaries: SessionSummary[] = []
    for (const root of roots) {
      const files = await walkFiles(input.fs, root, (n) => n.toLowerCase().endsWith(".jsonl"))
      for (const file of files) {
        try {
          const content = await input.fs.readTextFile(file)
          const parsed = parseCodexRollout(content, file)
          if (parsed.messages.length > 0) summaries.push(summarize(parsed, file))
        } catch {
          // Skip unreadable rollout.
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
    return toConversation(parseCodexRollout(content, ref.locator))
  },
}
