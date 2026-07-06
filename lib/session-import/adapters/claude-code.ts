// Claude Code CLI session-history source.
//
// On disk: `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, one JSON record
// per line. Records carry `type` ("user" | "assistant" | "summary" | "system"),
// a nested Anthropic `message` with content blocks, and `toolUseResult`. The
// encoded-cwd dir name is the absolute project path with `/`, `.`, `\` → `-`
// (reused from `lib/memory/external/home.ts:encodeClaudeProject`).
//
// Content block → part mapping:
//   text        → text
//   thinking    → reasoning
//   tool_use    → tool-<name> (input)
//   tool_result → patched onto the matching tool part (output / errorText)
//   image       → file part (data: URL)

import { joinPath } from "@/lib/claude/instructions/paths"
import type { ImportedConversation } from "@/lib/data/importers/types"
import type { StoredMessage } from "@/lib/claude/types"
import { walkFiles } from "../fs"
import { importedUsageMetadata } from "../usage"
import {
  buildMessage,
  buildSession,
  deriveTitle,
  filePart,
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

/** Anthropic per-turn usage block carried on assistant records. */
interface ClaudeUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

interface ClaudeLine {
  type?: string
  uuid?: string
  parentUuid?: string | null
  sessionId?: string
  cwd?: string
  timestamp?: string
  isSidechain?: boolean
  message?: {
    role?: string
    model?: string
    content?: unknown
    usage?: ClaudeUsage
  }
  /** SDK-estimated turn cost (present on some Claude Code builds). */
  costUSD?: number
  /** Wall-clock turn duration in ms (present on some builds). */
  durationMs?: number
  toolUseResult?: unknown
  summary?: string
}

/**
 * Build the imported-usage metadata for one assistant record, or `undefined`
 * when the record carries no usable token counts. Cost/duration are folded in
 * only when the transcript reports them.
 */
function claudeUsageMeta(rec: ClaudeLine): StoredMessage["metadata"] | undefined {
  const u = rec.message?.usage
  if (!u) return undefined
  const input = u.input_tokens ?? 0
  const output = u.output_tokens ?? 0
  const cacheCreation = u.cache_creation_input_tokens ?? 0
  const cacheRead = u.cache_read_input_tokens ?? 0
  if (input === 0 && output === 0 && cacheCreation === 0 && cacheRead === 0) return undefined
  return importedUsageMetadata(
    {
      inputTokens: input,
      outputTokens: output,
      cacheCreationInputTokens: cacheCreation,
      cacheReadInputTokens: cacheRead,
      ...(typeof rec.costUSD === "number" ? { totalCostUsd: rec.costUSD } : {}),
      ...(typeof rec.durationMs === "number" ? { durationMs: rec.durationMs } : {}),
    },
    rec.message?.model
  )
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

const ACCEPTED = [".jsonl"]

function tsToMs(ts: string | undefined, fallback: number): number {
  if (!ts) return fallback
  const n = Date.parse(ts)
  return Number.isNaN(n) ? fallback : n
}

/** Parse the raw JSONL body of one Claude Code transcript file. */
export function parseClaudeTranscript(
  content: string,
  locatorId: string,
  projectId?: string
): ParsedSession {
  const lines = content.split("\n")
  const records: ClaudeLine[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      records.push(JSON.parse(trimmed) as ClaudeLine)
    } catch {
      // Skip corrupt lines (mirrors cli/src/agent/transcript.ts).
    }
  }

  const messages: StoredMessage[] = []
  // toolCallId → { messageIndex, partIndex } so a later tool_result patches it.
  const toolIndex = new Map<string, { m: number; p: number }>()
  let sessionId = ""
  let cwd: string | undefined
  let model: string | undefined
  let firstUserText = ""
  let summary = ""
  let createdAt = 0
  let updatedAt = 0
  let msgCounter = 0

  const sid = () => importedSessionId("claude-code", sessionId || locatorId)

  for (const rec of records) {
    if (rec.sessionId && !sessionId) sessionId = rec.sessionId
    if (rec.cwd && !cwd) cwd = rec.cwd
    const ms = tsToMs(rec.timestamp, updatedAt || Date.now())
    if (!createdAt) createdAt = ms
    updatedAt = Math.max(updatedAt, ms)

    if (rec.type === "summary") {
      if (typeof rec.summary === "string" && !summary) summary = rec.summary
      continue
    }
    if (rec.type !== "user" && rec.type !== "assistant") continue

    const role = rec.type
    if (rec.message?.model && !model) model = rec.message.model
    const blocks = normalizeContent(rec.message?.content)

    // A user record that only carries tool_result blocks patches the prior
    // assistant tool parts instead of emitting a standalone user message.
    const resultBlocks = blocks.filter((b) => b.type === "tool_result")
    const nonResult = blocks.filter((b) => b.type !== "tool_result")

    if (role === "user" && resultBlocks.length > 0) {
      for (const b of resultBlocks) patchToolResult(messages, toolIndex, b)
      if (nonResult.length === 0) continue
    }

    const parts: Part[] = []
    for (const b of nonResult) {
      const part = blockToPart(b)
      if (!part) continue
      parts.push(part)
      if (b.type === "tool_use" && b.id) {
        toolIndex.set(b.id, { m: messages.length, p: parts.length - 1 })
      }
    }
    if (parts.length === 0) continue

    if (role === "user" && !firstUserText) {
      firstUserText = plainTextOf(parts)
    }

    const metadata = role === "assistant" ? claudeUsageMeta(rec) : undefined
    messages.push(
      buildMessage({
        sessionId: sid(),
        projectId,
        index: msgCounter++,
        role,
        parts,
        createdAt: ms,
        ...(metadata ? { metadata } : {}),
      })
    )
  }

  const finalId = sid()
  // Re-key message ids/sessionIds now that sessionId is settled (the first
  // record may have been a summary with no sessionId).
  messages.forEach((m, i) => {
    m.sessionId = finalId
    m.id = importedMessageId(finalId, i)
  })

  const title = deriveTitle(firstUserText || summary, "Claude Code session")
  const now = Date.now()
  return {
    originalSessionId: sessionId || locatorId,
    cwd,
    model,
    title,
    messages,
    createdAt: createdAt || now,
    updatedAt: updatedAt || now,
  }
}

interface Block {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
  source?: { type?: string; media_type?: string; data?: string; url?: string }
}

function normalizeContent(content: unknown): Block[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : []
  }
  if (Array.isArray(content)) {
    return content.filter((b): b is Block => !!b && typeof b === "object")
  }
  return []
}

function blockToPart(b: Block): Part | null {
  switch (b.type) {
    case "text":
      return typeof b.text === "string" && b.text ? textPart(b.text) : null
    case "thinking":
      return typeof b.thinking === "string" && b.thinking ? reasoningPart(b.thinking) : null
    case "tool_use":
      return toolPart({
        name: b.name || "tool",
        toolCallId: b.id || "unknown",
        input: b.input ?? {},
      })
    case "image": {
      const src = b.source
      if (src?.type === "base64" && src.media_type && src.data) {
        return filePart({
          mediaType: src.media_type,
          url: `data:${src.media_type};base64,${src.data}`,
        })
      }
      if (src?.url) return filePart({ mediaType: src.media_type || "image/png", url: src.url })
      return null
    }
    default:
      return null
  }
}

function patchToolResult(
  messages: StoredMessage[],
  toolIndex: Map<string, { m: number; p: number }>,
  b: Block
): void {
  const id = b.tool_use_id
  if (!id) return
  const loc = toolIndex.get(id)
  if (!loc) return
  const msg = messages[loc.m]
  if (!msg) return
  const part = msg.parts[loc.p] as Record<string, unknown> | undefined
  if (!part) return
  const output = resultToOutput(b.content)
  msg.parts[loc.p] = {
    ...part,
    state: b.is_error ? "output-error" : "output-available",
    ...(b.is_error
      ? { errorText: typeof output === "string" ? output : JSON.stringify(output) }
      : { output }),
  } as unknown as Part
}

function resultToOutput(content: unknown): unknown {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    // Anthropic tool_result content is an array of {type:"text",text} blocks.
    const texts = content
      .map((c) =>
        c && typeof c === "object" && typeof (c as Block).text === "string" ? (c as Block).text : ""
      )
      .filter(Boolean)
    if (texts.length) return texts.join("\n")
  }
  return content ?? ""
}

function plainTextOf(parts: Part[]): string {
  return (parts as Array<Record<string, unknown>>)
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join(" ")
}

function summarize(parsed: ParsedSession, locator: string): SessionSummary {
  return {
    ref: { sourceId: "claude-code", originalSessionId: parsed.originalSessionId, locator },
    title: parsed.title,
    sourceId: "claude-code",
    messageCount: parsed.messages.length,
    updatedAt: parsed.updatedAt,
    cwd: parsed.cwd,
  }
}

function toConversation(parsed: ParsedSession, projectId?: string): ImportedConversation {
  const id = importedSessionId("claude-code", parsed.originalSessionId)
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

export const claudeCodeSessionSource: AgentSessionSourceAdapter = {
  id: "claude-code",
  displayName: "Claude Code",
  labelKey: "claude-code",
  acceptedExtensions: ACCEPTED,

  scanRoots(home) {
    return home ? [joinPath(joinPath(home, ".claude"), "projects")] : []
  },

  detect(files: PickedSessionFile[]) {
    if (files.length === 0) return "no"
    const hinted = files.filter((f) => f.path.replace(/\\/g, "/").includes(".claude/projects"))
    if (hinted.length > 0) return hinted.length === files.length ? "match" : "maybe"
    // Content sniff: Claude Code lines carry a top-level `parentUuid` + nested message.
    const looksClaude = files.some((f) => {
      const first = f.content.split("\n").find((l) => l.trim())
      if (!first) return false
      try {
        const rec = JSON.parse(first) as ClaudeLine
        return "parentUuid" in rec && !!rec.message
      } catch {
        return false
      }
    })
    return looksClaude ? "maybe" : "no"
  },

  async listSessions(input: SessionScanInput) {
    if (input.pickedFiles?.length) {
      return input.pickedFiles
        .filter((f) => f.name.toLowerCase().endsWith(".jsonl"))
        .map((f) => summarize(parseClaudeTranscript(f.content, f.name), f.path))
    }
    const roots = this.scanRoots(input.home)
    const summaries: SessionSummary[] = []
    for (const root of roots) {
      const files = await walkFiles(input.fs, root, (n) => n.toLowerCase().endsWith(".jsonl"))
      for (const file of files) {
        try {
          const content = await input.fs.readTextFile(file)
          const parsed = parseClaudeTranscript(content, file)
          if (parsed.messages.length > 0) summaries.push(summarize(parsed, file))
        } catch {
          // Skip unreadable transcript.
        }
      }
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
  },

  async parseSession(ref: SessionRef, input: SessionScanInput) {
    let content: string
    if (input.pickedFiles?.length) {
      const picked = input.pickedFiles.find((f) => f.path === ref.locator)
      content = picked?.content ?? ""
    } else {
      content = await input.fs.readTextFile(ref.locator)
    }
    const parsed = parseClaudeTranscript(content, ref.locator)
    return toConversation(parsed)
  },
}
