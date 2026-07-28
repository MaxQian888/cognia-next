/**
 * Pure helpers that distill a tool-call part into a one-line summary for the
 * "simplified" agent-flow display mode (icon + tool name + concise target).
 *
 * Kept framework-free so it is trivially unit-testable; the row component maps
 * `iconKey` to a concrete lucide icon and renders the status glyph.
 */

import type { DynamicToolUIPart, ToolUIPart } from "ai"

export type ToolPartLike = ToolUIPart | DynamicToolUIPart

/** Coarse icon bucket — resolved to a concrete lucide icon by the row UI. */
export type ToolIconKey =
  | "read"
  | "write"
  | "edit"
  | "search"
  | "glob"
  | "terminal"
  | "web"
  | "folder"
  | "notebook"
  | "task"
  | "generic"

export interface ToolSummary {
  /** Bare tool name with any `mcp__<server>__` namespace + `tool-` prefix stripped. */
  name: string
  /** Concise target (file basename, pattern, command head, url host, query…) or null. */
  target: string | null
  iconKey: ToolIconKey
}

/**
 * Strip the `tool-` part-type prefix and any `mcp__<server>__` namespace from a
 * raw part type / tool name, so `tool-mcp__cognia-tools__bash` and `tool-Bash`
 * both fold to `bash`/`Bash`. Prefer `normalizeToolName` when you hold a whole
 * part; this is for callers that only have the type string.
 */
export function bareToolName(rawType: string): string {
  // "tool-<name>" → "<name>"
  const raw = rawType.startsWith("tool-") ? rawType.slice("tool-".length) : rawType
  // Fold `mcp__<server>__<tool>` down to `<tool>`.
  const mcpMatch = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(raw)
  return mcpMatch ? mcpMatch[1] : raw
}

/**
 * Strip the `tool-` part-type prefix and any `mcp__<server>__` namespace so
 * `tool-mcp__cognia-tools__bash` and `tool-Bash` both fold to `bash`/`Bash`.
 */
export function normalizeToolName(part: ToolPartLike): string {
  const raw =
    part.type === "dynamic-tool" ? ((part as DynamicToolUIPart).toolName ?? "tool") : part.type
  return bareToolName(raw)
}

function basename(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "")
  const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"))
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

function urlHost(u: string): string {
  try {
    return new URL(u).host || u
  } catch {
    return u
  }
}

/** Collapse whitespace + clamp a target to keep the row single-line. */
export function clampTarget(value: string, max = 72): string {
  const oneLine = value.replace(/\s+/g, " ").trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

const ICON_BY_NAME: Record<string, ToolIconKey> = {
  read: "read",
  write: "write",
  edit: "edit",
  multiedit: "edit",
  notebookedit: "notebook",
  bash: "terminal",
  grep: "search",
  glob: "glob",
  ls: "folder",
  webfetch: "web",
  websearch: "web",
  todowrite: "task",
}

function iconFor(name: string): ToolIconKey {
  return ICON_BY_NAME[name.toLowerCase()] ?? "generic"
}

/** Resolve the canonical icon bucket from a raw tool name without constructing a UI part. */
export function toolIconKeyForName(rawName: string): ToolIconKey {
  return iconFor(bareToolName(rawName))
}

/**
 * Icon buckets whose bursts fold in the "simplified" agent-flow display — the
 * TUI's `groupContextRuns` philosophy: noisy *context-gathering* (read / search
 * / glob / list / web) collapses into one summary row, while the actual actions
 * (edit / write / run) stay their own prominent rows. Mirrors the CLI set
 * (`cli/src/tui/format/context-group.ts`), plus `web` per product decision.
 */
const CONTEXT_FOLD_ICONS: ReadonlySet<ToolIconKey> = new Set([
  "read",
  "search",
  "glob",
  "folder",
  "web",
])

/**
 * True for a `tool-*` part type whose tool is a context-gathering read (its icon
 * bucket is in {@link CONTEXT_FOLD_ICONS}). Used by the simplified-mode grouping
 * to fold only read/search bursts and leave edits/commands standing.
 */
export function isContextFoldTool(type: string | undefined): boolean {
  if (typeof type !== "string" || !type.startsWith("tool-")) return false
  return CONTEXT_FOLD_ICONS.has(iconFor(bareToolName(type)))
}

/**
 * Produce a compact, human-readable summary of a tool call. Never throws;
 * unknown shapes fall back to `{ name, target: null }`.
 */
export function summarizeToolCall(part: ToolPartLike): ToolSummary {
  const name = normalizeToolName(part)
  const iconKey = iconFor(name)
  const input = (part.input ?? undefined) as Record<string, unknown> | undefined

  let target: string | null = null
  if (input && typeof input === "object") {
    const lower = name.toLowerCase()
    if (lower === "read" || lower === "write" || lower === "edit" || lower === "multiedit") {
      const fp = asString(input.file_path)
      if (fp) target = basename(fp)
    } else if (lower === "notebookedit") {
      const fp = asString(input.notebook_path) ?? asString(input.file_path)
      if (fp) target = basename(fp)
    } else if (lower === "bash") {
      const cmd = asString(input.command)
      if (cmd) target = cmd
    } else if (lower === "grep") {
      target = asString(input.pattern) ?? null
    } else if (lower === "glob") {
      target = asString(input.pattern) ?? null
    } else if (lower === "ls") {
      const p = asString(input.path)
      if (p) target = basename(p) || p
    } else if (lower === "webfetch") {
      const u = asString(input.url)
      if (u) target = urlHost(u)
    } else if (lower === "websearch") {
      target = asString(input.query) ?? null
    } else {
      // Generic best-effort: first string-valued field that looks like a target.
      const candidate =
        asString(input.path) ??
        asString(input.file_path) ??
        asString(input.query) ??
        asString(input.url) ??
        asString(input.name)
      target = candidate ?? null
    }
  }

  return { name, target: target ? clampTarget(target) : null, iconKey }
}

/** One tool-name bucket for the activity-group's collapsed-state preview. */
export interface ToolTally {
  /** Display name (first-seen casing, namespace-folded). */
  name: string
  count: number
}

/**
 * Tally a run of tool calls by (case-insensitive) name, preserving first-seen
 * order, for the group header's "read ×3 · grep ×1 · edit ×1" preview. The
 * display name keeps the casing of the first occurrence.
 */
export function tallyToolNames(parts: ToolPartLike[]): ToolTally[] {
  const order: string[] = []
  const byKey = new Map<string, ToolTally>()
  for (const part of parts) {
    const name = normalizeToolName(part)
    const key = name.toLowerCase()
    const existing = byKey.get(key)
    if (existing) {
      existing.count += 1
    } else {
      byKey.set(key, { name, count: 1 })
      order.push(key)
    }
  }
  return order.map((key) => byKey.get(key)!)
}

/** Aggregate status for a run of tool calls, used by the activity-group header. */
export type AggregateStatus = "running" | "error" | "complete" | "pending"

export function aggregateToolStatus(states: ToolPartLike["state"][]): AggregateStatus {
  if (states.some((s) => s === "output-error")) return "error"
  if (states.some((s) => s === "input-available" || s === "approval-requested")) return "running"
  if (states.some((s) => s === "input-streaming")) return "pending"
  return "complete"
}

/** How many tool calls in a run errored — drives the group header's "N failed". */
export function countErroredTools(states: ToolPartLike["state"][]): number {
  return states.reduce((n, s) => (s === "output-error" ? n + 1 : n), 0)
}

/**
 * Count category for the simplified group's TUI-style summary ("3 reads · 2
 * searches"). Finer-grained than the verb-shaped {@link ToolActionCategory}:
 * it keeps globs and lists distinct from plain reads, mirroring the CLI's
 * `summarizeContextGroup`.
 */
export type ToolCountCategory = "read" | "search" | "glob" | "list" | "web" | "other"

const COUNT_BY_ICON: Record<ToolIconKey, ToolCountCategory> = {
  read: "read",
  search: "search",
  glob: "glob",
  folder: "list",
  web: "web",
  write: "other",
  edit: "other",
  notebook: "other",
  terminal: "other",
  task: "other",
  generic: "other",
}

/** One count bucket for the simplified group summary. */
export interface ToolCountTally {
  category: ToolCountCategory
  count: number
}

/**
 * Tally a run of context tool calls into ordered count categories — the input
 * to the TUI-style "3 reads · 2 searches" summary. Buckets by the same icon
 * mapping the rows use, preserving first-seen order. The component maps each
 * `category` (+ count) to a pluralised i18n label.
 */
export function summarizeContextCounts(parts: ToolPartLike[]): ToolCountTally[] {
  const order: ToolCountCategory[] = []
  const byCategory = new Map<ToolCountCategory, ToolCountTally>()
  for (const part of parts) {
    const category = COUNT_BY_ICON[iconFor(normalizeToolName(part))]
    const existing = byCategory.get(category)
    if (existing) {
      existing.count += 1
    } else {
      byCategory.set(category, { category, count: 1 })
      order.push(category)
    }
  }
  return order.map((category) => byCategory.get(category)!)
}
