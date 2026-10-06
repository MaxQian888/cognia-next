/** OMP 18.6.1 session-entries/session-persistence format; no filesystem or runtime imports. */
import type {
  HistoryDetectVerdict,
  HistoryFormatInfo,
  HistoryMessage,
  HistoryPart,
  HistoryPickedFile,
  HistoryReaderHost,
  HistorySessionSummary,
  HistoryUsage,
  ParsedHistorySession,
} from "@cognia/agent-contracts/history"
import {
  boundedDiagnostic,
  deriveTitle,
  historyFile,
  historyReasoning,
  historyText,
  historyTool,
  stringifyToolResult,
} from "@cognia/agent-runtime-kit/history"
import { linearizeActiveLeaf } from "@cognia/agent-runtime-kit/history-dag"
import { OMP_SESSION_SOURCE_ID } from "./manifest"

export const OMP_HISTORY_FORMAT: HistoryFormatInfo = Object.freeze({
  sourceId: OMP_SESSION_SOURCE_ID,
  verifiedVersion: "18.6.1",
  verifiedAt: "2026-10-06",
  acceptedExtensions: Object.freeze([".jsonl"]),
})
export const OMP_SUPPORTED_SESSION_VERSIONS: ReadonlySet<number> = new Set([1, 2, 3])
type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {}
}
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}
function time(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Date.parse(str(value) ?? "")
  return Number.isFinite(n) && Math.abs(n) <= 8_640_000_000_000_000 ? n : fallback
}
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}
export class OmpHistoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OmpHistoryError"
  }
}
export interface OmpHistoryOptions {
  /** Host-provided blob contents only; the reader never resolves a path or reads a file. */
  blobs?: ReadonlyMap<string, { data: string; mimeType?: string }>
}
export interface OmpHistoryBranch {
  leafId: string
  session: ParsedHistorySession
}
export interface ParsedOmpHistory {
  session: ParsedHistorySession
  branches: OmpHistoryBranch[]
  sessionVersion: number
  forkedFrom?: string
}

function parseFile(content: string) {
  const entries: RecordValue[] = []
  let header: RecordValue | undefined
  let title: string | undefined
  let corruptLines = 0
  for (const line of content.split("\n")) {
    if (!line.trim()) continue
    try {
      const value: unknown = JSON.parse(line)
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        corruptLines++
        continue
      }
      const row = value as RecordValue
      if (row.type === "title") {
        title = str(row.title)
        continue
      }
      if (row.type === "session") {
        if (!header) header = row
        else corruptLines++
        continue
      }
      entries.push(row)
    } catch {
      corruptLines++
    }
  }
  if (!header) throw new OmpHistoryError("Missing OMP session header")
  const version = header.version ?? 1
  if (typeof version !== "number" || !OMP_SUPPORTED_SESSION_VERSIONS.has(version))
    throw new OmpHistoryError("Unsupported OMP session version")
  return { header, entries, title, corruptLines, version }
}
function usage(value: unknown): HistoryUsage | undefined {
  const u = record(value)
  if (!Object.keys(u).length) return undefined
  const cost = record(u.cost).total ?? u.cost
  return {
    inputTokens: num(u.input),
    outputTokens: num(u.output),
    cacheReadInputTokens: num(u.cacheRead),
    cacheCreationInputTokens: num(u.cacheWrite),
    ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0
      ? { totalCostUsd: cost }
      : {}),
    ...(typeof u.reasoning === "number" ? { reasoningTokens: num(u.reasoning) } : {}),
  }
}
function parentId(value: unknown): string | undefined {
  const p = str(value)
  if (!p) return undefined
  if (!/[\\/]/.test(p)) return p
  const name = p
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/\.jsonl$/i, "")
  // Managed session filenames prefix their UUID with a timestamp.
  return (
    name?.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1] ?? name
  )
}
function chainToLeaf(entries: RecordValue[], leaf: string): RecordValue[] {
  const index = new Map(entries.filter((e) => str(e.id)).map((e) => [e.id as string, e]))
  const chain: RecordValue[] = []
  const seen = new Set<string>()
  let cursor: string | undefined = leaf
  while (cursor && index.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor)
    const e = index.get(cursor)!
    chain.push(e)
    cursor = str(e.parentId)
  }
  return chain.reverse()
}
function buildSession(
  chain: RecordValue[],
  header: RecordValue,
  locator: string,
  title: string | undefined,
  host: HistoryReaderHost,
  options: OmpHistoryOptions
): ParsedHistorySession {
  const createdAt = time(header.timestamp)
  const session: ParsedHistorySession = {
    sourceId: OMP_SESSION_SOURCE_ID,
    originalSessionId: str(header.id) ?? locator,
    cwd: str(header.cwd),
    title: title ?? str(header.title) ?? "OMP session",
    messages: [],
    createdAt,
    updatedAt: createdAt,
    sourceVersion: String(header.version ?? 1),
    goals: [],
    plans: [],
    tasks: [],
    history: [],
    interAgentMessages: [],
    recordedEvents: [],
    losses: [],
    ...(header.parentSession
      ? { relationKind: "fork", parentNativeSessionId: parentId(header.parentSession) }
      : {}),
  }
  const tools = new Map<string, { message: HistoryMessage; index: number }>()
  const loss = (
    path: string,
    detail: string,
    kind: "dropped" | "summarized" | "approximated" = "approximated"
  ) => session.losses.push({ path, kind, detail })
  const diagnostic = (entry: RecordValue, reason: string) => {
    session.recordedEvents.push({
      eventId: `omp-${session.recordedEvents.length}`,
      sequence: session.recordedEvents.length,
      ...(str(entry.timestamp) ? { at: str(entry.timestamp) } : {}),
      event: {
        kind: "diagnostic",
        runtime: OMP_SESSION_SOURCE_ID,
        payload: boundedDiagnostic(entry, host),
      },
    })
    loss("entries.metadata", reason, "summarized")
  }
  const retainExtra = (value: RecordValue, mappedKeys: string[], detail: string) => {
    const extra = Object.fromEntries(
      Object.entries(value).filter(([key]) => !mappedKeys.includes(key))
    )
    if (Object.keys(extra).length) diagnostic(extra, detail)
  }
  const mapUsage = (value: unknown) => {
    const raw = record(value)
    retainExtra(
      raw,
      ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens", "cost"],
      "Additional usage metrics retained as a bounded diagnostic."
    )
    retainExtra(
      record(raw.cost),
      ["total"],
      "Per-category cost metrics retained as a bounded diagnostic."
    )
    return usage(value)
  }
  const parts = (content: unknown): HistoryPart[] => {
    if (typeof content === "string") return [historyText(content)]
    if (!Array.isArray(content)) {
      if (content !== undefined)
        diagnostic({ content }, "Malformed content retained as a bounded diagnostic.")
      return []
    }
    return content.flatMap((raw): HistoryPart[] => {
      const block = record(raw)
      const extra = Object.fromEntries(
        Object.entries(block).filter(
          ([key]) =>
            !["type", "text", "thinking", "id", "name", "arguments", "data", "mimeType"].includes(
              key
            )
        )
      )
      if (Object.keys(extra).length)
        diagnostic(extra, "Provider content metadata retained as a bounded diagnostic.")
      if (block.type === "text" && typeof block.text === "string") return [historyText(block.text)]
      if (block.type === "thinking" && typeof block.thinking === "string")
        return [historyReasoning(block.thinking)]
      if (block.type === "toolCall" && typeof block.id === "string")
        return [
          historyTool({
            name: str(block.name) ?? "unknown",
            toolCallId: block.id,
            input: block.arguments,
          }),
        ]
      if (block.type === "image") {
        let data = str(block.data)
        let mediaType = str(block.mimeType) ?? "image/png"
        if (data?.startsWith("blob:")) {
          const resolved = options.blobs?.get(data)
          if (resolved) {
            data = resolved.data
            mediaType = resolved.mimeType ?? mediaType
          } else {
            diagnostic(block, "External image blob reference requires host-supplied bytes.")
            loss(
              "entries.image.blob",
              "Blob bytes were unavailable; reference retained in the diagnostic.",
              "dropped"
            )
            return []
          }
        }
        if (data) return [historyFile({ mediaType, url: `data:${mediaType};base64,${data}` })]
      }
      diagnostic(block, "Unmapped content block retained as a bounded diagnostic.")
      return []
    })
  }
  const setTodos = (phases: unknown, at?: string) => {
    if (!Array.isArray(phases)) return
    session.tasks = []
    session.plans = []
    for (const [phaseIndex, raw] of phases.entries()) {
      const phase = record(raw)
      if (!Array.isArray(phase.tasks)) {
        diagnostic(phase, "Malformed todo phase retained as a diagnostic.")
        continue
      }
      const steps: string[] = []
      for (const [taskIndex, taskRaw] of phase.tasks.entries()) {
        const task = record(taskRaw)
        const description = str(task.content)
        if (!description) {
          diagnostic(task, "Malformed todo retained as a diagnostic.")
          continue
        }
        steps.push(description)
        const status =
          task.status === "completed"
            ? "completed"
            : task.status === "in_progress"
              ? "running"
              : task.status === "abandoned"
                ? "cancelled"
                : task.status === "blocked"
                  ? "waiting"
                  : "pending"
        session.tasks.push({
          taskId: str(task.id) ?? `todo-${phaseIndex}-${taskIndex}`,
          description,
          status,
          ...(typeof task.blocker === "string" ? { summary: task.blocker } : {}),
        })
      }
      session.plans.push({
        planId: `todo-phase-${phaseIndex}`,
        title: str(phase.name),
        steps,
        updatedAt: at,
      })
    }
  }
  retainExtra(
    header,
    ["type", "version", "id", "title", "timestamp", "cwd", "parentSession"],
    "Additional session provenance retained as a bounded diagnostic."
  )
  let firstUserText = ""
  for (const entry of chain) {
    const at = str(entry.timestamp)
    const created = time(entry.timestamp, createdAt)
    session.updatedAt = Math.max(session.updatedAt, created)
    const type = str(entry.type)
    if (type === "title_change") {
      session.title = str(entry.title) ?? session.title
      diagnostic(entry, "Title change provenance retained as a bounded diagnostic.")
      continue
    }
    if (type === "model_change") {
      if (!entry.role || entry.role === "default") session.model = str(entry.model) ?? session.model
      diagnostic(entry, "Model selection provenance retained as a bounded diagnostic.")
      continue
    }
    if (type === "mode_change") {
      const goal = record(record(entry.data).goal)
      if (typeof goal.objective === "string" && typeof goal.id === "string") {
        const status =
          goal.status === "complete"
            ? "completed"
            : goal.status === "dropped"
              ? "cancelled"
              : goal.status === "paused" || goal.status === "budget-limited"
                ? "blocked"
                : "active"
        const item = {
          goalId: goal.id,
          description: goal.objective,
          status,
          updatedAt: new Date(time(goal.updatedAt, created)).toISOString(),
        } as const
        const index = session.goals.findIndex((g) => g.goalId === goal.id)
        if (index < 0) session.goals.push(item)
        else session.goals[index] = item
      }
      diagnostic(entry, "Mode and goal budget metadata retained as a bounded diagnostic.")
      continue
    }
    if (type === "custom") {
      if (entry.customType === "user_todo_edit") setTodos(record(entry.data).phases, at)
      if (entry.customType === "goal-completed") {
        const goal = session.goals.at(-1)
        if (goal) goal.status = "completed"
      }
      diagnostic(
        entry,
        "Extension state is not a model-visible turn; retained as a bounded diagnostic."
      )
      continue
    }
    if (type === "compaction" || type === "branch_summary" || type === "reset_boundary") {
      session.history.push({
        historyId: str(entry.id) ?? `history-${session.history.length}`,
        kind:
          type === "compaction" ? "compaction" : type === "branch_summary" ? "branch" : "rewind",
        at,
        summary: str(entry.summary),
        fromTurnId: str(entry.fromId),
        toTurnId: str(entry.firstKeptEntryId),
      })
      if (typeof entry.summary === "string")
        session.messages.push({
          role: "system",
          parts: [historyText(entry.summary)],
          createdAt: created,
        })
      diagnostic(
        entry,
        "Context boundaries are preserved as history events; provider replay metadata is diagnostic-only."
      )
      continue
    }
    if (type === "session_init") {
      session.relationKind = "subagent"
      diagnostic(
        entry,
        "Subagent initialization preserved as a bounded diagnostic, without inventing a second task message."
      )
      continue
    }
    if (type === "model_usage") {
      retainExtra(
        entry,
        ["type", "id", "parentId", "timestamp", "purpose", "role", "model", "usage"],
        "Non-transcript model call metadata retained as a bounded diagnostic."
      )
      session.messages.push({
        role: "system",
        parts: [],
        createdAt: created,
        usage: mapUsage(entry.usage),
        usageModel: str(entry.model),
        annotations: {
          omp: { purpose: str(entry.purpose), role: str(entry.role), transcriptExcluded: true },
        },
      })
      continue
    }
    if (type === "custom_message") {
      session.messages.push({
        role: "system",
        parts: parts(entry.content),
        createdAt: created,
        annotations: {
          omp: {
            customType: str(entry.customType),
            display: entry.display === true,
            attribution: str(entry.attribution),
          },
        },
      })
      retainExtra(
        entry,
        ["type", "id", "parentId", "timestamp", "customType", "content", "display", "attribution"],
        "Custom message metadata retained as a bounded diagnostic."
      )
      continue
    }
    if (type !== "message") {
      diagnostic(entry, "Unmapped session entry retained as a bounded diagnostic.")
      continue
    }
    retainExtra(
      entry,
      ["type", "id", "parentId", "timestamp", "message"],
      "Message entry metadata retained as a bounded diagnostic."
    )
    const message = record(entry.message)
    const role = str(message.role)
    if (
      role !== "toolResult" &&
      (message.details !== undefined || message.nestedCalls !== undefined)
    )
      diagnostic(
        { details: message.details, nestedCalls: message.nestedCalls },
        "Custom or provider message details retained as a bounded diagnostic."
      )
    const messageMetadata = Object.fromEntries(
      Object.entries(message).filter(
        ([key]) =>
          ![
            "role",
            "content",
            "toolCallId",
            "toolName",
            "isError",
            "details",
            "nestedCalls",
            "usage",
            "model",
            "provider",
            "stopReason",
            "timestamp",
            "command",
            "code",
            "output",
            "exitCode",
            "cancelled",
            "images",
            "files",
          ].includes(key)
      )
    )
    if (Object.keys(messageMetadata).length)
      diagnostic(messageMetadata, "Additional message metadata retained as a bounded diagnostic.")
    if (role === "fileMention") {
      const files = Array.isArray(message.files) ? message.files : []
      if (!Array.isArray(message.files))
        diagnostic(message, "Malformed file mention retained as a bounded diagnostic.")
      for (const raw of files) {
        const file = record(raw)
        session.messages.push({
          role: "system",
          parts: [
            ...(typeof file.content === "string" ? [historyText(file.content)] : []),
            ...(file.image ? parts([file.image]) : []),
          ],
          createdAt: created,
          annotations: {
            omp: {
              filePath: str(file.path),
              skippedReason: str(file.skippedReason),
              byteSize: file.byteSize,
              lineCount: file.lineCount,
            },
          },
        })
      }
      continue
    }
    if (role === "toolResult") {
      const resultParts = parts(message.content)
      const output = resultParts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n")
      const attachments = resultParts.filter((p) => p.type === "file")
      const callId = str(message.toolCallId)
      const owner = callId ? tools.get(callId) : undefined
      const part = owner?.message.parts[owner.index]
      if (owner && part?.type === "tool") {
        owner.message.parts[owner.index] = {
          ...part,
          result:
            message.isError === true
              ? { ok: false, errorText: stringifyToolResult(output) }
              : { ok: true, output },
        }
        owner.message.parts.push(...attachments)
      } else {
        session.messages.push({
          role: "assistant",
          parts: [historyText(output), ...attachments],
          createdAt: created,
        })
        loss("entries.toolResult", "Orphan tool result represented as assistant content.")
      }
      const details = record(message.details)
      if (message.toolName === "todo" && message.isError !== true && details.op !== "view")
        setTodos(details.phases, at)
      if (message.details || message.nestedCalls)
        diagnostic(
          { details: message.details, nestedCalls: message.nestedCalls },
          "Tool metadata retained as a bounded diagnostic."
        )
      continue
    }
    if (role === "bashExecution" || role === "pythonExecution") {
      const name = role === "bashExecution" ? "bash" : "python"
      session.messages.push({
        role: "assistant",
        createdAt: created,
        parts: [
          historyTool({
            name,
            toolCallId: str(entry.id) ?? `exec-${session.messages.length}`,
            input: { command: message.command, code: message.code },
            result:
              message.cancelled === true ||
              (typeof message.exitCode === "number" && message.exitCode !== 0)
                ? { ok: false, errorText: str(message.output) ?? "Execution failed" }
                : { ok: true, output: message.output ?? "" },
          }),
          ...parts(message.images),
        ],
        annotations: { omp: { role } },
      })
      continue
    }
    if (
      ![
        "user",
        "assistant",
        "custom",
        "hookMessage",
        "fileMention",
        "branchSummary",
        "compactionSummary",
      ].includes(role ?? "")
    ) {
      diagnostic(entry, "Unknown message role retained as a bounded diagnostic.")
      continue
    }
    const mapped = parts(message.content ?? message.summary)
    if (role === "user" && !firstUserText)
      firstUserText = mapped
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join(" ")
    const turn: HistoryMessage = {
      role: role === "user" ? "user" : role === "assistant" ? "assistant" : "system",
      parts: mapped,
      createdAt: created,
      ...(message.usage ? { usage: mapUsage(message.usage), usageModel: str(message.model) } : {}),
      annotations: {
        omp: {
          entryId: str(entry.id),
          parentId: str(entry.parentId),
          stopReason: str(message.stopReason),
          model: str(message.model),
          provider: str(message.provider),
        },
      },
    }
    if (role === "assistant" && message.model)
      session.model = message.provider ? `${message.provider}/${message.model}` : str(message.model)
    for (const [index, part] of mapped.entries())
      if (part.type === "tool") tools.set(part.toolCallId, { message: turn, index })
    session.messages.push(turn)
  }
  // A mutable title slot is authoritative even when the audit title entries lag it.
  if (title !== undefined) session.title = title
  else if (session.title === "OMP session")
    session.title = deriveTitle(firstUserText, "OMP session")
  return session
}

export function readOmpSession(
  content: string,
  locator: string,
  host: HistoryReaderHost,
  options: OmpHistoryOptions = {}
): ParsedOmpHistory {
  if (!host || typeof host.redactText !== "function")
    throw new OmpHistoryError("A history redaction host is required")
  const { header, entries, title, corruptLines, version } = parseFile(content)
  // OMP's loaded leaf is the final appended entry, not the largest wall-clock timestamp.
  const views = entries.map((entry) => ({
    uuid: str(entry.id),
    parentUuid: str(entry.parentId),
    entry,
  }))
  const active = linearizeActiveLeaf(views).map((view) => view.entry)
  const session = buildSession(active, header, locator, title, host, options)
  const ids = new Set(entries.map((e) => str(e.id)).filter(Boolean))
  const claimed = new Set(entries.map((e) => str(e.parentId)).filter(Boolean))
  const leaves = entries.filter((e) => str(e.id) && !claimed.has(str(e.id)))
  const duplicates = entries.filter((e) => str(e.id)).length !== ids.size
  const missingParents = entries.some((e) => str(e.parentId) && !ids.has(str(e.parentId)))
  if (duplicates || missingParents || (entries.length > 0 && ids.size > 0 && !leaves.length))
    session.losses.push({
      path: "entries.tree",
      kind: "approximated",
      detail:
        "Malformed parent graph was degraded with cycle protection; duplicate IDs, missing ancestors or cycles exist.",
    })
  if (corruptLines)
    session.losses.push({
      path: "lines",
      kind: "dropped",
      detail: `${corruptLines} malformed or duplicate header line(s) skipped.`,
    })
  const activeId = active.at(-1)?.id
  const visited = new Set(active)
  const branches = leaves
    .filter((e) => e.id !== activeId)
    .reverse()
    .map((leaf) => {
      const leafId = leaf.id as string
      const branchChain = chainToLeaf(entries, leafId)
      for (const entry of branchChain) visited.add(entry)
      const branch = buildSession(branchChain, header, locator, title, host, options)
      branch.originalSessionId = `${session.originalSessionId}:branch:${leafId}`
      branch.relationKind = "branch"
      branch.parentNativeSessionId = session.originalSessionId
      return { leafId, session: branch }
    })
  const detached = entries.filter((entry) => !visited.has(entry))
  if (detached.length) {
    for (const entry of detached) {
      session.recordedEvents.push({
        eventId: `omp-${session.recordedEvents.length}`,
        sequence: session.recordedEvents.length,
        at: str(entry.timestamp),
        event: {
          kind: "diagnostic",
          runtime: OMP_SESSION_SOURCE_ID,
          payload: boundedDiagnostic(entry, host),
        },
      })
    }
    session.losses.push({
      path: "entries.tree.detached",
      kind: "summarized",
      detail: `${detached.length} record(s) excluded from reachable branches (missing/duplicate IDs or disconnected cycles) retained as bounded redacted diagnostics.`,
    })
  }
  return {
    session,
    branches,
    sessionVersion: version,
    ...(str(header.parentSession) ? { forkedFrom: str(header.parentSession) } : {}),
  }
}
/** Header/title and active-branch visible-message counts, without constructing diagnostic/transcript payloads. */
export function summarizeOmpSession(
  content: string,
  locator: string
): HistorySessionSummary | null {
  try {
    const { header, entries, title } = parseFile(content)
    const active = linearizeActiveLeaf(
      entries.map((entry) => ({ uuid: str(entry.id), parentUuid: str(entry.parentId), entry }))
    ).map((v) => v.entry)
    let first = ""
    let messageCount = 0
    let updatedAt = time(header.timestamp)
    let currentTitle = title ?? str(header.title)
    for (const e of active) {
      updatedAt = Math.max(updatedAt, time(e.timestamp))
      if (e.type === "title_change" && title === undefined) currentTitle = str(e.title)
      const m = record(e.message)
      if (
        e.type === "custom_message" ||
        e.type === "compaction" ||
        e.type === "branch_summary" ||
        (e.type === "message" && m.role !== "toolResult")
      )
        messageCount++
      if (!first && m.role === "user")
        first =
          typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((b) => str(record(b).text) ?? "").join(" ")
              : ""
    }
    return {
      sourceId: OMP_SESSION_SOURCE_ID,
      originalSessionId: str(header.id) ?? locator,
      title: currentTitle ?? deriveTitle(first, "OMP session"),
      messageCount,
      updatedAt,
      cwd: str(header.cwd),
      sourceVersion: String(header.version ?? 1),
      ...(header.parentSession
        ? { parentNativeSessionId: parentId(header.parentSession), relationKind: "fork" }
        : {}),
    }
  } catch {
    return null
  }
}
/** Shared Pi-shaped headers alone are ambiguous; only native paths make a positive match. */
export function detectOmpSessions(files: readonly HistoryPickedFile[]): HistoryDetectVerdict {
  if (!files.length) return "no"
  let native = 0
  let ambiguous = 0
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith(".jsonl")) continue
    const path = file.path.replace(/\\/g, "/")
    if (path.includes("/.pi/")) continue
    try {
      parseFile(file.content)
      if (path.includes("/.omp/")) native++
      else ambiguous++
    } catch {
      /* Another reader owns foreign/unsupported files. */
    }
  }
  return native === files.length ? "match" : native + ambiguous > 0 ? "maybe" : "no"
}
