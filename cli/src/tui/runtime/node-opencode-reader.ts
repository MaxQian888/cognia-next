/**
 * Node-side OpenCode SQLite reader for the standalone CLI.
 *
 * The desktop reads OpenCode's store through the Rust `opencode_sessions_read`
 * command (`src-tauri/src/session_import.rs`), which the CLI can't call. This
 * mirrors that reader over Node's built-in `node:sqlite` (Node 22.5+): same
 * schema-tolerant grouping (session / message / part tables, polymorphic `data`
 * JSON folded into the row) and the same normalized `OpencodeSession[]` shape,
 * incl. the per-turn `model` / `cost` / `tokens` projection.
 *
 * Graceful degradation: if `node:sqlite` is unavailable (Node < 22.5, or the
 * experimental module is disabled) or the DB is absent, it returns `[]` — the
 * CLI's Claude Code / Codex sources are unaffected. Installed via
 * `setOpencodeReader(nodeOpencodeReader)` in the agent-stats controller.
 */
import fs from "node:fs"
import path from "node:path"

import type {
  OpencodeMessage,
  OpencodeBackgroundJob,
  OpencodePart,
  OpencodeSession,
  OpencodeTokens,
} from "@/lib/session-import/adapters/opencode-db"

type Row = Record<string, unknown>

/** Minimal structural view of the `node:sqlite` surface we use. */
interface SqliteDb {
  prepare(sql: string): { all(): unknown[] }
  close(): void
}
interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDb
}

/** Candidate on-disk locations for `opencode.db`, most-specific first. */
export function candidateDbPaths(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string[] {
  const out: string[] = []
  const push = (candidate: string) => {
    if (!out.includes(candidate)) out.push(candidate)
  }
  const xdg = env.XDG_DATA_HOME
  if (xdg) push(path.join(xdg, "opencode", "opencode.db"))
  // OpenCode currently uses this XDG-style path on every observed platform.
  push(path.join(home, ".local", "share", "opencode", "opencode.db"))
  // Match `dirs::data_dir()` in the desktop reader without letting a generic
  // platform fallback shadow the known store above.
  if (platform === "win32" && env.APPDATA) {
    push(path.join(env.APPDATA, "opencode", "opencode.db"))
  } else if (platform === "darwin") {
    push(path.join(home, "Library", "Application Support", "opencode", "opencode.db"))
  }
  push(path.join(home, "AppData", "Roaming", "opencode", "opencode.db"))
  return out
}

async function loadSqlite(): Promise<SqliteModule | null> {
  try {
    return (await import("node:sqlite")) as unknown as SqliteModule
  } catch {
    return null
  }
}

/**
 * Whether this Node runtime can read OpenCode's SQLite store (`node:sqlite`,
 * Node 22.5+). Lets the CLI tell the user OpenCode was skipped instead of
 * silently showing zero OpenCode sessions on older Node versions.
 */
export async function isNodeSqliteAvailable(): Promise<boolean> {
  return (await loadSqlite()) !== null
}

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "bigint") return Number(v)
  return 0
}

function firstStr(map: Row, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = map[k]
    if (typeof v === "string" && v) return v
  }
  return undefined
}

function nestedNum(map: Row, obj: string, key: string, flat: string[]): number {
  const o = map[obj]
  if (o && typeof o === "object") {
    const v = (o as Row)[key]
    if (typeof v === "number" || typeof v === "bigint") return num(v)
  }
  for (const k of flat) {
    const v = map[k]
    if (typeof v === "number" || typeof v === "bigint") return num(v)
  }
  return 0
}

/** Fold a `data` JSON column into the row; existing row columns win (like Rust). */
function foldData(row: Row): Row {
  const data = row.data
  if (typeof data === "string") {
    try {
      const inner = JSON.parse(data)
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        return { ...(inner as Row), ...row }
      }
    } catch {
      // Non-JSON `data` — leave the row as-is.
    }
  }
  return row
}

function tableNames(db: SqliteDb): string[] {
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Row[])
      .map((r) => (typeof r.name === "string" ? r.name : ""))
      .filter(Boolean)
  } catch {
    return []
  }
}

function rowsAsMaps(db: SqliteDb, table: string): Row[] {
  try {
    return (db.prepare(`SELECT * FROM "${table}"`).all() as Row[]).map(foldData)
  } catch {
    return []
  }
}

function findTable(tables: string[], want: string): string | undefined {
  return (
    tables.find((t) => t.toLowerCase() === want) ??
    tables.find((t) => t.toLowerCase() === `${want}s`) ??
    tables.find((t) => {
      const l = t.toLowerCase()
      return (l.includes(want) && !l.includes("message") && !l.includes("part")) || l === want
    })
  )
}

/** Project an assistant `data.tokens` block into the normalized shape, or `undefined`. */
function messageTokens(m: Row): OpencodeTokens | undefined {
  const tk = m.tokens
  if (!tk || typeof tk !== "object") return undefined
  const t = tk as Row
  const cache = (t.cache && typeof t.cache === "object" ? t.cache : {}) as Row
  const input = num(t.input)
  const output = num(t.output)
  // Reasoning tokens are billed output-side; dropping them undercounts
  // thinking-heavy models (mirrors the Rust reader and the live adapter).
  const reasoning = num(t.reasoning)
  const cacheRead = num(cache.read)
  const cacheWrite = num(cache.write)
  if (!input && !output && !reasoning && !cacheRead && !cacheWrite) return undefined
  return { input, output, reasoning, cacheRead, cacheWrite }
}

/**
 * Build normalized sessions from an open DB. Exported for tests (which seed an
 * in-memory `DatabaseSync`).
 */
export function buildSessions(db: SqliteDb): OpencodeSession[] {
  const tables = tableNames(db)
  const sessionTbl = findTable(tables, "session") ?? "session"
  const messageTbl = tables.find((t) => t.toLowerCase().includes("message")) ?? "message"
  const partTbl =
    tables.find((t) => t.toLowerCase() === "part" || t.toLowerCase().includes("part")) ?? "part"

  const sessions = rowsAsMaps(db, sessionTbl)
  const messages = rowsAsMaps(db, messageTbl)
  const parts = rowsAsMaps(db, partTbl)
  const jobTbl = tables.find((table) => {
    const name = table.toLowerCase()
    return name === "job" || name === "jobs" || name.includes("background_job")
  })
  const jobs = jobTbl ? rowsAsMaps(db, jobTbl) : []

  const jobsBySession = new Map<string, OpencodeBackgroundJob[]>()
  for (const job of jobs) {
    const sessionId = firstStr(job, ["sessionID", "session_id", "sessionId"])
    const id = firstStr(job, ["id", "jobID", "job_id"])
    if (!sessionId || !id) continue
    const value: OpencodeBackgroundJob = {
      id,
      status: firstStr(job, ["status", "state"]),
      description: firstStr(job, ["description", "title", "name"]),
      parentId: firstStr(job, ["parentID", "parent_id", "parentId"]),
      dependencies: Array.isArray(job.dependencies)
        ? job.dependencies.filter((item): item is string => typeof item === "string")
        : Array.isArray(job.blockedBy)
          ? job.blockedBy.filter((item): item is string => typeof item === "string")
          : undefined,
      createdAt: nestedNum(job, "time", "created", ["created", "time_created"]),
      updatedAt: nestedNum(job, "time", "updated", ["updated", "time_updated"]),
      error: firstStr(job, ["error", "errorText"]),
    }
    const grouped = jobsBySession.get(sessionId) ?? []
    grouped.push(value)
    jobsBySession.set(sessionId, grouped)
  }

  // `SELECT *` gives table-scan order — sort parts by id (lexicographically
  // ordered ULIDs) and messages by createdAt for a deterministic transcript.
  const partsByMsg = new Map<string, Array<{ pid: string; part: OpencodePart }>>()
  for (const p of parts) {
    const mid = firstStr(p, ["messageID", "message_id", "messageId"])
    if (!mid) continue
    const arr = partsByMsg.get(mid) ?? []
    arr.push({ pid: firstStr(p, ["id"]) ?? "", part: p as unknown as OpencodePart })
    partsByMsg.set(mid, arr)
  }
  for (const arr of partsByMsg.values()) {
    arr.sort((a, b) => (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0))
  }

  const msgsBySession = new Map<string, OpencodeMessage[]>()
  for (const m of messages) {
    const sid = firstStr(m, ["sessionID", "session_id", "sessionId"])
    if (!sid) continue
    const mid = firstStr(m, ["id"]) ?? ""
    const msg: OpencodeMessage = {
      role: firstStr(m, ["role"]) ?? "user",
      createdAt: nestedNum(m, "time", "created", ["created", "time_created"]),
      parts: (partsByMsg.get(mid) ?? []).map((e) => e.part),
    }
    const model = firstStr(m, ["modelID", "model"])
    if (model) msg.model = model
    if (typeof m.cost === "number") msg.cost = m.cost
    const tokens = messageTokens(m)
    if (tokens) msg.tokens = tokens
    const arr = msgsBySession.get(sid) ?? []
    arr.push(msg)
    msgsBySession.set(sid, arr)
  }
  for (const arr of msgsBySession.values()) {
    arr.sort((a, b) => a.createdAt - b.createdAt)
  }

  const out: OpencodeSession[] = []
  for (const s of sessions) {
    const id = firstStr(s, ["id"])
    if (!id) continue
    const created = nestedNum(s, "time", "created", ["created", "time_created"])
    const updated = nestedNum(s, "time", "updated", ["updated", "time_updated"])
    out.push({
      id,
      title: firstStr(s, ["title"]) ?? "OpenCode session",
      cwd: firstStr(s, ["directory", "cwd"]),
      model: firstStr(s, ["model"]),
      parentId: firstStr(s, ["parentID", "parent_id", "parentId"]),
      createdAt: created,
      updatedAt: updated !== 0 ? updated : created,
      messages: msgsBySession.get(id) ?? [],
      jobs: jobsBySession.get(id),
    })
  }
  return out
}

/** Read every OpenCode session from the local SQLite store. `[]` off-support. */
export async function nodeOpencodeReader(home: string): Promise<OpencodeSession[]> {
  const dbPath = candidateDbPaths(home).find((p) => fs.existsSync(p))
  if (!dbPath) return []
  const sqlite = await loadSqlite()
  if (!sqlite) return []
  let db: SqliteDb
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
  } catch {
    try {
      db = new sqlite.DatabaseSync(dbPath)
    } catch {
      return []
    }
  }
  try {
    return buildSessions(db)
  } finally {
    try {
      db.close()
    } catch {
      // Best-effort close.
    }
  }
}
