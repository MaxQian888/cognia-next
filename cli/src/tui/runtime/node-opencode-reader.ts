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
export function candidateDbPaths(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = []
  const xdg = env.XDG_DATA_HOME
  if (xdg) out.push(path.join(xdg, "opencode", "opencode.db"))
  out.push(path.join(home, ".local", "share", "opencode", "opencode.db"))
  out.push(path.join(home, "AppData", "Roaming", "opencode", "opencode.db"))
  return out
}

async function loadSqlite(): Promise<SqliteModule | null> {
  try {
    return (await import("node:sqlite")) as unknown as SqliteModule
  } catch {
    return null
  }
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
  const cacheRead = num(cache.read)
  const cacheWrite = num(cache.write)
  if (!input && !output && !cacheRead && !cacheWrite) return undefined
  return { input, output, cacheRead, cacheWrite }
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

  const partsByMsg = new Map<string, OpencodePart[]>()
  for (const p of parts) {
    const mid = firstStr(p, ["messageID", "message_id", "messageId"])
    if (!mid) continue
    const arr = partsByMsg.get(mid) ?? []
    arr.push(p as unknown as OpencodePart)
    partsByMsg.set(mid, arr)
  }

  const msgsBySession = new Map<string, OpencodeMessage[]>()
  for (const m of messages) {
    const sid = firstStr(m, ["sessionID", "session_id", "sessionId"])
    if (!sid) continue
    const mid = firstStr(m, ["id"]) ?? ""
    const msg: OpencodeMessage = {
      role: firstStr(m, ["role"]) ?? "user",
      createdAt: nestedNum(m, "time", "created", ["created", "time_created"]),
      parts: partsByMsg.get(mid) ?? [],
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
      createdAt: created,
      updatedAt: updated !== 0 ? updated : created,
      messages: msgsBySession.get(id) ?? [],
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
