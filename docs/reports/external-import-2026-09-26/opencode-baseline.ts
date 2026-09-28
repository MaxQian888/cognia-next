// OpenCode session-history source.
//
// Current OpenCode persists to SQLite (`~/.local/share/opencode/opencode.db`,
// SessionTable / MessageTable / PartTable). We read it through the Rust
// `opencode_sessions_read` command (see `opencode-db.ts`), which returns already
// normalized `OpencodeSession[]`. The picker fallback additionally accepts an
// OpenCode "share export" JSON — a flat array of `{ session | message | part }`
// records reconstructed by grouping parts under their `messageID` (mirrors
// `packages/opencode/src/cli/cmd/import.ts:transformShareData`).
//
// Part mapping: text→text, reasoning→reasoning, tool→tool-<name> (+state),
// file→file. Structural markers (step-start/-finish, snapshot, patch) drop.

import type { ImportedConversation } from "@/lib/data/importers/types"
import type { StoredMessage } from "@cognia/agent-config-types"
import type { UsageInfo } from "@/lib/claude/adapter"
import type {
  CanonicalHistoryEvent,
  CanonicalRecordedEvent,
  CanonicalSessionTask,
} from "@cognia/agent-config-types/canonical-session"
import { importedUsageMetadata } from "../usage"
import { buildImportedSessionGraph } from "../graph"
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
import {
  opencodeDataDirs,
  readOpencodeSessions,
  type OpencodeMessage,
  type OpencodePart,
  type OpencodeSession,
} from "./opencode-db"

type Part = StoredMessage["parts"][number]

const ACCEPTED = [".json"]

function mapPart(part: OpencodePart): Part | null {
  switch (part.type) {
    case "text":
      return part.text ? textPart(part.text) : null
    case "reasoning":
      return part.text ? reasoningPart(part.text) : null
    case "tool":
    case "tool-invocation": {
      const state = part.state ?? {}
      const isError = state.status === "error" || !!state.error
      const hasOutput = state.output !== undefined || isError
      return toolPart({
        name: part.tool || "tool",
        toolCallId: part.callID || "unknown",
        input: state.input ?? {},
        output: hasOutput ? (isError ? state.error : state.output) : undefined,
        isError,
      })
    }
    case "file":
      // OpenCode's FilePart stores the MIME type under `mime` (the SDK sends it
      // that way too); `mediaType` is only seen in older share exports. Reading
      // only `mediaType` used to flatten every file to application/octet-stream,
      // so pasted screenshots never rendered inline after import.
      return part.url
        ? filePart({
            mediaType: part.mime || part.mediaType || "application/octet-stream",
            url: part.url,
            filename: part.filename,
          })
        : null
    case "patch":
    case "snapshot": {
      // Structural markers between turns — previously dropped. Surface a compact
      // marker so an applied patch / snapshot is visible in the imported
      // transcript (the full diff isn't in the normalized shape). Truly empty
      // control markers (step-start / step-finish) still fall through to null.
      const label = part.type === "patch" ? "patch applied" : "snapshot"
      const detail = part.text || part.filename || ""
      return textPart(detail ? `[${label}: ${detail}]` : `[${label}]`)
    }
    case "agent": {
      // Subagent delegation marker — the child transcript itself is imported as
      // a nested conversation (see parseSession); keep a pointer in the parent.
      const name = part.name || "subagent"
      return textPart(`[delegated to agent: ${name}]`)
    }
    case "retry":
      return textPart("[retry]")
    case "compaction":
      return textPart(part.text ? `[context compacted: ${part.text}]` : "[context compacted]")
    case "step-start":
      return textPart("[step started]")
    case "step-finish":
      return textPart("[step finished]")
    default:
      return null
  }
}

/** Imported-usage metadata for an assistant OpenCode message, or `undefined`. */
function opencodeUsageMeta(msg: OpencodeMessage): StoredMessage["metadata"] | undefined {
  const t = msg.tokens
  const hasTokens = !!t && !!(t.input || t.output || t.reasoning || t.cacheRead || t.cacheWrite)
  if (!hasTokens && typeof msg.cost !== "number") return undefined
  const usage: UsageInfo = {
    inputTokens: t?.input ?? 0,
    // Reasoning tokens are billed as output; fold them in like the live
    // adapter does (opencode-client.ts mapOpenCodeTokens).
    outputTokens: (t?.output ?? 0) + (t?.reasoning ?? 0),
    cacheReadInputTokens: t?.cacheRead ?? 0,
    cacheCreationInputTokens: t?.cacheWrite ?? 0,
    ...(typeof msg.cost === "number" ? { totalCostUsd: msg.cost } : {}),
  }
  return importedUsageMetadata(usage, msg.model)
}

function mapMessage(
  msg: OpencodeMessage,
  sessionId: string,
  index: number,
  projectId?: string
): StoredMessage | null {
  const parts = msg.parts.map(mapPart).filter((p): p is Part => p !== null)
  if (parts.length === 0) return null
  const role: StoredMessage["role"] =
    msg.role === "assistant" ? "assistant" : msg.role === "system" ? "system" : "user"
  const metadata = role === "assistant" ? opencodeUsageMeta(msg) : undefined
  return buildMessage({
    sessionId,
    projectId,
    index,
    role,
    parts,
    createdAt: msg.createdAt,
    ...(metadata ? { metadata } : {}),
  })
}

export function opencodeToConversation(
  session: OpencodeSession,
  projectId?: string
): ImportedConversation {
  const id = importedSessionId("opencode", session.id)
  const messages: StoredMessage[] = []
  let firstUserText = ""
  for (const msg of session.messages) {
    const mapped = mapMessage(msg, id, messages.length, projectId)
    if (!mapped) continue
    messages.push(mapped)
    if (!firstUserText && mapped.role === "user") {
      const t = (mapped.parts as Array<Record<string, unknown>>).find((p) => p.type === "text")
      if (t && typeof t.text === "string") firstUserText = t.text
    }
  }
  messages.forEach((m, i) => {
    m.id = importedMessageId(id, i)
  })
  const title = session.title || deriveTitle(firstUserText, "OpenCode session")
  const built = buildSession({
    id,
    projectId,
    title,
    model: session.model,
    workingDir: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    seedMessages: messages,
    ...(session.parentId ? { kind: "subagent" } : {}),
    suppressSeed: session.parentId !== undefined,
  })
  if (session.parentId) {
    built.parentSessionId = importedSessionId("opencode", session.parentId)
    built.importRelation = {
      kind: "subagent",
      parentNativeSessionId: session.parentId,
    }
  }
  return { session: built, messages }
}

// ---- share-export JSON parsing (picker fallback) -------------------------

interface ShareRecord {
  key?: string
  content?: Record<string, unknown>
}

function numOr(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Pull model/cost/tokens off a raw OpenCode message `data` object. */
function readOpencodeUsage(
  c: Record<string, unknown>
): Pick<OpencodeMessage, "model" | "cost" | "tokens"> {
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

/**
 * Reconstruct `OpencodeSession[]` from an OpenCode share-export JSON. Accepts
 * either a flat `ShareRecord[]` (keyed by "session/…", "message/…", "part/…")
 * or an already-nested `{ session, messages }` object.
 */
export function parseOpencodeExport(content: string): OpencodeSession[] {
  let data: unknown
  try {
    data = JSON.parse(content)
  } catch {
    return []
  }
  // Already nested form.
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>
    if (obj.messages && (obj.id || obj.session)) {
      const s = normalizeNested(obj)
      return s ? [s] : []
    }
  }
  if (!Array.isArray(data)) return []

  const sessions = new Map<string, OpencodeSession>()
  const messages = new Map<
    string,
    OpencodeMessage & { id: string; sessionID: string; sort: number }
  >()
  const partsByMessage = new Map<string, OpencodePart[]>()

  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue
    const rec = raw as ShareRecord
    const key = rec.key ?? ""
    const c = rec.content ?? (raw as Record<string, unknown>)
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
        ...readOpencodeUsage(c),
      })
    } else if (key.startsWith("part") || (c.messageID && c.type)) {
      const mid = String(c.messageID)
      const arr = partsByMessage.get(mid) ?? []
      arr.push(c as unknown as OpencodePart)
      partsByMessage.set(mid, arr)
    }
  }

  for (const msg of messages.values()) {
    msg.parts = partsByMessage.get(msg.id) ?? []
    const session = sessions.get(msg.sessionID)
    if (session) session.messages.push(msg)
  }
  return [...sessions.values()]
}

function normalizeNested(obj: Record<string, unknown>): OpencodeSession | null {
  const sessionInfo = (obj.session as Record<string, unknown>) ?? obj
  const id = String(sessionInfo.id ?? "")
  if (!id) return null
  const time = (sessionInfo.time as Record<string, unknown>) ?? {}
  const rawMsgs = Array.isArray(obj.messages) ? obj.messages : []
  const messages: OpencodeMessage[] = rawMsgs.map((m) => {
    const mm = m as Record<string, unknown>
    return {
      role: String(mm.role ?? "user"),
      parts: Array.isArray(mm.parts) ? (mm.parts as OpencodePart[]) : [],
      createdAt: Number((mm.time as Record<string, unknown>)?.created ?? 0),
      ...readOpencodeUsage(mm),
    }
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

function opencodeStatus(status: string | undefined): CanonicalSessionTask["status"] {
  if (status === "completed" || status === "done") return "completed"
  if (status === "failed" || status === "error") return "failed"
  if (status === "cancelled" || status === "canceled") return "cancelled"
  if (status === "pending") return "pending"
  if (status === "waiting" || status === "blocked") return "waiting"
  return "running"
}

function opencodeStructuredState(session: OpencodeSession): {
  tasks: CanonicalSessionTask[]
  history: CanonicalHistoryEvent[]
  recordedEvents: CanonicalRecordedEvent[]
} {
  const tasks = (session.jobs ?? []).map((job) => ({
    taskId: job.id,
    description: job.description,
    status: opencodeStatus(job.status),
    background: true,
    parentTaskId: job.parentId,
    dependencies: job.dependencies,
    error: job.error,
    startedAt: job.createdAt ? new Date(job.createdAt).toISOString() : undefined,
    endedAt:
      job.updatedAt && ["completed", "failed", "cancelled"].includes(opencodeStatus(job.status))
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
      if (["step-start", "step-finish", "retry", "snapshot", "patch"].includes(part.type)) {
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

function contentRevision(session: OpencodeSession, children: OpencodeSession[]): string {
  const content = JSON.stringify([
    session,
    ...[...children].sort((a, b) => a.id.localeCompare(b.id)),
  ])
  let hash = 0x811c9dc5
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `opencode:${content.length}:${(hash >>> 0).toString(36)}`
}

function summarize(
  session: OpencodeSession,
  descendants: OpencodeSession[],
  updatedAt = session.updatedAt
): SessionSummary {
  return {
    ref: { sourceId: "opencode", originalSessionId: session.id, locator: session.id },
    title: session.title,
    sourceId: "opencode",
    messageCount: session.messages.length,
    updatedAt,
    watchRevision: contentRevision(session, descendants),
    cwd: session.cwd,
  }
}

function sessionTree(sessions: OpencodeSession[]): {
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
  // Malformed cyclic graphs have no natural root. Keep one representative per
  // uncovered component importable, and let `descendantsOf` break the cycle.
  for (const session of importable) {
    if (!covered.has(session.id)) addRoot(session)
  }
  return { roots, descendantsOf }
}

// One import run reuses the same `SessionScanInput` object for every ref, so a
// per-input cache turns the previous O(selected sessions × full-DB read) into a
// single DB read per run. Keyed weakly: a fresh scan builds a fresh input, so
// there is no staleness across runs and no explicit invalidation needed.
const sessionCache = new WeakMap<SessionScanInput, Promise<OpencodeSession[]>>()

async function collectSessions(input: SessionScanInput): Promise<OpencodeSession[]> {
  const cached = sessionCache.get(input)
  if (cached) return cached
  const promise = input.pickedFiles?.length
    ? Promise.resolve(
        input.pickedFiles
          .filter((f) => f.name.toLowerCase().endsWith(".json"))
          .flatMap((f) => parseOpencodeExport(f.content))
      )
    : readOpencodeSessions(input.home)
  // Evict a FAILED read so the next attempt actually retries. A rejected promise
  // left in the cache would make one locked-database moment poison every later
  // scan that happens to reuse this input.
  const guarded = promise.catch((error: unknown) => {
    sessionCache.delete(input)
    throw error
  })
  sessionCache.set(input, guarded)
  return guarded
}

import { opencodeCodec } from "@/lib/session-import/codecs/opencode-codec"

export const opencodeSessionSource: AgentSessionSourceAdapter = {
  codec: opencodeCodec,
  id: "opencode",
  displayName: "OpenCode",
  labelKey: "opencode",
  verifiedVersion: "1.18.25",
  verifiedAt: "2026-08-29",
  acceptedExtensions: ACCEPTED,

  // The scan itself goes through the Rust SQLite reader (keyed by home), not a
  // dir walk — but the roots still matter: they feed the fs-watcher
  // (`collectWatchRoots`), and the watcher already recognizes `.db` files. An
  // empty list here meant OpenCode never got incremental re-imports.
  scanRoots(home, roots) {
    return opencodeDataDirs(home, roots?.opencodeDataDir, roots?.opencodePlatformDataDir)
  },

  detect(files: PickedSessionFile[]) {
    if (files.length === 0) return "no"
    const looks = files.some((f) => {
      const p = f.path.replace(/\\/g, "/")
      if (p.includes("opencode")) return true
      try {
        const data = JSON.parse(f.content)
        if (Array.isArray(data)) {
          return data.some(
            (r) => typeof r?.key === "string" && /^(session|message|part)/.test(r.key)
          )
        }
        return !!(data?.messages && (data?.id || data?.session))
      } catch {
        return false
      }
    })
    return looks ? "maybe" : "no"
  },

  async listSessions(input: SessionScanInput) {
    const sessions = await collectSessions(input)
    const tree = sessionTree(sessions)
    return tree.roots
      .map((session) => {
        const descendants = tree.descendantsOf(session.id)
        const updatedAt = descendants.reduce(
          (newest, descendant) => Math.max(newest, descendant.updatedAt),
          session.updatedAt
        )
        return summarize(session, descendants, updatedAt)
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
  },

  async parseSession(ref: SessionRef, input: SessionScanInput) {
    const sessions = await collectSessions(input)
    const found = sessions.find((s) => s.id === ref.originalSessionId)
    if (!found) {
      // Empty shell rather than throwing — keeps a multi-import batch resilient.
      return opencodeToConversation({
        id: ref.originalSessionId,
        title: "OpenCode session",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      })
    }
    const importable = sessions.filter((session) => session.messages.length > 0)
    const childrenByParent = new Map<string, OpencodeSession[]>()
    for (const session of importable) {
      if (!session.parentId) continue
      const children = childrenByParent.get(session.parentId) ?? []
      children.push(session)
      childrenByParent.set(session.parentId, children)
    }
    const buildTree = (session: OpencodeSession, seen: Set<string>): ImportedConversation => {
      const conversation = opencodeToConversation(session)
      if (seen.has(session.id)) return conversation
      const nextSeen = new Set(seen).add(session.id)
      const nested = (childrenByParent.get(session.id) ?? [])
        .filter((child) => !nextSeen.has(child.id))
        .map((child) => buildTree(child, nextSeen))
      if (nested.length > 0) conversation.nested = nested
      return conversation
    }
    return buildTree(found, new Set())
  },
  async parseGraph(ref: SessionRef, input: SessionScanInput) {
    const sessions = await collectSessions(input)
    const graph = buildImportedSessionGraph(await this.parseSession(ref, input), {
      sourceRuntime: this.id,
      sourceVersion: this.verifiedVersion,
      verifiedAt: this.verifiedAt,
      importFidelity: this.codec?.importFidelity ?? "structured",
      codec: this.codec,
    })
    const sessionById = new Map(sessions.map((session) => [session.id, session]))
    for (const node of graph.nodes) {
      const nativeId = node.conversation.session.id.replace(/^import:opencode:/, "")
      const native = sessionById.get(nativeId)
      if (!native) continue
      const state = opencodeStructuredState(native)
      if (state.tasks.length > 0) node.session.tasks = state.tasks
      if (state.history.length > 0) node.session.history = state.history
      if (state.recordedEvents.length > 0) node.session.recordedEvents = state.recordedEvents
    }
    return graph
  },
}
