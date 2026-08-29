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
import type { StoredMessage } from "@cognia/agent-config-types"
import { walkFiles } from "../fs"
import { scanFileSummaries } from "../scan"
import { buildImportedSessionGraph } from "../graph"
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
import type {
  CanonicalRecordedEvent,
  CanonicalSessionLifecycleStatus,
  CanonicalSessionTask,
  SessionLossEntry,
} from "@cognia/agent-config-types/canonical-session"
import { redactText } from "@cognia/redact"

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
  agentId?: string
  recordedEvents: CanonicalRecordedEvent[]
  losses: SessionLossEntry[]
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
  const recordedEvents: CanonicalRecordedEvent[] = []
  const losses: SessionLossEntry[] = []
  let eventSequence = 0
  for (const [lineIndex, line] of lines.entries()) {
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
    if (["user", "assistant", "system", "summary"].includes(rec.type ?? "")) continue
    const redacted = redactText(JSON.stringify(rec)).redacted.slice(0, 2_000)
    recordedEvents.push({
      eventId: `claude-event-${eventSequence}`,
      sequence: eventSequence++,
      at: rec.timestamp,
      event: {
        kind: "diagnostic",
        runtime: "claude-code",
        payload: { type: rec.type ?? "unknown", summary: redacted },
      },
    })
    losses.push({
      path: `records[${recordIndex}].${rec.type ?? "unknown"}`,
      kind: "approximated",
      detail: "Preserved as a bounded redacted diagnostic event.",
    })
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
    if (rec.type === "summary" && typeof rec.summary === "string" && !summary) {
      summary = rec.summary
    }
    const ms = tsToMs(rec.timestamp, updatedAt || Date.now())
    if (!createdAt) createdAt = ms
    updatedAt = Math.max(updatedAt, ms)
  }

  const nativeSessionId = agentId || sessionId || locatorId
  const finalId = importedSessionId("claude-code", nativeSessionId)
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
    nestedSession.parentSessionId = finalId
    nestedSession.importRelation = {
      kind: "subagent",
      parentToolCallId: group.spawnParentUuid ?? undefined,
    }
    nestedSession.importRuntimeBinding = {
      presetId: "claude-code",
      nativeSessionId: subagentId,
      cwd,
    }
    nestedConversations.push({ session: nestedSession, messages: nested.messages })
  }

  const title = deriveTitle(built.firstUserText || summary, "Claude Code session")
  const now = Date.now()
  return {
    originalSessionId: nativeSessionId,
    cwd,
    model: built.model ?? scanModel,
    title,
    messages: built.messages,
    sidechains,
    nestedConversations,
    createdAt: createdAt || now,
    updatedAt: updatedAt || now,
    agentId: agentId || undefined,
    recordedEvents,
    losses,
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

/** First non-empty text block of a Claude content field (string or block array). */
function firstText(content: unknown): string {
  for (const b of normalizeContent(content)) {
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) return b.text
  }
  return ""
}

/**
 * Cheap single-pass summary of a Claude Code transcript — pulls title, count,
 * timestamps and cwd WITHOUT resolving the DAG, building any `StoredMessage`, or
 * reconstructing subagents (all of which `parseClaudeTranscript` does and the
 * scan throws away). `messageCount` is the raw user/assistant record count, so
 * it's approximate: it doesn't drop abandoned edit/re-run branches or split out
 * sidechains — that precision is only worth paying at import time.
 */
export function summarizeClaudeFile(content: string, locator: string): SessionSummary | null {
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
  const independentSubagent = isIndependentSubagentPath(locator)
  return {
    ref: {
      sourceId: "claude-code",
      originalSessionId:
        agentId || (independentSubagent ? fileStem(locator) : undefined) || sessionId || locator,
      locator,
    },
    title: deriveTitle(firstUserText || summary, "Claude Code session"),
    sourceId: "claude-code",
    messageCount: count,
    updatedAt: updatedAt || createdAt || Date.now(),
    cwd,
    relationKind: independentSubagent ? "subagent" : undefined,
    sourceVersion: claudeCodeSessionSource.verifiedVersion,
  }
}

function isIndependentSubagentPath(locator: string): boolean {
  return locator.replace(/\\/g, "/").includes("/subagents/")
}

function fileStem(locator: string): string {
  const name = locator.replace(/\\/g, "/").split("/").pop() ?? locator
  return name.replace(/\.jsonl$/i, "")
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
  session.importRuntimeBinding = {
    presetId: "claude-code",
    nativeSessionId: parsed.originalSessionId,
    cwd: parsed.cwd,
  }
  return {
    session,
    messages: parsed.messages,
    ...(parsed.nestedConversations.length > 0 ? { nested: parsed.nestedConversations } : {}),
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function taskStatus(value: unknown): CanonicalSessionLifecycleStatus {
  const status = stringValue(value)?.toLowerCase()
  if (status === "completed" || status === "done") return "completed"
  if (status === "failed" || status === "error") return "failed"
  if (status === "cancelled" || status === "canceled") return "cancelled"
  if (status === "pending") return "pending"
  if (status === "waiting" || status === "blocked") return "waiting"
  return "running"
}

function tasksFromTranscript(conversation: ImportedConversation): CanonicalSessionTask[] {
  const tasks = new Map<string, CanonicalSessionTask>()
  for (const message of conversation.messages) {
    for (const rawPart of message.parts as Array<Record<string, unknown>>) {
      if (!rawPart.type?.toString().startsWith("tool-")) continue
      const toolName = rawPart.type.toString().slice(5)
      if (!["Task", "TaskCreate", "TaskUpdate", "TaskOutput"].includes(toolName)) continue
      const input = record(rawPart.input) ?? {}
      const taskId =
        stringValue(input.task_id) ||
        stringValue(input.taskId) ||
        stringValue(input.agent_id) ||
        stringValue(rawPart.toolCallId)
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
          rawPart.state === "output-error"
            ? "failed"
            : taskStatus(
                input.status ?? (rawPart.state === "output-available" ? "completed" : "running")
              ),
        ...(background ? { background: true } : {}),
        toolCallId: stringValue(rawPart.toolCallId) || existing?.toolCallId,
        parentTaskId: stringValue(input.parent_task_id) || existing?.parentTaskId,
        dependencies: Array.isArray(input.blockedBy)
          ? input.blockedBy.filter((item): item is string => typeof item === "string")
          : existing?.dependencies,
      })
    }
  }
  return [...tasks.values()]
}

interface ClaudeTeamSnapshot {
  members: Array<Record<string, unknown>>
  tasks: CanonicalSessionTask[]
  taskOwnerById: Map<string, string>
}

async function readJsonFiles(
  input: SessionScanInput,
  root: string,
  accept: (path: string) => boolean
): Promise<Array<{ path: string; value: Record<string, unknown> }>> {
  const values: Array<{ path: string; value: Record<string, unknown> }> = []
  const picked = input.pickedFiles?.filter((file) => accept(file.path))
  if (picked?.length) {
    for (const file of picked) {
      try {
        const value = record(JSON.parse(file.content))
        if (value) values.push({ path: file.path, value })
      } catch {
        // The graph fidelity report covers malformed optional artifacts through
        // the missing structured state; the parent transcript remains usable.
      }
    }
    return values
  }
  if (!(await input.fs.exists(root))) return values
  const files = await walkFiles(input.fs, root, (name) => accept(name))
  for (const path of files) {
    try {
      const value = record(JSON.parse(await input.fs.readTextFile(path)))
      if (value) values.push({ path, value })
    } catch {
      // One team/task artifact must not sink the transcript import.
    }
  }
  return values
}

async function loadClaudeTeamSnapshot(
  input: SessionScanInput,
  nativeSessionId: string,
  cwd?: string
): Promise<ClaudeTeamSnapshot> {
  const base = input.roots?.claudeConfigDir || (input.home ? joinPath(input.home, ".claude") : "")
  if (!base && !input.pickedFiles?.length) {
    return { members: [], tasks: [], taskOwnerById: new Map() }
  }
  const configs = await readJsonFiles(
    input,
    joinPath(base, "teams"),
    (path) => path.replace(/\\/g, "/").includes("/teams/") && path.endsWith("config.json")
  )
  const matching = configs.filter(({ value }) => {
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
      .map(({ path, value }) => {
        const parts = path.replace(/\\/g, "/").split("/")
        return stringValue(value.name) || parts.at(-2)
      })
      .filter((name): name is string => Boolean(name))
  )
  const taskFiles = await readJsonFiles(
    input,
    joinPath(base, "tasks"),
    (path) =>
      path.toLowerCase().endsWith(".json") &&
      [...teamNames].some((team) => path.replace(/\\/g, "/").includes(`/tasks/${team}/`))
  )
  const taskOwnerById = new Map<string, string>()
  const tasks = taskFiles.map(({ value, path }) => {
    const taskId = stringValue(value.id) || fileStem(path.replace(/\.json$/i, ".jsonl"))
    const owner = stringValue(value.owner)
    if (owner) taskOwnerById.set(taskId, owner)
    return {
      taskId,
      description: stringValue(value.description) || stringValue(value.subject),
      summary: stringValue(value.activeForm),
      status: taskStatus(value.status),
      background: value.background === true || undefined,
      parentTaskId: stringValue(value.parentTaskId),
      dependencies: Array.isArray(value.blockedBy)
        ? value.blockedBy.filter((item): item is string => typeof item === "string")
        : undefined,
    }
  })
  return { members, tasks, taskOwnerById }
}

function addTeamMembers(
  root: ImportedConversation,
  snapshot: ClaudeTeamSnapshot,
  parsed: ParsedSession
): void {
  const nested = root.nested ?? []
  const existingNativeIds = new Set(
    nested.map((child) => child.session.importRuntimeBinding?.nativeSessionId).filter(Boolean)
  )
  for (const member of snapshot.members) {
    const nativeId =
      stringValue(member.sessionId) || stringValue(member.agentId) || stringValue(member.name)
    if (!nativeId || nativeId === parsed.originalSessionId || existingNativeIds.has(nativeId))
      continue
    const memberName = stringValue(member.name)
    const memberAgentId = stringValue(member.agentId)
    const ownedTask = snapshot.tasks.find((task) => {
      const owner = snapshot.taskOwnerById.get(task.taskId)
      return owner === memberName || owner === memberAgentId
    })
    const id = importedSessionId("claude-code", nativeId)
    const session = buildSession({
      id,
      title: memberName || nativeId,
      kind: "subagent",
      suppressSeed: true,
      workingDir: stringValue(member.cwd) || parsed.cwd,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      seedMessages: [],
    })
    session.parentSessionId = root.session.id
    session.importRelation = {
      kind: "team-member",
      parentNativeSessionId: parsed.originalSessionId,
      ...(ownedTask ? { taskId: ownedTask.taskId } : {}),
    }
    session.importLifecycle = {
      status: ownedTask?.status ?? taskStatus(member.status),
      background: true,
    }
    session.importRuntimeBinding = {
      presetId: "claude-code",
      nativeSessionId: nativeId,
      cwd: stringValue(member.cwd) || parsed.cwd,
    }
    nested.push({ session, messages: [] })
  }
  if (nested.length > 0) root.nested = nested
}

import { claudeCodeCodec } from "@/lib/session-import/codecs/claude-code-codec"

export const claudeCodeSessionSource: AgentSessionSourceAdapter = {
  codec: claudeCodeCodec,
  id: "claude-code",
  displayName: "Claude Code",
  labelKey: "claude-code",
  verifiedVersion: "2.1.251",
  verifiedAt: "2026-08-29",
  acceptedExtensions: ACCEPTED,

  // `$CLAUDE_CONFIG_DIR` relocates the whole tree; `roots` carries it (the
  // renderer can't read env vars — see `lib/agent-roots/`).
  scanRoots(home, roots) {
    const base = roots?.claudeConfigDir || (home ? joinPath(home, ".claude") : "")
    return base ? [joinPath(base, "projects")] : []
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

  summarizeFile: summarizeClaudeFile,

  async listSessions(input: SessionScanInput) {
    const summaries = await scanFileSummaries(
      input,
      this.scanRoots(input.home, input.roots),
      (n) => n.toLowerCase().endsWith(".jsonl"),
      summarizeClaudeFile
    )
    return summaries.filter((summary) => summary.relationKind !== "subagent")
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
    const conversation = toConversation(parsed)
    const childArtifacts: Array<{ content: string; locator: string }> = []
    const addChildArtifacts = (): ImportedConversation[] => {
      const grouped = new Map<string, ParsedSession[]>()
      for (const artifact of childArtifacts) {
        const child = parseClaudeTranscript(artifact.content, artifact.locator)
        const existing = grouped.get(child.originalSessionId)
        if (existing) existing.push(child)
        else grouped.set(child.originalSessionId, [child])
      }
      return [...grouped.values()].flatMap((segments) => {
        const ordered = segments.toSorted((a, b) => a.createdAt - b.createdAt)
        const first = ordered[0]
        if (!first) return []
        const nestedId = importedSessionId("claude-code", first.originalSessionId)
        const messages = ordered
          .flatMap((segment) => segment.messages)
          .map((message, index) => ({
            ...message,
            id: importedMessageId(nestedId, index),
            sessionId: nestedId,
          }))
        if (messages.length === 0) return []
        const nested = toConversation({
          ...first,
          messages,
          nestedConversations: ordered.flatMap((segment) => segment.nestedConversations),
          updatedAt: Math.max(...ordered.map((segment) => segment.updatedAt)),
        })
        nested.session.kind = "subagent"
        nested.session.branchSeed = undefined
        nested.session.parentSessionId = conversation.session.id
        nested.session.importRelation = {
          kind: "subagent",
          parentNativeSessionId: parsed.originalSessionId,
        }
        nested.session.importRuntimeBinding = {
          presetId: "claude-code",
          nativeSessionId: first.originalSessionId,
          cwd: first.cwd,
        }
        return [nested]
      })
    }

    if (input.pickedFiles?.length) {
      const childPrefix = `${ref.locator.replace(/\.jsonl$/i, "")}/subagents/`.replace(/\\/g, "/")
      for (const file of input.pickedFiles) {
        if (file.path.replace(/\\/g, "/").startsWith(childPrefix)) {
          childArtifacts.push({ content: file.content, locator: file.path })
        }
      }
    } else {
      const childDir = joinPath(ref.locator.replace(/\.jsonl$/i, ""), "subagents")
      if (await input.fs.exists(childDir)) {
        const files = await walkFiles(input.fs, childDir, (name) =>
          name.toLowerCase().endsWith(".jsonl")
        )
        for (const file of files) {
          try {
            childArtifacts.push({ content: await input.fs.readTextFile(file), locator: file })
          } catch {
            // Preserve the parent and other children if one transcript is corrupt.
          }
        }
      }
    }

    const independent = addChildArtifacts()
    if (independent.length > 0) {
      conversation.nested = [...(conversation.nested ?? []), ...independent]
    }
    return conversation
  },
  async parseGraph(ref: SessionRef, input: SessionScanInput) {
    const conversation = await this.parseSession(ref, input)
    const content = input.pickedFiles?.length
      ? (input.pickedFiles.find((file) => file.path === ref.locator)?.content ?? "")
      : await input.fs.readTextFile(ref.locator)
    const parsed = parseClaudeTranscript(content, ref.locator)
    const snapshot = await loadClaudeTeamSnapshot(input, parsed.originalSessionId, parsed.cwd)
    addTeamMembers(conversation, snapshot, parsed)
    const transcriptTasks = tasksFromTranscript(conversation)
    const tasks = new Map(
      [...transcriptTasks, ...snapshot.tasks].map((task) => [task.taskId, task])
    )
    conversation.session.importCanonicalState = {
      ...(conversation.session.importCanonicalState ?? {}),
      ...(tasks.size > 0 ? { tasks: [...tasks.values()] } : {}),
    }
    for (const child of conversation.nested ?? []) {
      const nativeId = child.session.importRuntimeBinding?.nativeSessionId
      const task = nativeId ? tasks.get(nativeId) : undefined
      if (task?.background) {
        child.session.importRelation = {
          ...(child.session.importRelation ?? { kind: "background" }),
          kind: "background",
          taskId: task.taskId,
        }
        child.session.importLifecycle = { status: task.status, background: true }
      }
    }
    const graph = buildImportedSessionGraph(conversation, {
      sourceRuntime: this.id,
      sourceVersion: this.verifiedVersion,
      verifiedAt: this.verifiedAt,
      importFidelity: this.codec?.importFidelity ?? "structured",
      codec: this.codec,
    })
    const root = graph.nodes[0]
    if (root) {
      if (parsed.recordedEvents.length > 0) root.session.recordedEvents = parsed.recordedEvents
      root.loss.losses.push(...parsed.losses)
    }
    return graph
  },
}
