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
 * Loosest shape that still identifies a tool call. `groupAgentParts` is generic
 * over `{ type?: string }`, so the fold predicates cannot demand a full
 * `ToolUIPart` — but they must still see `toolName`, which is where the AI SDK's
 * `dynamic-tool` shape carries the name.
 */
export interface ToolNamedPartLike {
  type?: string
  toolName?: string
}

/**
 * Resolve a part's bare tool name, or `null` when the part is not a tool call.
 *
 * Handles both encodings the renderer receives: `tool-<name>` (statically
 * declared tools) and `dynamic-tool` + `toolName` (imported transcripts, CLI
 * handoff). Any `mcp__<server>__` namespace is folded away, so
 * `tool-mcp__cognia-tools__grep` and a dynamic `grep` resolve identically.
 */
export function resolveToolPartName(part: ToolNamedPartLike | undefined): string | null {
  const type = part?.type
  if (type === "dynamic-tool") {
    const name = typeof part?.toolName === "string" ? part.toolName.trim() : ""
    return name ? bareToolName(name) : null
  }
  if (typeof type !== "string" || !type.startsWith("tool-")) return null
  return bareToolName(type) || null
}

/**
 * Strip the `tool-` part-type prefix and any `mcp__<server>__` namespace so
 * `tool-mcp__cognia-tools__bash` and `tool-Bash` both fold to `bash`/`Bash`.
 * A `dynamic-tool` part with no usable `toolName` degrades to `"tool"` so the
 * row still has something to print.
 */
export function normalizeToolName(part: ToolPartLike): string {
  return resolveToolPartName(part as ToolNamedPartLike) ?? "tool"
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
  shell: "terminal",
  grep: "search",
  glob: "glob",
  ls: "folder",
  webfetch: "web",
  websearch: "web",
  web_search: "web",
  todowrite: "task",
  // Aliases a third-party MCP server is as likely to use as the canonical
  // names above. Mirrors the CLI's `CONTEXT_TOOLS` set so the two surfaces
  // classify (and therefore fold) the same tools.
  cat: "read",
  view: "read",
  search: "search",
  list: "folder",
}

function iconFor(name: string): ToolIconKey {
  return ICON_BY_NAME[name.toLowerCase()] ?? "generic"
}

function iconForKind(part: ToolPartLike): ToolIconKey {
  const presentation = part as ToolPartLike & {
    kind?: unknown
    toolMetadata?: { kind?: unknown }
  }
  const kind = asString(presentation.toolMetadata?.kind) ?? asString(presentation.kind)
  switch (kind) {
    case "file_read":
    case "read":
      return "read"
    case "file_write":
    case "write":
      return "write"
    case "execute":
    case "terminal":
      return "terminal"
    case "browser":
      return "web"
    default:
      return "generic"
  }
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
 *
 * The web surface deliberately diverges on one point: the CLI folds only
 * *settled, non-error* calls, whereas a burst here folds from the first call
 * and {@link ../../components/chat/message-parts/tool-activity-group}
 * auto-opens the group while any child is running or failed. Same visibility,
 * without the group splitting and re-merging on every streaming delta.
 */
const CONTEXT_FOLD_ICONS: ReadonlySet<ToolIconKey> = new Set([
  "read",
  "search",
  "glob",
  "folder",
  "web",
])

/**
 * True for a tool part whose tool is a context-gathering read (its icon bucket
 * is in {@link CONTEXT_FOLD_ICONS}). Used by the simplified-mode grouping to
 * fold only read/search bursts and leave edits/commands standing.
 *
 * Takes the whole part, not just the type: a `dynamic-tool` part keeps its name
 * on `toolName`, and folding those is exactly the case that matters for
 * imported transcripts and CLI handoff sessions.
 */
export function isContextFoldPart(part: ToolNamedPartLike | undefined): boolean {
  const name = resolveToolPartName(part)
  return name !== null && CONTEXT_FOLD_ICONS.has(iconFor(name))
}

/**
 * Produce a compact, human-readable summary of a tool call. Never throws;
 * unknown shapes fall back to `{ name, target: null }`.
 */
export function summarizeToolCall(part: ToolPartLike): ToolSummary {
  const name = normalizeToolName(part)
  const nameIcon = iconFor(name)
  const iconKey = nameIcon === "generic" ? iconForKind(part) : nameIcon
  const input = (part.input ?? undefined) as Record<string, unknown> | undefined

  let target: string | null = null
  if (input && typeof input === "object") {
    const lower = name.toLowerCase()
    if (lower === "read" || lower === "write" || lower === "edit" || lower === "multiedit") {
      const fp = asString(input.file_path)
      if (fp) target = basename(fp)
      if (!target && (lower === "edit" || lower === "multiedit") && Array.isArray(input.changes)) {
        const firstPath = asString((input.changes[0] as { path?: unknown } | undefined)?.path)
        if (firstPath) target = basename(firstPath)
      }
    } else if (lower === "notebookedit") {
      const fp = asString(input.notebook_path) ?? asString(input.file_path)
      if (fp) target = basename(fp)
    } else if (lower === "bash" || lower === "shell") {
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
    } else if (lower === "websearch" || lower === "web_search") {
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

/** Humanize a stable machine tool name without losing its identity elsewhere. */
export function humanizeToolName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!words) return "Tool"
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Resolve protocol-supplied presentation text without exposing internal app identifiers. */
export function resolveProvidedToolTitle(part: ToolPartLike): string | undefined {
  const presentation = part as ToolPartLike & {
    title?: unknown
    toolMetadata?: {
      appContext?: { appName?: unknown; actionName?: unknown } | null
    }
  }
  const upstreamTitle = asString(presentation.title)
  if (upstreamTitle) return upstreamTitle

  const appName = asString(presentation.toolMetadata?.appContext?.appName)
  const actionName = asString(presentation.toolMetadata?.appContext?.actionName)
  const actionTitle = actionName ? humanizeToolName(actionName) : undefined
  if (appName && actionTitle) return `${appName} · ${actionTitle}`
  return appName ?? actionTitle
}

/** Resolve the user-facing title while keeping upstream titles authoritative. */
export function resolveToolDisplayTitle(part: ToolPartLike): string {
  const providedTitle = resolveProvidedToolTitle(part)
  if (providedTitle) return providedTitle
  const summary = summarizeToolCall(part)
  const name = humanizeToolName(summary.name)
  return summary.target ? `${name} · ${summary.target}` : name
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
