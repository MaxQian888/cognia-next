/**
 * Claude Code session-history reader (ADR-0062, ADR-0217).
 *
 * On disk: `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, one JSON record
 * per line. Records carry `type` ("user" | "assistant" | "summary" | "system"),
 * a nested Anthropic `message` with content blocks, and `toolUseResult`. Modern
 * builds also write each subagent's transcript to its own file under
 * `<sessionId>/subagents/`, and agent teams keep `teams/<name>/config.json` and
 * `tasks/<team>/*.json` beside `projects/`.
 *
 * A transcript is a forest, not a list (see
 * `@cognia/agent-runtime-kit/history-dag`): the active-leaf chain of the main
 * thread is the conversation, abandoned edit/re-run branches are dropped, and
 * `isSidechain` records become subagent runs of their own.
 *
 * Content block → part mapping:
 *   text        → text
 *   thinking    → reasoning
 *   tool_use    → tool call (input)
 *   tool_result → the matching call's result (output / error text)
 *   image       → file (data: URL or URL)
 *
 * Pure functions over file content: the host finds and reads the files, builds
 * its subagent cards and rows, and stores nothing here.
 */

import type {
  CanonicalRecordedEvent,
  CanonicalSessionLifecycleStatus,
  CanonicalSessionTask,
  SessionLossEntry,
} from "@cognia/agent-contracts/canonical-session"
import type {
  HistoryDetectVerdict,
  HistoryFormatInfo,
  HistoryMessage,
  HistoryPart,
  HistoryPickedFile,
  HistoryReaderHost,
  HistorySessionSummary,
  HistoryToolPart,
  HistoryUsage,
  ParsedHistorySession,
} from "@cognia/agent-contracts/history"
import {
  deriveTitle,
  historyFile,
  historyReasoning,
  historyText,
  historyTool,
  stringifyToolResult,
} from "@cognia/agent-runtime-kit/history"
import {
  extractSidechains,
  linearizeActiveLeaf,
  splitMainAndSidechain,
  type SidechainGroup,
} from "@cognia/agent-runtime-kit/history-dag"
import { CLAUDE_CODE_SESSION_SOURCE_ID } from "./manifest"

/** The Claude Code version this reader was last verified against. */
export const CLAUDE_CODE_HISTORY_FORMAT: HistoryFormatInfo = Object.freeze({
  sourceId: CLAUDE_CODE_SESSION_SOURCE_ID,
  verifiedVersion: "2.1.251",
  verifiedAt: "2026-08-29",
  acceptedExtensions: Object.freeze([".jsonl"]),
})

/** Anthropic per-turn usage block carried on assistant records. */
export interface ClaudeUsage {
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
  /** Present in the independent transcript written for modern subagents. */
  agentId?: string
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

function tsToMs(ts: string | undefined, fallback: number): number {
  if (!ts) return fallback
  const n = Date.parse(ts)
  return Number.isNaN(n) ? fallback : n
}

/**
 * Usage of one assistant record, or nothing when it carries no token counts.
 * Cost and duration are kept only when the transcript reports them.
 */
function usageFields(rec: ClaudeLine): Pick<HistoryMessage, "usage" | "usageModel"> {
  const u = rec.message?.usage
  if (!u) return {}
  const input = u.input_tokens ?? 0
  const output = u.output_tokens ?? 0
  const cacheCreation = u.cache_creation_input_tokens ?? 0
  const cacheRead = u.cache_read_input_tokens ?? 0
  if (input === 0 && output === 0 && cacheCreation === 0 && cacheRead === 0) return {}
  const usage: HistoryUsage = {
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: cacheCreation,
    cacheReadInputTokens: cacheRead,
    ...(typeof rec.costUSD === "number" ? { totalCostUsd: rec.costUSD } : {}),
    ...(typeof rec.durationMs === "number" ? { durationMs: rec.durationMs } : {}),
  }
  return { usage, ...(rec.message?.model ? { usageModel: rec.message.model } : {}) }
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
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
  if (Array.isArray(content)) return content.filter((b): b is Block => !!b && typeof b === "object")
  return []
}

function blockToPart(b: Block): HistoryPart | null {
  switch (b.type) {
    case "text":
      return typeof b.text === "string" && b.text ? historyText(b.text) : null
    case "thinking":
      return typeof b.thinking === "string" && b.thinking ? historyReasoning(b.thinking) : null
    case "tool_use":
      return historyTool({
        name: b.name || "tool",
        toolCallId: b.id || "unknown",
        input: b.input ?? {},
      })
    case "image": {
      const src = b.source
      if (src?.type === "base64" && src.media_type && src.data) {
        return historyFile({
          mediaType: src.media_type,
          url: `data:${src.media_type};base64,${src.data}`,
        })
      }
      if (src?.url) return historyFile({ mediaType: src.media_type || "image/png", url: src.url })
      return null
    }
    default:
      return null
  }
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

/** Extract the display text of a `type: "system"` record. */
function systemText(rec: ClaudeLine): string {
  if (typeof rec.content === "string" && rec.content.trim()) return rec.content
  return normalizeContent(rec.message?.content)
    .filter((b) => b.type === "text" && typeof b.text === "string" && b.text)
    .map((b) => b.text as string)
    .join("\n")
}

function plainTextOf(parts: readonly HistoryPart[]): string {
  return parts
    .filter((part): part is Extract<HistoryPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join(" ")
}

/** First non-empty text block of a Claude content field (string or block array). */
function firstText(content: unknown): string {
  for (const b of normalizeContent(content)) {
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) return b.text
  }
  return ""
}

/** One linearized record chain as neutral messages. */
export interface ClaudeCodeTurns {
  messages: HistoryMessage[]
  firstUserText: string
  model?: string
  /** Source record uuid → index of the message it produced. */
  uuidToMessageIndex: Map<string, number>
}

/**
 * Turn a linearized record chain into neutral messages. Shared by the main
 * thread and by each subagent's inner transcript. Emits `system` records,
 * resolves tool_result blocks onto their call (preferring a structured
 * top-level `toolUseResult` when the block content is empty), and captures the
 * first user text for the title.
 */
export function claudeCodeRecordsToMessages(records: readonly ClaudeLine[]): ClaudeCodeTurns {
  const messages: HistoryMessage[] = []
  // toolCallId → { messageIndex, partIndex } so a later tool_result resolves it.
  const toolIndex = new Map<string, { m: number; p: number }>()
  const uuidToMessageIndex = new Map<string, number>()
  let firstUserText = ""
  let model: string | undefined
  const now = Date.now()

  const resolveToolResult = (b: Block, toolUseResult: unknown) => {
    const loc = b.tool_use_id ? toolIndex.get(b.tool_use_id) : undefined
    const msg = loc ? messages[loc.m] : undefined
    const part = loc && msg ? (msg.parts[loc.p] as HistoryToolPart | undefined) : undefined
    if (!loc || !msg || !part) return
    let output = resultToOutput(b.content)
    // Recover the structured top-level result when the block content is empty
    // (Claude Code sometimes leaves the block bare but records rich output here).
    if ((output === "" || output == null) && toolUseResult !== undefined) output = toolUseResult
    msg.parts[loc.p] = {
      ...part,
      result: b.is_error
        ? { ok: false, errorText: stringifyToolResult(output) }
        : { ok: true, output },
    }
  }

  for (const rec of records) {
    if (rec.message?.model && !model) model = rec.message.model
    const createdAt = tsToMs(rec.timestamp, now)

    if (rec.type === "system") {
      const text = systemText(rec)
      if (!text) continue
      messages.push({ role: "system", parts: [historyText(text)], createdAt })
      if (rec.uuid) uuidToMessageIndex.set(rec.uuid, messages.length - 1)
      continue
    }
    if (rec.type !== "user" && rec.type !== "assistant") continue

    const role = rec.type
    const blocks = normalizeContent(rec.message?.content)
    // A user record that only carries tool_result blocks resolves the prior
    // assistant tool calls instead of emitting a standalone user message.
    const resultBlocks = blocks.filter((b) => b.type === "tool_result")
    const nonResult = blocks.filter((b) => b.type !== "tool_result")
    if (role === "user" && resultBlocks.length > 0) {
      for (const b of resultBlocks) resolveToolResult(b, rec.toolUseResult)
      if (nonResult.length === 0) continue
    }

    const parts: HistoryPart[] = []
    for (const b of nonResult) {
      const part = blockToPart(b)
      if (!part) continue
      parts.push(part)
      if (b.type === "tool_use" && b.id)
        toolIndex.set(b.id, { m: messages.length, p: parts.length - 1 })
    }
    if (parts.length === 0) continue

    if (role === "user" && !firstUserText) firstUserText = plainTextOf(parts)
    messages.push({
      role,
      parts,
      createdAt,
      ...(role === "assistant" ? usageFields(rec) : {}),
    })
    if (rec.uuid) uuidToMessageIndex.set(rec.uuid, messages.length - 1)
  }

  return { messages, firstUserText, model, uuidToMessageIndex }
}

/** A display name for a subagent from its spawning `Task` call. */
function subagentNameFrom(message: HistoryMessage | undefined): string | undefined {
  for (const part of message?.parts ?? []) {
    if (part.type !== "tool" || part.name !== "Task") continue
    const input = part.input as { subagent_type?: string; description?: string } | undefined
    if (typeof input?.subagent_type === "string" && input.subagent_type) return input.subagent_type
    if (typeof input?.description === "string" && input.description) return input.description
  }
  return undefined
}

/** One sidechain subagent run, read as its own transcript. */
export interface ClaudeCodeSubagentRun {
  /** The sidechain root's uuid. */
  subagentId: string
  /** The main-thread record that spawned the run, when the root links back. */
  spawnParentUuid?: string
  /**
   * Index into the main transcript's messages of the turn the run belongs to:
   * the spawning turn, else the last message; absent when the main thread is
   * empty.
   */
  hostMessageIndex?: number
  /** From the spawning `Task` call (`subagent_type`, then `description`). */
  name: string
  title: string
  messages: HistoryMessage[]
  /** Epoch ms of the run's first and last records. */
  startedAt: number
  completedAt: number
}

/** One parsed transcript file. */
export interface ParsedClaudeCodeTranscript {
  /** The active main thread; `tasks` are the ones its tool calls record. */
  session: ParsedHistorySession
  /** The `agentId` an independent subagent transcript carries. */
  agentId?: string
  /** Raw sidechain groups, each linearized to its own active leaf. */
  sidechains: SidechainGroup<ClaudeLine>[]
  /** The sidechains with a visible transcript, as subagent runs. */
  subagents: ClaudeCodeSubagentRun[]
}

const TRANSCRIPT_TYPES = new Set(["user", "assistant", "system", "summary"])

/**
 * Read one Claude Code transcript. `locatorId` names the session when no
 * record carries an id. Records of any other type are kept as bounded,
 * redacted diagnostic events (through `host.redactText`) and reported as
 * approximated; unparseable lines are reported as dropped.
 */
export function readClaudeCodeTranscript(
  content: string,
  locatorId: string,
  host: HistoryReaderHost
): ParsedClaudeCodeTranscript {
  const records: ClaudeLine[] = []
  const recordedEvents: CanonicalRecordedEvent[] = []
  const losses: SessionLossEntry[] = []
  let eventSequence = 0
  for (const [lineIndex, line] of content.split("\n").entries()) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      records.push(JSON.parse(trimmed) as ClaudeLine)
    } catch {
      losses.push({
        path: `jsonl[${lineIndex}]`,
        kind: "dropped",
        detail: "Unparseable Claude Code transcript record.",
      })
    }
  }

  for (const [recordIndex, rec] of records.entries()) {
    if (TRANSCRIPT_TYPES.has(rec.type ?? "")) continue
    recordedEvents.push({
      eventId: `claude-event-${eventSequence}`,
      sequence: eventSequence++,
      at: rec.timestamp,
      event: {
        kind: "diagnostic",
        runtime: "claude-code",
        payload: {
          type: rec.type ?? "unknown",
          summary: host.redactText(JSON.stringify(rec)).slice(0, 2_000),
        },
      },
    })
    losses.push({
      path: `records[${recordIndex}].${rec.type ?? "unknown"}`,
      kind: "approximated",
      detail: "Preserved as a bounded redacted diagnostic event.",
    })
  }

  const { main } = splitMainAndSidechain(records)
  const mainLinear = linearizeActiveLeaf(main)
  const sidechains = extractSidechains(records)

  // Metadata scan over ALL records — sessionId/cwd/model can appear on any
  // record, and updatedAt reflects the latest activity (incl. sidechains).
  let sessionId = ""
  let agentId = ""
  let cwd: string | undefined
  let scanModel: string | undefined
  let summary = ""
  let createdAt = 0
  let updatedAt = 0
  for (const rec of records) {
    if (rec.sessionId && !sessionId) sessionId = rec.sessionId
    if (rec.agentId && !agentId) agentId = rec.agentId
    if (rec.cwd && !cwd) cwd = rec.cwd
    if (rec.message?.model && !scanModel) scanModel = rec.message.model
    if (rec.type === "summary" && typeof rec.summary === "string" && !summary) summary = rec.summary
    const ms = tsToMs(rec.timestamp, updatedAt || Date.now())
    if (!createdAt) createdAt = ms
    updatedAt = Math.max(updatedAt, ms)
  }

  const built = claudeCodeRecordsToMessages(mainLinear)
  const subagents: ClaudeCodeSubagentRun[] = []
  for (const group of sidechains) {
    const nested = claudeCodeRecordsToMessages(group.records)
    if (nested.messages.length === 0) continue
    const startedAt = tsToMs(group.records[0]?.timestamp, createdAt || Date.now())
    const completedAt = tsToMs(group.records[group.records.length - 1]?.timestamp, startedAt)
    const spawnIndex =
      group.spawnParentUuid != null
        ? built.uuidToMessageIndex.get(group.spawnParentUuid)
        : undefined
    const hostMessageIndex =
      spawnIndex ?? (built.messages.length > 0 ? built.messages.length - 1 : undefined)
    const name =
      subagentNameFrom(
        hostMessageIndex !== undefined ? built.messages[hostMessageIndex] : undefined
      ) ?? "Subagent"
    subagents.push({
      subagentId: group.rootUuid,
      ...(group.spawnParentUuid !== undefined ? { spawnParentUuid: group.spawnParentUuid } : {}),
      ...(hostMessageIndex !== undefined ? { hostMessageIndex } : {}),
      name,
      title: deriveTitle(nested.firstUserText || name, name),
      messages: nested.messages,
      startedAt,
      completedAt,
    })
  }

  const now = Date.now()
  return {
    session: {
      sourceId: CLAUDE_CODE_SESSION_SOURCE_ID,
      originalSessionId: agentId || sessionId || locatorId,
      cwd,
      model: built.model ?? scanModel,
      title: deriveTitle(built.firstUserText || summary, "Claude Code session"),
      messages: built.messages,
      createdAt: createdAt || now,
      updatedAt: updatedAt || now,
      goals: [],
      plans: [],
      tasks: claudeCodeTranscriptTasks(built.messages),
      history: [],
      interAgentMessages: [],
      recordedEvents,
      losses,
    },
    ...(agentId ? { agentId } : {}),
    sidechains,
    subagents,
  }
}

// ============================================================================
// Tasks and teams
// ============================================================================

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

/** A task or member status string as a canonical lifecycle status. */
export function claudeCodeTaskStatus(value: unknown): CanonicalSessionLifecycleStatus {
  const status = stringValue(value)?.toLowerCase()
  if (status === "completed" || status === "done") return "completed"
  if (status === "failed" || status === "error") return "failed"
  if (status === "cancelled" || status === "canceled") return "cancelled"
  if (status === "pending") return "pending"
  if (status === "waiting" || status === "blocked") return "waiting"
  return "running"
}

const TASK_TOOLS = new Set(["Task", "TaskCreate", "TaskUpdate", "TaskOutput"])

/** The tasks a transcript's `Task*` tool calls record, latest call winning per task. */
export function claudeCodeTranscriptTasks(
  messages: readonly HistoryMessage[]
): CanonicalSessionTask[] {
  const tasks = new Map<string, CanonicalSessionTask>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || !TASK_TOOLS.has(part.name)) continue
      const input = record(part.input) ?? {}
      const taskId =
        stringValue(input.task_id) ||
        stringValue(input.taskId) ||
        stringValue(input.agent_id) ||
        stringValue(part.toolCallId)
      if (!taskId) continue
      const existing = tasks.get(taskId)
      const background =
        input.run_in_background === true || input.background === true || existing?.background
      tasks.set(taskId, {
        taskId,
        description:
          stringValue(input.description) || stringValue(input.subject) || existing?.description,
        summary: stringValue(input.activeForm) || existing?.summary,
        status:
          part.result?.ok === false
            ? "failed"
            : claudeCodeTaskStatus(
                input.status ?? (part.result?.ok === true ? "completed" : "running")
              ),
        ...(background ? { background: true } : {}),
        toolCallId: stringValue(part.toolCallId) || existing?.toolCallId,
        parentTaskId: stringValue(input.parent_task_id) || existing?.parentTaskId,
        dependencies: Array.isArray(input.blockedBy)
          ? input.blockedBy.filter((item): item is string => typeof item === "string")
          : existing?.dependencies,
      })
    }
  }
  return [...tasks.values()]
}

/** One JSON artifact the host read under `~/.claude/teams` or `~/.claude/tasks`. */
export interface ClaudeCodeTeamArtifact {
  path: string
  value: Record<string, unknown>
}

export interface ClaudeCodeTeamCorpus {
  /** `teams/<name>/config.json` files. */
  configs: readonly ClaudeCodeTeamArtifact[]
  /** Every `tasks/**.json` file. */
  taskFiles: readonly ClaudeCodeTeamArtifact[]
}

export interface ClaudeCodeTeamSnapshot {
  members: Array<Record<string, unknown>>
  tasks: CanonicalSessionTask[]
  /** Task id → its owner (a member name or agent id). */
  taskOwnerById: Map<string, string>
}

/** The file name without directories and `.jsonl`. */
export function claudeCodeFileStem(locator: string): string {
  const name = locator.replace(/\\/g, "/").split("/").pop() ?? locator
  return name.replace(/\.jsonl$/i, "")
}

/**
 * The team a session leads or belongs to, from the team artifacts: a config
 * matches when its lead session, its cwd or one of its members' sessions is
 * this one. Its members are returned as recorded, and its tasks are the task
 * files under `tasks/<team>/`.
 */
export function claudeCodeTeamSnapshot(
  corpus: ClaudeCodeTeamCorpus,
  nativeSessionId: string,
  cwd?: string
): ClaudeCodeTeamSnapshot {
  const matching = corpus.configs.filter(({ value }) => {
    if (stringValue(value.leadSessionId) === nativeSessionId) return true
    if (cwd && stringValue(value.cwd) === cwd) return true
    return Array.isArray(value.members)
      ? value.members.some((member) => stringValue(record(member)?.sessionId) === nativeSessionId)
      : false
  })
  if (matching.length === 0) return { members: [], tasks: [], taskOwnerById: new Map() }

  const members = matching.flatMap(({ value }) =>
    Array.isArray(value.members) ? value.members.map(record).filter(Boolean) : []
  ) as Array<Record<string, unknown>>
  const teamNames = new Set(
    matching
      .map(
        ({ path, value }) => stringValue(value.name) || path.replace(/\\/g, "/").split("/").at(-2)
      )
      .filter((name): name is string => Boolean(name))
  )
  const taskOwnerById = new Map<string, string>()
  const tasks = corpus.taskFiles
    .filter(({ path }) =>
      [...teamNames].some((team) => path.replace(/\\/g, "/").includes(`/tasks/${team}/`))
    )
    .map(({ value, path }) => {
      const taskId = stringValue(value.id) || claudeCodeFileStem(path.replace(/\.json$/i, ".jsonl"))
      const owner = stringValue(value.owner)
      if (owner) taskOwnerById.set(taskId, owner)
      return {
        taskId,
        description: stringValue(value.description) || stringValue(value.subject),
        summary: stringValue(value.activeForm),
        status: claudeCodeTaskStatus(value.status),
        background: value.background === true || undefined,
        parentTaskId: stringValue(value.parentTaskId),
        dependencies: Array.isArray(value.blockedBy)
          ? value.blockedBy.filter((item): item is string => typeof item === "string")
          : undefined,
      }
    })
  return { members, tasks, taskOwnerById }
}

// ============================================================================
// Summaries and detection
// ============================================================================

/** Whether a transcript path is an independent subagent file (`…/subagents/…`). */
export function isClaudeCodeSubagentTranscript(locator: string): boolean {
  return locator.replace(/\\/g, "/").includes("/subagents/")
}

/**
 * Cheap single-pass summary of a transcript — title, count, timestamps and cwd
 * WITHOUT resolving the DAG or building messages. `messageCount` is the raw
 * user/assistant record count, so it is approximate: abandoned edit/re-run
 * branches and sidechains are still counted.
 */
export function summarizeClaudeCodeTranscript(
  content: string,
  locator: string
): HistorySessionSummary | null {
  let sessionId = ""
  let agentId = ""
  let cwd: string | undefined
  let summary = ""
  let firstUserText = ""
  let createdAt = 0
  let updatedAt = 0
  let count = 0
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec: ClaudeLine
    try {
      rec = JSON.parse(trimmed) as ClaudeLine
    } catch {
      continue
    }
    if (rec.sessionId && !sessionId) sessionId = rec.sessionId
    if (rec.agentId && !agentId) agentId = rec.agentId
    if (rec.cwd && !cwd) cwd = rec.cwd
    if (rec.type === "summary" && typeof rec.summary === "string" && !summary) summary = rec.summary
    if (rec.timestamp) {
      const ms = Date.parse(rec.timestamp)
      if (!Number.isNaN(ms)) {
        if (!createdAt) createdAt = ms
        if (ms > updatedAt) updatedAt = ms
      }
    }
    if (rec.type === "user" || rec.type === "assistant") {
      count += 1
      if (rec.type === "user" && !firstUserText) firstUserText = firstText(rec.message?.content)
    }
  }
  if (count === 0) return null
  const independentSubagent = isClaudeCodeSubagentTranscript(locator)
  return {
    sourceId: CLAUDE_CODE_SESSION_SOURCE_ID,
    originalSessionId:
      agentId ||
      (independentSubagent ? claudeCodeFileStem(locator) : undefined) ||
      sessionId ||
      locator,
    title: deriveTitle(firstUserText || summary, "Claude Code session"),
    messageCount: count,
    updatedAt: updatedAt || createdAt || Date.now(),
    cwd,
    relationKind: independentSubagent ? "subagent" : undefined,
    sourceVersion: CLAUDE_CODE_HISTORY_FORMAT.verifiedVersion,
  }
}

/**
 * Whether picked files are Claude Code transcripts: every file under
 * `.claude/projects` matches, some of them maybe; otherwise a first record
 * with a top-level `parentUuid` and a nested message is a maybe.
 */
export function detectClaudeCodeTranscripts(
  files: readonly HistoryPickedFile[]
): HistoryDetectVerdict {
  if (files.length === 0) return "no"
  const hinted = files.filter((f) => f.path.replace(/\\/g, "/").includes(".claude/projects"))
  if (hinted.length > 0) return hinted.length === files.length ? "match" : "maybe"
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
}
