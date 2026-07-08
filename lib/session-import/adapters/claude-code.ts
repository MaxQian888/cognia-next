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
  extractSidechains,
  linearizeActiveLeaf,
  splitMainAndSidechain,
  type SidechainGroup,
} from "./claude-code-dag"
import { buildSubagentSnapshot } from "./claude-code-subagent"
import {
  buildMessage,
  buildSession,
  deriveTitle,
  filePart,
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

export interface ClaudeLine {
  type?: string
  uuid?: string
  parentUuid?: string | null
  sessionId?: string
  cwd?: string
  timestamp?: string
  isSidechain?: boolean
  /** Top-level content string carried on `type: "system"` records. */
  content?: unknown
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
  /**
   * Subagent (Task/sidechain) runs extracted from this transcript, each
   * linearized to its own active leaf (raw form; kept for transparency/tests).
   */
  sidechains: SidechainGroup<ClaudeLine>[]
  /**
   * Hidden `kind: "subagent"` inner-transcript sessions reconstructed from the
   * sidechains. Persisted as top-level rows alongside the main conversation.
   */
  nestedConversations: ImportedConversation[]
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

  // Resolve the DAG: keep only the active-leaf chain of the main thread
  // (dropping abandoned edit/re-run branches) and pull subagent sidechains out
  // into their own runs for separate reconstruction (T2a-sub).
  const { main } = splitMainAndSidechain(records)
  const mainLinear = linearizeActiveLeaf(main)
  const sidechains = extractSidechains(records)

  // Metadata scan over ALL records — sessionId/cwd/model can appear on any
  // record, and updatedAt should reflect the latest activity (incl. sidechains).
  let sessionId = ""
  let cwd: string | undefined
  let scanModel: string | undefined
  let summary = ""
  let createdAt = 0
  let updatedAt = 0
  for (const rec of records) {
    if (rec.sessionId && !sessionId) sessionId = rec.sessionId
    if (rec.cwd && !cwd) cwd = rec.cwd
    if (rec.message?.model && !scanModel) scanModel = rec.message.model
    if (rec.type === "summary" && typeof rec.summary === "string" && !summary) {
      summary = rec.summary
    }
    const ms = tsToMs(rec.timestamp, updatedAt || Date.now())
    if (!createdAt) createdAt = ms
    updatedAt = Math.max(updatedAt, ms)
  }

  const finalId = importedSessionId("claude-code", sessionId || locatorId)
  const built = recordsToMessages(mainLinear, finalId, projectId)

  // Reconstruct subagents (T2a-sub): each sidechain becomes a `SubagentPart`
  // snapshot attached to its spawning turn PLUS a hidden nested session holding
  // the full inner transcript to drill into.
  const nestedConversations: ImportedConversation[] = []
  for (const group of sidechains) {
    const subagentId = group.rootUuid
    const nestedId = `${finalId}:sub:${subagentId}`
    const nested = recordsToMessages(group.records, nestedId, projectId)
    if (nested.messages.length === 0) continue

    const startedAt = tsToMs(group.records[0]?.timestamp, createdAt || Date.now())
    const completedAt = tsToMs(group.records[group.records.length - 1]?.timestamp, startedAt)

    // Attach the snapshot to the spawning main turn; fall back to the last one.
    const spawnIdx =
      group.spawnParentUuid != null
        ? built.uuidToMessageIndex.get(group.spawnParentUuid)
        : undefined
    const hostMsg =
      spawnIdx != null ? built.messages[spawnIdx] : built.messages[built.messages.length - 1]
    const name = subagentNameFrom(hostMsg) ?? "Subagent"

    const part = buildSubagentSnapshot({
      subagentId,
      parentSessionId: finalId,
      name,
      nestedSessionId: nestedId,
      messages: nested.messages,
      startedAt,
      completedAt,
    })
    if (hostMsg) (hostMsg.parts as unknown[]).push(part)

    const nestedSession = buildSession({
      id: nestedId,
      projectId,
      title: deriveTitle(nested.firstUserText || name, name),
      kind: "subagent",
      suppressSeed: true,
      workingDir: cwd,
      createdAt: startedAt,
      updatedAt: completedAt,
      seedMessages: [],
    })
    nestedConversations.push({ session: nestedSession, messages: nested.messages })
  }

  const title = deriveTitle(built.firstUserText || summary, "Claude Code session")
  const now = Date.now()
  return {
    originalSessionId: sessionId || locatorId,
    cwd,
    model: built.model ?? scanModel,
    title,
    messages: built.messages,
    sidechains,
    nestedConversations,
    createdAt: createdAt || now,
    updatedAt: updatedAt || now,
  }
}

/** Derive a display name for an imported subagent from its spawning Task turn. */
function subagentNameFrom(msg: StoredMessage | undefined): string | undefined {
  if (!msg) return undefined
  for (const p of msg.parts as Array<Record<string, unknown>>) {
    if (p.type !== "tool-Task") continue
    const input = p.input as { subagent_type?: string; description?: string } | undefined
    if (typeof input?.subagent_type === "string" && input.subagent_type) return input.subagent_type
    if (typeof input?.description === "string" && input.description) return input.description
  }
  return undefined
}

/**
 * Turn a linearized record chain into `StoredMessage`s. Shared by the main
 * thread (`parseClaudeTranscript`) and by each subagent's inner transcript
 * (`claude-code-subagent.ts`). Emits `system` records too (previously dropped),
 * patches tool_result blocks onto their tool part (preferring a structured
 * top-level `toolUseResult` when the block content is empty), and captures the
 * first user text for the title. Message ids/sessionIds are final on emit — the
 * chain is already root→leaf so no re-keying is needed.
 */
export function recordsToMessages(
  records: ClaudeLine[],
  sessionIdForParts: string,
  projectId: string | undefined
): {
  messages: StoredMessage[]
  firstUserText: string
  model?: string
  /** Source record uuid → index of the message it produced (for subagent attach). */
  uuidToMessageIndex: Map<string, number>
} {
  const messages: StoredMessage[] = []
  // toolCallId → { messageIndex, partIndex } so a later tool_result patches it.
  const toolIndex = new Map<string, { m: number; p: number }>()
  const uuidToMessageIndex = new Map<string, number>()
  let firstUserText = ""
  let model: string | undefined
  let counter = 0
  const now = Date.now()

  for (const rec of records) {
    if (rec.message?.model && !model) model = rec.message.model
    const ms = tsToMs(rec.timestamp, now)

    // `system` records (hooks, meta, command output) were previously dropped.
    if (rec.type === "system") {
      const sysText = systemText(rec)
      if (!sysText) continue
      messages.push(
        buildMessage({
          sessionId: sessionIdForParts,
          projectId,
          index: counter++,
          role: "system" as StoredMessage["role"],
          parts: [textPart(sysText)],
          createdAt: ms,
        })
      )
      if (rec.uuid) uuidToMessageIndex.set(rec.uuid, messages.length - 1)
      continue
    }
    if (rec.type !== "user" && rec.type !== "assistant") continue

    const role = rec.type
    const blocks = normalizeContent(rec.message?.content)

    // A user record that only carries tool_result blocks patches the prior
    // assistant tool parts instead of emitting a standalone user message.
    const resultBlocks = blocks.filter((b) => b.type === "tool_result")
    const nonResult = blocks.filter((b) => b.type !== "tool_result")

    if (role === "user" && resultBlocks.length > 0) {
      for (const b of resultBlocks) patchToolResult(messages, toolIndex, b, rec.toolUseResult)
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

    if (role === "user" && !firstUserText) firstUserText = plainTextOf(parts)

    const metadata = role === "assistant" ? claudeUsageMeta(rec) : undefined
    messages.push(
      buildMessage({
        sessionId: sessionIdForParts,
        projectId,
        index: counter++,
        role,
        parts,
        createdAt: ms,
        ...(metadata ? { metadata } : {}),
      })
    )
    if (rec.uuid) uuidToMessageIndex.set(rec.uuid, messages.length - 1)
  }

  return { messages, firstUserText, model, uuidToMessageIndex }
}

/** Extract the display text of a `type: "system"` record. */
function systemText(rec: ClaudeLine): string {
  if (typeof rec.content === "string" && rec.content.trim()) return rec.content
  const blocks = normalizeContent(rec.message?.content)
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string" && b.text)
    .map((b) => b.text as string)
    .join("\n")
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
  b: Block,
  toolUseResult?: unknown
): void {
  const id = b.tool_use_id
  if (!id) return
  const loc = toolIndex.get(id)
  if (!loc) return
  const msg = messages[loc.m]
  if (!msg) return
  const part = msg.parts[loc.p] as Record<string, unknown> | undefined
  if (!part) return
  let output = resultToOutput(b.content)
  // Recover the structured top-level result when the block content is empty
  // (Claude Code sometimes leaves the block bare but records rich output here).
  if ((output === "" || output == null) && toolUseResult !== undefined) {
    output = toolUseResult
  }
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
  return {
    session,
    messages: parsed.messages,
    ...(parsed.nestedConversations.length > 0 ? { nested: parsed.nestedConversations } : {}),
  }
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
