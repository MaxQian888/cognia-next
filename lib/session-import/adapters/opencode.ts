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
  })
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
  }
}

function summarize(session: OpencodeSession): SessionSummary {
  return {
    ref: { sourceId: "opencode", originalSessionId: session.id, locator: session.id },
    title: session.title,
    sourceId: "opencode",
    messageCount: session.messages.length,
    updatedAt: session.updatedAt,
    cwd: session.cwd,
  }
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
  sessionCache.set(input, promise)
  return promise
}

export const opencodeSessionSource: AgentSessionSourceAdapter = {
  id: "opencode",
  displayName: "OpenCode",
  labelKey: "opencode",
  acceptedExtensions: ACCEPTED,

  // The scan itself goes through the Rust SQLite reader (keyed by home), not a
  // dir walk — but the roots still matter: they feed the fs-watcher
  // (`collectWatchRoots`), and the watcher already recognizes `.db` files. An
  // empty list here meant OpenCode never got incremental re-imports.
  scanRoots(home: string) {
    return opencodeDataDirs(home)
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
    const known = new Set(sessions.map((s) => s.id))
    return (
      sessions
        .filter((s) => s.messages.length > 0)
        // Child (subagent) sessions ride along as `nested` conversations of their
        // parent (see parseSession) — only list them when the parent is missing
        // from the store (otherwise they'd be unreachable).
        .filter((s) => !s.parentId || !known.has(s.parentId))
        .map(summarize)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    )
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
    const conv = opencodeToConversation(found)
    // Attach subagent (child) sessions as nested conversations (ADR-0062), so
    // they import alongside their parent instead of as orphan top-level rows.
    const nested = sessions
      .filter((s) => s.parentId === found.id && s.messages.length > 0)
      .map((s) => opencodeToConversation(s))
    if (nested.length > 0) conv.nested = nested
    return conv
  },
}
