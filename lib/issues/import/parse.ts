/**
 * Turn a file into rows the tracker can create (spec 2026-09-06, Import).
 *
 * Three formats, one output shape:
 *   csv       a header row, then one issue per record. Column names are
 *             matched case-insensitively against a small vocabulary (title,
 *             description, status, priority, assignee, labels, due, estimate,
 *             parent, id), with common aliases.
 *   json      the tracker's own export (`{ issues: [...] }`) or a bare array
 *             of objects with the same keys as the CSV columns.
 *   markdown  task lists. `- [ ] title` and `- [x] title` are issues,
 *             `#` headings are parents of the items under them, indentation
 *             nests one item under the previous less-indented one.
 *
 * Every row gets a stable `externalId` from its content, so importing the
 * same file twice creates nothing the second time (`import:<format>` refs).
 * The parser never touches Dexie. `apply.ts` does.
 */

import { parseCsv } from "@/lib/ai/eval/import/parse-tabular"
import type { IssuePriority, IssueStatus } from "@/types/issues"
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "@/types/issues"

export const ISSUE_IMPORT_FORMATS = ["csv", "json", "markdown"] as const
export type IssueImportFormat = (typeof ISSUE_IMPORT_FORMATS)[number]

export interface ImportedIssue {
  /** Stable per row content, so a re-import dedupes. */
  externalId: string
  title: string
  description?: string
  status?: IssueStatus
  priority?: IssuePriority
  assigneeLabel?: string
  labels: string[]
  dueDate?: number
  estimate?: number
  /** `externalId` of the parent row within the same import. */
  parentExternalId?: string
  /** The source's own id or identifier, kept as the ref's label. */
  sourceId?: string
}

export interface IssueImportParse {
  format: IssueImportFormat
  rows: ImportedIssue[]
  /** Rows dropped for having no title, with their line or index. */
  skipped: Array<{ index: number; reason: "no-title" }>
}

/** FNV-1a over the row's identity, as 8 hex chars. Deterministic, fast, enough. */
export function stableRowId(parts: readonly (string | undefined)[]): string {
  const text = parts.map((part) => (part ?? "").trim().toLowerCase()).join(" ")
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

const COLUMN_ALIASES: Record<
  keyof Omit<ImportedIssue, "externalId" | "labels"> | "labels",
  string[]
> = {
  title: ["title", "summary", "name", "subject", "issue"],
  description: ["description", "body", "details", "notes"],
  status: ["status", "state", "column"],
  priority: ["priority", "prio"],
  assigneeLabel: ["assignee", "owner", "assigned to", "assigned_to"],
  labels: ["labels", "tags", "label", "tag"],
  dueDate: ["due", "due date", "due_date", "duedate", "deadline"],
  estimate: ["estimate", "points", "story points", "story_points", "effort"],
  parentExternalId: ["parent", "parent id", "parent_id", "epic"],
  sourceId: ["id", "key", "identifier", "issue id", "issue_id", "number"],
}

function normalizeHeader(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
}

/** Map a header row to the fields it carries. Unknown columns are ignored. */
export function resolveColumns(headers: readonly string[]): Map<keyof ImportedIssue, string> {
  const out = new Map<keyof ImportedIssue, string>()
  for (const header of headers) {
    const key = normalizeHeader(header)
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as Array<
      [keyof ImportedIssue, string[]]
    >) {
      if (out.has(field)) continue
      if (aliases.some((alias) => normalizeHeader(alias) === key)) {
        out.set(field, header)
        break
      }
    }
  }
  return out
}

export function parseStatus(value: unknown): IssueStatus | undefined {
  if (typeof value !== "string") return undefined
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
  if ((ISSUE_STATUSES as readonly string[]).includes(key)) return key as IssueStatus
  const aliases: Record<string, IssueStatus> = {
    open: "todo",
    new: "backlog",
    doing: "in_progress",
    wip: "in_progress",
    started: "in_progress",
    review: "in_review",
    reviewing: "in_review",
    closed: "done",
    complete: "done",
    completed: "done",
    resolved: "done",
    cancelled: "canceled",
    wontfix: "canceled",
    "won't_fix": "canceled",
  }
  return aliases[key]
}

export function parsePriority(value: unknown): IssuePriority | undefined {
  if (typeof value !== "string") return undefined
  const key = value.trim().toLowerCase()
  if ((ISSUE_PRIORITIES as readonly string[]).includes(key)) return key as IssuePriority
  const aliases: Record<string, IssuePriority> = {
    p0: "urgent",
    critical: "urgent",
    highest: "urgent",
    p1: "high",
    p2: "medium",
    normal: "medium",
    p3: "low",
    lowest: "low",
    p4: "low",
  }
  return aliases[key]
}

export function parseDate(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string" || !value.trim()) return undefined
  const text = value.trim()
  const ymd = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text)
  if (ymd) return new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]), 12).getTime()
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? undefined : parsed
}

export function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value !== "string" || !value.trim()) return undefined
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) ? parsed : undefined
}

export function parseLabels(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean)
  }
  if (typeof value !== "string") return []
  return value
    .split(/[,;|]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function textOf(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const text = String(value).trim()
  return text ? text : undefined
}

/** One generic object (a CSV record or a JSON element) to a row. */
function rowFromObject(
  raw: Record<string, unknown>,
  columns: Map<keyof ImportedIssue, string>,
  format: IssueImportFormat,
  index: number
): ImportedIssue | null {
  const read = (field: keyof ImportedIssue): unknown => {
    const column = columns.get(field)
    return column === undefined ? undefined : raw[column]
  }
  const title = textOf(read("title"))
  if (!title) return null
  const sourceId = textOf(read("sourceId"))
  const description = textOf(read("description"))
  const parent = textOf(read("parentExternalId"))
  const row: ImportedIssue = {
    externalId: stableRowId([
      format,
      sourceId ?? `${index}`,
      title,
      sourceId ? undefined : description,
    ]),
    title,
    labels: parseLabels(read("labels")),
    ...(description ? { description } : {}),
    ...(sourceId ? { sourceId } : {}),
  }
  const status = parseStatus(read("status"))
  if (status) row.status = status
  const priority = parsePriority(read("priority"))
  if (priority) row.priority = priority
  const assignee = textOf(read("assigneeLabel"))
  if (assignee) row.assigneeLabel = assignee
  const due = parseDate(read("dueDate"))
  if (due !== undefined) row.dueDate = due
  const estimate = parseNumber(read("estimate"))
  if (estimate !== undefined) row.estimate = estimate
  if (parent) row.parentExternalId = parent
  return row
}

/**
 * After every row is known, a `parentExternalId` that names another row's
 * `sourceId` is rewritten to that row's `externalId`. Unknown parents are
 * dropped rather than left dangling.
 */
function linkParents(rows: ImportedIssue[]): void {
  const bySource = new Map<string, string>()
  for (const row of rows) {
    if (row.sourceId) bySource.set(row.sourceId.toLowerCase(), row.externalId)
  }
  for (const row of rows) {
    if (!row.parentExternalId) continue
    const target = bySource.get(row.parentExternalId.toLowerCase())
    if (target && target !== row.externalId) row.parentExternalId = target
    else delete row.parentExternalId
  }
}

export function parseCsvIssues(text: string): IssueImportParse {
  const parsed = parseCsv(text)
  const columns = resolveColumns(parsed.columns)
  const rows: ImportedIssue[] = []
  const skipped: IssueImportParse["skipped"] = []
  parsed.rows.forEach((raw, index) => {
    const row = rowFromObject(raw, columns, "csv", index)
    if (row) rows.push(row)
    else skipped.push({ index, reason: "no-title" })
  })
  linkParents(rows)
  return { format: "csv", rows, skipped }
}

export function parseJsonIssues(text: string): IssueImportParse {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error("Not valid JSON")
  }
  const list: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { issues?: unknown }).issues)
      ? ((data as { issues: unknown[] }).issues as unknown[])
      : []
  const rows: ImportedIssue[] = []
  const skipped: IssueImportParse["skipped"] = []
  list.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      skipped.push({ index, reason: "no-title" })
      return
    }
    const raw = entry as Record<string, unknown>
    // The tracker's own export nests nothing, but stores `assignee` as an
    // actor and `parentId` as an id. Flatten both onto the column vocabulary.
    const flat: Record<string, unknown> = { ...raw }
    if (raw.assignee && typeof raw.assignee === "object") {
      flat.assignee = (raw.assignee as { label?: string }).label
    }
    if (typeof raw.parentId === "string") flat.parent = raw.parentId
    if (typeof raw.identifier === "string") flat.id = raw.identifier
    else if (typeof raw.id === "string") flat.id = raw.id
    if (Array.isArray(raw.labelNames)) flat.labels = raw.labelNames
    const columns = resolveColumns(Object.keys(flat))
    const row = rowFromObject(flat, columns, "json", index)
    if (row) rows.push(row)
    else skipped.push({ index, reason: "no-title" })
  })
  linkParents(rows)
  return { format: "json", rows, skipped }
}

const TASK_LINE = /^(\s*)[-*+]\s+\[( |x|X)\]\s+(.+?)\s*$/
const HEADING_LINE = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const BULLET_LINE = /^(\s*)[-*+]\s+(?!\[)(.+?)\s*$/

/**
 * Task lists. Headings become parents. A task nested (by indentation) under
 * another task becomes its child. Plain bullets under a task are its
 * description lines.
 */
export function parseMarkdownIssues(text: string): IssueImportParse {
  const rows: ImportedIssue[] = []
  const skipped: IssueImportParse["skipped"] = []
  let heading: ImportedIssue | null = null
  const stack: Array<{ indent: number; row: ImportedIssue }> = []
  let last: ImportedIssue | null = null

  text.split(/\r?\n/).forEach((line, index) => {
    const headingMatch = HEADING_LINE.exec(line)
    if (headingMatch) {
      const title = headingMatch[2].trim()
      heading = {
        externalId: stableRowId(["markdown", "heading", title, `${index}`]),
        title,
        labels: [],
      }
      rows.push(heading)
      stack.length = 0
      last = heading
      return
    }
    const task = TASK_LINE.exec(line)
    if (task) {
      const indent = task[1].replace(/\t/g, "  ").length
      const title = task[3].trim()
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
      const parent = stack[stack.length - 1]?.row ?? heading
      const row: ImportedIssue = {
        externalId: stableRowId(["markdown", parent?.externalId, title]),
        title,
        labels: [],
        ...(task[2] !== " " ? { status: "done" as const } : {}),
        ...(parent ? { parentExternalId: parent.externalId } : {}),
      }
      rows.push(row)
      stack.push({ indent, row })
      last = row
      return
    }
    const bullet = BULLET_LINE.exec(line)
    if (bullet && last && last !== heading) {
      last.description = last.description ? `${last.description}\n${bullet[2]}` : bullet[2]
      return
    }
    if (line.trim() && last && last !== heading && !TASK_LINE.test(line)) {
      // Indented continuation text under a task.
      if (/^\s+\S/.test(line)) {
        last.description = last.description ? `${last.description}\n${line.trim()}` : line.trim()
      }
    }
  })
  return { format: "markdown", rows, skipped }
}

/** Guess the format from the file name, then from the content. */
export function detectIssueImportFormat(text: string, fileName?: string): IssueImportFormat {
  const ext = fileName?.toLowerCase().split(".").pop()
  if (ext === "csv") return "csv"
  if (ext === "json") return "json"
  if (ext === "md" || ext === "markdown") return "markdown"
  const trimmed = text.trim()
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return "json"
  if (/^\s*[-*+]\s+\[( |x|X)\]/m.test(trimmed) || /^#{1,6}\s/m.test(trimmed)) return "markdown"
  return "csv"
}

export function parseIssueImport(format: IssueImportFormat, text: string): IssueImportParse {
  switch (format) {
    case "csv":
      return parseCsvIssues(text)
    case "json":
      return parseJsonIssues(text)
    case "markdown":
      return parseMarkdownIssues(text)
  }
}
