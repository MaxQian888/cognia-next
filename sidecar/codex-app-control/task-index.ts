import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { SQLInputValue } from "node:sqlite"

const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_LIMIT = 200
const MAX_QUERY_LENGTH = 500

type ArchivedFilter = "active" | "archived" | "all"
type TaskScope = "workspace" | "all"

export interface ListCodexTasksOptions {
  limit?: unknown
  query?: unknown
  archived?: unknown
  scope?: unknown
  workspace?: unknown
  includeSubagents?: unknown
  cursor?: unknown
}

interface TaskCursor {
  recencyAtMs: number
  id: string
}

interface NormalizedOptions {
  limit: number
  query: string
  archived: ArchivedFilter
  scope: TaskScope
  workspace: string | null
  includeSubagents: boolean
  cursor: TaskCursor | null
}

export interface CodexTask {
  id: string
  title: string
  generatedTitle: string | null
  name: string | null
  preview: string
  cwd: string | null
  createdAt: string | null
  updatedAt: string | null
  recencyAt: string | null
  archived: boolean
  pinned: boolean
  source: string | null
  model: string | null
}

export interface CodexTaskList {
  source: "state-db" | "session-index"
  tasks: CodexTask[]
  total: number
  nextCursor: string | null
  degraded?: boolean
  warning?: string
}

/** The slice of `node:sqlite`'s DatabaseSync this module uses (injectable for tests). */
export type DatabaseConstructor = new (
  path: string,
  options: { readOnly: boolean }
) => {
  prepare(sql: string): {
    all(...values: SQLInputValue[]): unknown[]
    get(...values: SQLInputValue[]): unknown
  }
  close(): void
}

export interface ListCodexTasksDependencies {
  codexHome?: string
  databasePath?: string
  indexPath?: string
  DatabaseSync?: DatabaseConstructor
}

function boundedText(value: unknown, maxLength = 500): string {
  const text = typeof value === "string" ? value.trim() : ""
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

function isoFromMilliseconds(value: number): string | null {
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null
}

function encodeCursor(value: TaskCursor): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

function decodeCursor(value: unknown): TaskCursor | null {
  if (value == null || value === "") return null
  if (typeof value !== "string" || value.length > 500) throw new Error("task cursor is invalid")
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as Partial<TaskCursor>
    if (
      !Number.isSafeInteger(parsed.recencyAtMs) ||
      (parsed.recencyAtMs as number) < 0 ||
      typeof parsed.id !== "string" ||
      !THREAD_ID_PATTERN.test(parsed.id)
    ) {
      throw new Error("invalid cursor fields")
    }
    return { recencyAtMs: parsed.recencyAtMs as number, id: parsed.id }
  } catch {
    throw new Error("task cursor is invalid")
  }
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")
}

const ARCHIVED_FILTERS: ReadonlySet<unknown> = new Set(["active", "archived", "all"])
const TASK_SCOPES: ReadonlySet<unknown> = new Set(["workspace", "all"])

function normalizeOptions(options: ListCodexTasksOptions = {}): NormalizedOptions {
  const limit = Number(options.limit ?? 50)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`task list limit must be between 1 and ${MAX_LIMIT}`)
  }
  const query = String(options.query ?? "").trim()
  if (query.length > MAX_QUERY_LENGTH) {
    throw new Error(`task list query exceeds ${MAX_QUERY_LENGTH} characters`)
  }
  const archived = options.archived ?? "active"
  if (!ARCHIVED_FILTERS.has(archived)) {
    throw new Error("task archived filter must be active, archived, or all")
  }
  const scope = options.scope ?? "workspace"
  if (!TASK_SCOPES.has(scope)) {
    throw new Error("task scope must be workspace or all")
  }
  const workspace = options.workspace ? resolve(String(options.workspace)) : null
  if (scope === "workspace" && !workspace)
    throw new Error("workspace is required for workspace scope")
  return {
    limit,
    query,
    archived: archived as ArchivedFilter,
    scope: scope as TaskScope,
    workspace,
    includeSubagents: options.includeSubagents === true,
    cursor: decodeCursor(options.cursor),
  }
}

/** A `threads` row as SELECTed below; SQLite hands back loosely typed columns. */
type ThreadRow = Record<string, unknown>

function publicTask(row: ThreadRow): CodexTask {
  const title =
    boundedText(row.name || row.title || row.preview || row.first_user_message) || "Untitled task"
  return {
    id: String(row.id),
    title,
    generatedTitle: boundedText(row.title) || null,
    name: boundedText(row.name) || null,
    preview: boundedText(row.preview || row.first_user_message),
    cwd: typeof row.cwd === "string" && row.cwd ? row.cwd : null,
    createdAt: isoFromMilliseconds(Number(row.created_at_ms)),
    updatedAt: isoFromMilliseconds(Number(row.updated_at_ms)),
    recencyAt: isoFromMilliseconds(Number(row.recency_at_ms)),
    archived: Boolean(row.archived),
    pinned: Boolean(row.is_pinned),
    source: boundedText(row.source, 160) || null,
    model: boundedText(row.model, 160) || null,
  }
}

function buildFilters(
  options: NormalizedOptions,
  { includeCursor = true }: { includeCursor?: boolean } = {}
): { where: string; values: SQLInputValue[] } {
  const clauses = ["preview <> ''"]
  const values: SQLInputValue[] = []
  if (!options.includeSubagents) clauses.push("source NOT LIKE '%\"subagent\"%'")
  if (options.archived !== "all") {
    clauses.push("archived = ?")
    values.push(options.archived === "archived" ? 1 : 0)
  }
  if (options.scope === "workspace") {
    clauses.push("cwd = ?")
    values.push(options.workspace)
  }
  if (options.query) {
    const pattern = `%${escapeLike(options.query)}%`
    clauses.push(
      "(id LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR preview LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\')"
    )
    values.push(pattern, pattern, pattern, pattern, pattern)
  }
  if (includeCursor && options.cursor) {
    clauses.push("(recency_at_ms < ? OR (recency_at_ms = ? AND id < ?))")
    values.push(options.cursor.recencyAtMs, options.cursor.recencyAtMs, options.cursor.id)
  }
  return { where: clauses.join(" AND "), values }
}

function listFromDatabase(
  databasePath: string,
  options: NormalizedOptions,
  Database: DatabaseConstructor = DatabaseSync
): CodexTaskList {
  const database = new Database(databasePath, { readOnly: true })
  try {
    const filtered = buildFilters(options)
    const countFilter = buildFilters(options, { includeCursor: false })
    const rows = database
      .prepare(
        `SELECT id, title, name, preview, first_user_message, cwd,
                created_at_ms, updated_at_ms, recency_at_ms,
                archived, is_pinned, source, model
         FROM threads
         WHERE ${filtered.where}
         ORDER BY recency_at_ms DESC, id DESC
         LIMIT ?`
      )
      .all(...filtered.values, options.limit + 1) as ThreadRow[]
    const counted = database
      .prepare(`SELECT COUNT(*) AS count FROM threads WHERE ${countFilter.where}`)
      .get(...countFilter.values) as { count: unknown }
    const total = Number(counted.count)
    const hasMore = rows.length > options.limit
    const visibleRows = hasMore ? rows.slice(0, options.limit) : rows
    const tasks = visibleRows.map(publicTask)
    const last = visibleRows.at(-1)
    return {
      source: "state-db",
      tasks,
      total,
      nextCursor:
        hasMore && last
          ? encodeCursor({ recencyAtMs: Number(last.recency_at_ms), id: String(last.id) })
          : null,
    }
  } finally {
    database.close()
  }
}

async function listFromSessionIndex(
  indexPath: string,
  options: NormalizedOptions
): Promise<CodexTaskList> {
  const text = await readFile(indexPath, "utf8")
  let tasks = text
    .split("\n")
    .filter(Boolean)
    .flatMap((line): CodexTask[] => {
      try {
        const value = JSON.parse(line) as Record<string, unknown>
        if (typeof value.id !== "string" || !THREAD_ID_PATTERN.test(value.id)) return []
        const updatedAt =
          typeof value.updated_at === "string" && value.updated_at ? value.updated_at : null
        return [
          {
            id: value.id,
            title: boundedText(value.thread_name) || "Untitled task",
            generatedTitle: boundedText(value.thread_name) || null,
            name: null,
            preview: "",
            cwd: null,
            createdAt: null,
            updatedAt,
            recencyAt: updatedAt,
            archived: false,
            pinned: false,
            source: "session-index",
            model: null,
          },
        ]
      } catch {
        return []
      }
    })
  if (options.archived === "archived") tasks = []
  if (options.query) {
    const query = options.query.toLocaleLowerCase()
    tasks = tasks.filter((task) => `${task.id}\n${task.title}`.toLocaleLowerCase().includes(query))
  }
  tasks.sort((left, right) => String(right.recencyAt).localeCompare(String(left.recencyAt)))
  const total = tasks.length
  return {
    source: "session-index",
    tasks: tasks.slice(0, options.limit),
    total,
    nextCursor: null,
    degraded: true,
  }
}

export async function listCodexTasks(
  options: ListCodexTasksOptions = {},
  dependencies: ListCodexTasksDependencies = {}
): Promise<CodexTaskList> {
  const normalized = normalizeOptions(options)
  const codexHome = dependencies.codexHome ?? join(homedir(), ".codex")
  try {
    return listFromDatabase(
      dependencies.databasePath ?? join(codexHome, "state_5.sqlite"),
      normalized,
      dependencies.DatabaseSync ?? DatabaseSync
    )
  } catch (databaseError) {
    if (normalized.cursor) throw databaseError
    const fallback = await listFromSessionIndex(
      dependencies.indexPath ?? join(codexHome, "session_index.jsonl"),
      normalized
    )
    return {
      ...fallback,
      warning: `state database unavailable: ${databaseError instanceof Error ? databaseError.message : String(databaseError)}`,
    }
  }
}
