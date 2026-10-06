/**
 * OpenCode session-history reader (ADR-0217).
 *
 * Current OpenCode persists to SQLite (`opencode.db`: SessionTable /
 * MessageTable / PartTable). The host reads the database (the desktop through
 * a Rust command, the CLI through `node:sqlite`) into the normalized
 * {@link OpencodeSession} records declared here. A user can also pick an
 * OpenCode share export: a flat array of `{ session | message | part }`
 * records, a nested `{ session | info, messages }` object, or the current
 * ShareNext `{ type, data }` shape, which {@link parseOpencodeExport}
 * reconstructs by grouping parts under their `messageID` (mirrors
 * `packages/opencode/src/cli/cmd/import.ts:transformShareData`).
 *
 * Part mapping: text → text, reasoning → reasoning, tool → tool call (with its
 * recorded result), file → file. Patches, snapshots, retries, compactions,
 * step boundaries and agent delegations become short text markers, and the
 * structural ones are also kept as recorded events. Pure functions over
 * records and file content: the host finds and reads the data and maps the
 * result into its own rows.
 */

import type {
  CanonicalHistoryEvent,
  CanonicalRecordedEvent,
  CanonicalSessionTask,
  SessionLossEntry,
} from "@cognia/agent-contracts/canonical-session"
import type {
  HistoryDetectVerdict,
  HistoryFormatInfo,
  HistoryMessage,
  HistoryPart,
  HistoryPickedFile,
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
import { OPENCODE_SESSION_SOURCE_ID } from "./manifest"

/** The OpenCode version this reader was last verified against. */
export const OPENCODE_HISTORY_FORMAT: HistoryFormatInfo = Object.freeze({
  sourceId: OPENCODE_SESSION_SOURCE_ID,
  verifiedVersion: "1.18.25",
  verifiedAt: "2026-08-29",
  acceptedExtensions: Object.freeze([".json"]),
})

/** A normalized OpenCode message part (a superset of what Cognia renders). */
export interface OpencodePart {
  id?: string
  type: string
  text?: string
  tool?: string
  callID?: string
  state?: {
    status?: string
    input?: unknown
    output?: unknown
    error?: string
  }
  /** OpenCode `FilePart` MIME field (the SDK sends and stores `mime`). */
  mime?: string
  /** Legacy spelling kept for share exports that used it. */
  mediaType?: string
  filename?: string
  url?: string
  /** Agent-delegation part: the subagent's name. */
  name?: string
}

export interface OpencodeBackgroundJob {
  id: string
  status?: string
  description?: string
  parentId?: string
  dependencies?: string[]
  createdAt?: number
  updatedAt?: number
  error?: string
}

/** Normalized per-turn token counts projected by the readers. */
export interface OpencodeTokens {
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
}

export interface OpencodeMessage {
  role: string
  parts: OpencodePart[]
  createdAt: number
  /** Per-message model id (assistant turns). */
  model?: string
  /** OpenCode's own USD cost estimate for the turn. */
  cost?: number
  /** Token counts for the turn (assistant messages). */
  tokens?: OpencodeTokens
}

export interface OpencodeSession {
  id: string
  title: string
  cwd?: string
  model?: string
  /** Parent session id when this is a subagent (child) session. */
  parentId?: string
  createdAt: number
  updatedAt: number
  messages: OpencodeMessage[]
  jobs?: OpencodeBackgroundJob[]
}

/** Loss entries keyed by path, so a long session reports each kind once. */
class LossLedger {
  private readonly entries = new Map<string, SessionLossEntry>()
  add(entry: SessionLossEntry): void {
    if (!this.entries.has(entry.path)) this.entries.set(entry.path, entry)
  }
  list(): SessionLossEntry[] {
    return [...this.entries.values()]
  }
}

function mapPart(part: OpencodePart, losses: LossLedger): HistoryPart | null {
  switch (part.type) {
    case "text":
      return part.text ? historyText(part.text) : null
    case "reasoning":
      return part.text ? historyReasoning(part.text) : null
    case "tool":
    case "tool-invocation": {
      const state = part.state ?? {}
      const isError = state.status === "error" || !!state.error
      const recorded = state.output !== undefined || isError
      const output = recorded ? (isError ? state.error : state.output) : undefined
      if (isError && output === undefined) {
        losses.add({
          path: "parts.tool.error",
          kind: "approximated",
          detail: "A tool call OpenCode marked failed without an error text imports as unresolved.",
        })
      }
      return historyTool({
        name: part.tool || "tool",
        toolCallId: part.callID || "unknown",
        input: state.input ?? {},
        ...(output === undefined
          ? {}
          : {
              result: isError
                ? { ok: false as const, errorText: stringifyToolResult(output) }
                : { ok: true as const, output },
            }),
      })
    }
    case "file":
      // OpenCode's FilePart stores the MIME type under `mime` (the SDK sends it
      // that way too); `mediaType` is only seen in older share exports. Reading
      // only `mediaType` used to flatten every file to application/octet-stream,
      // so pasted screenshots never rendered inline after import.
      if (!part.url) {
        losses.add({
          path: "parts.file",
          kind: "dropped",
          detail: "An OpenCode file part without a URL has no content to import.",
        })
        return null
      }
      return historyFile({
        mediaType: part.mime || part.mediaType || "application/octet-stream",
        url: part.url,
        filename: part.filename,
      })
    case "patch":
    case "snapshot": {
      // Structural markers between turns. A compact marker keeps an applied
      // patch or snapshot visible; the full diff is not in the normalized shape.
      losses.add({
        path: `parts.${part.type}`,
        kind: "summarized",
        detail: `OpenCode ${part.type} parts import as a text marker; the diff itself is not in the stored record.`,
      })
      const label = part.type === "patch" ? "patch applied" : "snapshot"
      const detail = part.text || part.filename || ""
      return historyText(detail ? `[${label}: ${detail}]` : `[${label}]`)
    }
    case "agent": {
      // Subagent delegation marker: the child transcript is its own session
      // (a descendant in the session tree); keep a pointer in the parent.
      const name = part.name || "subagent"
      return historyText(`[delegated to agent: ${name}]`)
    }
    case "retry":
      return historyText("[retry]")
    case "compaction":
      return historyText(part.text ? `[context compacted: ${part.text}]` : "[context compacted]")
    case "step-start":
      return historyText("[step started]")
    case "step-finish":
      return historyText("[step finished]")
    default:
      losses.add({
        path: `parts.${part.type}`,
        kind: "dropped",
        detail: `OpenCode "${part.type}" parts have no Cognia equivalent.`,
      })
      return null
  }
}

/** Usage of an assistant OpenCode message, or `undefined` when none was recorded. */
function usageOf(message: OpencodeMessage): HistoryUsage | undefined {
  const tokens = message.tokens
  const hasTokens =
    !!tokens &&
    !!(tokens.input || tokens.output || tokens.reasoning || tokens.cacheRead || tokens.cacheWrite)
  if (!hasTokens && typeof message.cost !== "number") return undefined
  return {
    inputTokens: tokens?.input ?? 0,
    // Reasoning tokens are billed as output; fold them in like the live
    // adapter does (`mapOpenCodeTokens` in ./client).
    outputTokens: (tokens?.output ?? 0) + (tokens?.reasoning ?? 0),
    cacheReadInputTokens: tokens?.cacheRead ?? 0,
    cacheCreationInputTokens: tokens?.cacheWrite ?? 0,
    ...(typeof message.cost === "number" ? { totalCostUsd: message.cost } : {}),
  }
}

function lifecycleStatus(status: string | undefined): CanonicalSessionTask["status"] {
  if (status === "completed" || status === "done") return "completed"
  if (status === "failed" || status === "error") return "failed"
  if (status === "cancelled" || status === "canceled") return "cancelled"
  if (status === "pending") return "pending"
  if (status === "waiting" || status === "blocked") return "waiting"
  return "running"
}

const RECORDED_PART_TYPES = new Set(["step-start", "step-finish", "retry", "snapshot", "patch"])

/** Background jobs, compactions and structural markers as canonical state. */
function structuredState(session: OpencodeSession): {
  tasks: CanonicalSessionTask[]
  history: CanonicalHistoryEvent[]
  recordedEvents: CanonicalRecordedEvent[]
} {
  const tasks = (session.jobs ?? []).map((job) => ({
    taskId: job.id,
    description: job.description,
    status: lifecycleStatus(job.status),
    background: true,
    parentTaskId: job.parentId,
    dependencies: job.dependencies,
    error: job.error,
    startedAt: job.createdAt ? new Date(job.createdAt).toISOString() : undefined,
    endedAt:
      job.updatedAt && ["completed", "failed", "cancelled"].includes(lifecycleStatus(job.status))
        ? new Date(job.updatedAt).toISOString()
        : undefined,
  }))
  const history: CanonicalHistoryEvent[] = []
  const recordedEvents: CanonicalRecordedEvent[] = []
  let sequence = 0
  for (const message of session.messages) {
    for (const part of message.parts) {
      if (part.type === "compaction") {
        history.push({
          historyId: part.id || `compaction-${history.length + 1}`,
          kind: "compaction",
          summary: part.text,
        })
      }
      if (RECORDED_PART_TYPES.has(part.type)) {
        recordedEvents.push({
          eventId: part.id || `opencode-event-${sequence}`,
          sequence: sequence++,
          event: {
            kind: "diagnostic",
            runtime: "opencode",
            payload: {
              type: part.type,
              ...(part.text ? { text: part.text.slice(0, 2_000) } : {}),
              ...(part.filename ? { filename: part.filename } : {}),
            },
          },
        })
      }
    }
  }
  return { tasks, history, recordedEvents }
}

/**
 * One OpenCode session as the neutral transcript plus its structured state.
 * Messages that map to no visible part are dropped, so positions (and the
 * host's message ids) count only what is shown.
 */
export function readOpencodeSession(session: OpencodeSession): ParsedHistorySession {
  const losses = new LossLedger()
  const messages: HistoryMessage[] = []
  let firstUserText = ""
  for (const message of session.messages) {
    const parts = message.parts
      .map((part) => mapPart(part, losses))
      .filter((part): part is HistoryPart => part !== null)
    if (parts.length === 0) continue
    const role: HistoryMessage["role"] =
      message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user"
    const usage = role === "assistant" ? usageOf(message) : undefined
    messages.push({
      role,
      parts,
      createdAt: message.createdAt,
      ...(usage ? { usage, ...(message.model ? { usageModel: message.model } : {}) } : {}),
    })
    if (!firstUserText && role === "user") {
      const text = parts.find((part) => part.type === "text")
      if (text?.type === "text") firstUserText = text.text
    }
  }
  const { tasks, history, recordedEvents } = structuredState(session)
  return {
    sourceId: OPENCODE_SESSION_SOURCE_ID,
    originalSessionId: session.id,
    cwd: session.cwd,
    model: session.model,
    title: session.title || deriveTitle(firstUserText, "OpenCode session"),
    messages,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.parentId
      ? { relationKind: "subagent" as const, parentNativeSessionId: session.parentId }
      : {}),
    goals: [],
    plans: [],
    tasks,
    history,
    interAgentMessages: [],
    recordedEvents,
    losses: losses.list(),
  }
}

// ---- share-export JSON (the picker path) ----------------------------------

interface ShareRecord {
  key?: string
  content?: Record<string, unknown>
  type?: string
  data?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function numOr(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** Model, cost and tokens off a raw OpenCode message `data` object. */
function readUsage(c: Record<string, unknown>): Pick<OpencodeMessage, "model" | "cost" | "tokens"> {
  const out: Pick<OpencodeMessage, "model" | "cost" | "tokens"> = {}
  const model = c.modelID ?? c.model
  if (typeof model === "string" && model) out.model = model
  if (typeof c.cost === "number") out.cost = c.cost
  const tk = c.tokens
  if (tk && typeof tk === "object") {
    const t = tk as Record<string, unknown>
    const cache = (t.cache as Record<string, unknown>) ?? {}
    out.tokens = {
      input: numOr(t.input),
      output: numOr(t.output),
      reasoning: numOr(t.reasoning),
      cacheRead: numOr(cache.read),
      cacheWrite: numOr(cache.write),
    }
  }
  return out
}

function normalizeNested(obj: Record<string, unknown>): OpencodeSession | null {
  const sessionInfo = asRecord(obj.session) ?? asRecord(obj.info) ?? obj
  const id = String(sessionInfo.id ?? "")
  if (!id) return null
  const time = (sessionInfo.time as Record<string, unknown>) ?? {}
  const rawMessages = Array.isArray(obj.messages) ? obj.messages : []
  const messages: OpencodeMessage[] = rawMessages.flatMap((m) => {
    const wrapper = asRecord(m)
    if (!wrapper) return []
    const info = asRecord(wrapper.info) ?? wrapper
    return [
      {
        role: String(info.role ?? "user"),
        parts: Array.isArray(wrapper.parts)
          ? wrapper.parts.filter(
              (part): part is OpencodePart => !!asRecord(part) && typeof part.type === "string"
            )
          : [],
        createdAt: Number(asRecord(info.time)?.created ?? 0),
        ...readUsage(info),
      },
    ]
  })
  return {
    id,
    title: typeof sessionInfo.title === "string" ? sessionInfo.title : "OpenCode session",
    cwd: typeof sessionInfo.directory === "string" ? sessionInfo.directory : undefined,
    parentId:
      typeof sessionInfo.parentID === "string" && sessionInfo.parentID
        ? sessionInfo.parentID
        : undefined,
    createdAt: Number(time.created ?? 0),
    updatedAt: Number(time.updated ?? time.created ?? 0),
    messages,
    jobs: Array.isArray(obj.jobs)
      ? obj.jobs
          .map((job) => (job && typeof job === "object" ? job : undefined))
          .filter(Boolean)
          .map((job) => {
            const value = job as Record<string, unknown>
            return {
              id: String(value.id ?? ""),
              status: typeof value.status === "string" ? value.status : undefined,
              description: typeof value.description === "string" ? value.description : undefined,
              parentId: typeof value.parentID === "string" ? value.parentID : undefined,
              dependencies: Array.isArray(value.dependencies)
                ? value.dependencies.filter((item): item is string => typeof item === "string")
                : undefined,
              error: typeof value.error === "string" ? value.error : undefined,
            }
          })
      : undefined,
  }
}

/**
 * Reconstruct {@link OpencodeSession}s from an OpenCode share export. Accepts
 * a flat `ShareRecord[]` (keyed by "session/…", "message/…", "part/…"), the
 * current ShareNext `{ type, data }` records, or a nested legacy
 * `{ session, messages }` / CLI `{ info, messages }` object. Unparseable
 * content yields no sessions.
 */
export function parseOpencodeExport(content: string): OpencodeSession[] {
  let data: unknown
  try {
    data = JSON.parse(content)
  } catch {
    return []
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>
    if (obj.messages && (obj.id || obj.session || obj.info)) {
      const session = normalizeNested(obj)
      return session ? [session] : []
    }
  }
  if (!Array.isArray(data)) return []

  const sessions = new Map<string, OpencodeSession>()
  // `sort` (arrival order) stays on the record: it is part of what
  // `opencodeSessionRevision` hashes for a picked export.
  const messages = new Map<
    string,
    OpencodeMessage & { id: string; sessionID: string; sort: number }
  >()
  const partsByMessage = new Map<string, OpencodePart[]>()

  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue
    const rec = raw as ShareRecord
    const isShareNext = typeof rec.type === "string" && rec.data !== undefined
    if (isShareNext && !["session", "message", "part"].includes(rec.type!)) continue
    const key = typeof rec.key === "string" ? rec.key : isShareNext ? rec.type! : ""
    const c = asRecord(rec.content ?? (isShareNext ? rec.data : raw))
    if (!c) continue
    if (key.startsWith("session") || (c.id && c.title && c.time)) {
      const time = (c.time as Record<string, unknown>) ?? {}
      sessions.set(String(c.id), {
        id: String(c.id),
        title: typeof c.title === "string" ? c.title : "OpenCode session",
        cwd: typeof c.directory === "string" ? c.directory : undefined,
        parentId: typeof c.parentID === "string" && c.parentID ? c.parentID : undefined,
        createdAt: Number(time.created ?? 0),
        updatedAt: Number(time.updated ?? time.created ?? 0),
        messages: [],
      })
    } else if (key.startsWith("message") || (c.role && c.sessionID)) {
      const id = String(c.id)
      messages.set(id, {
        id,
        sessionID: String(c.sessionID),
        role: String(c.role),
        parts: [],
        createdAt: Number((c.time as Record<string, unknown>)?.created ?? 0),
        sort: messages.size,
        ...readUsage(c),
      })
    } else if (key.startsWith("part") || (c.messageID && c.type)) {
      const messageId = String(c.messageID)
      const parts = partsByMessage.get(messageId) ?? []
      parts.push(c as unknown as OpencodePart)
      partsByMessage.set(messageId, parts)
    }
  }

  for (const message of messages.values()) {
    message.parts = partsByMessage.get(message.id) ?? []
    sessions.get(message.sessionID)?.messages.push(message)
  }
  return [...sessions.values()]
}

/** Whether picked files look like OpenCode share exports. */
export function detectOpencodeExport(files: readonly HistoryPickedFile[]): HistoryDetectVerdict {
  if (files.length === 0) return "no"
  const looks = files.some((file) => {
    if (file.path.replace(/\\/g, "/").includes("opencode")) return true
    try {
      const data = JSON.parse(file.content)
      if (Array.isArray(data)) {
        return data.some(
          (r) =>
            (typeof r?.key === "string" && /^(session|message|part)/.test(r.key)) ||
            (["session", "message", "part"].includes(r?.type) && !!asRecord(r?.data))
        )
      }
      return !!(data?.messages && (data?.id || data?.session || data?.info))
    } catch {
      return false
    }
  })
  return looks ? "maybe" : "no"
}

// ---- the session tree ------------------------------------------------------

/**
 * Root sessions to offer and each one's descendants (its subagent sessions,
 * transitively). Empty sessions are skipped, a child whose parent is missing
 * becomes a root, and a malformed cyclic graph keeps one representative per
 * component so nothing importable disappears.
 */
export function opencodeSessionTree(sessions: readonly OpencodeSession[]): {
  roots: OpencodeSession[]
  descendantsOf: (id: string) => OpencodeSession[]
} {
  const importable = sessions.filter((session) => session.messages.length > 0)
  const known = new Set(importable.map((session) => session.id))
  const childrenByParent = new Map<string, OpencodeSession[]>()
  for (const session of importable) {
    if (!session.parentId || !known.has(session.parentId)) continue
    const children = childrenByParent.get(session.parentId) ?? []
    children.push(session)
    childrenByParent.set(session.parentId, children)
  }

  const descendantsOf = (id: string): OpencodeSession[] => {
    const descendants: OpencodeSession[] = []
    const visited = new Set([id])
    const visit = (parentId: string) => {
      for (const child of childrenByParent.get(parentId) ?? []) {
        if (visited.has(child.id)) continue
        visited.add(child.id)
        descendants.push(child)
        visit(child.id)
      }
    }
    visit(id)
    return descendants
  }

  const roots: OpencodeSession[] = []
  const covered = new Set<string>()
  const addRoot = (session: OpencodeSession) => {
    roots.push(session)
    covered.add(session.id)
    for (const descendant of descendantsOf(session.id)) covered.add(descendant.id)
  }
  for (const session of importable) {
    if (!session.parentId || !known.has(session.parentId)) addRoot(session)
  }
  for (const session of importable) {
    if (!covered.has(session.id)) addRoot(session)
  }
  return { roots, descendantsOf }
}

/**
 * A content revision of a session and its descendants: equal records give an
 * equal string, so a watcher re-imports only what changed.
 */
export function opencodeSessionRevision(
  session: OpencodeSession,
  descendants: readonly OpencodeSession[]
): string {
  const content = JSON.stringify([
    session,
    ...[...descendants].sort((a, b) => a.id.localeCompare(b.id)),
  ])
  let hash = 0x811c9dc5
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `opencode:${content.length}:${(hash >>> 0).toString(36)}`
}
