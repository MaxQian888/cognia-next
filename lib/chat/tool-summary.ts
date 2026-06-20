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
 * Strip the `tool-` part-type prefix and any `mcp__<server>__` namespace so
 * `tool-mcp__cognia-tools__bash` and `tool-Bash` both fold to `bash`/`Bash`.
 */
export function normalizeToolName(part: ToolPartLike): string {
  let raw: string
  if (part.type === "dynamic-tool") {
    raw = (part as DynamicToolUIPart).toolName ?? "tool"
  } else {
    // "tool-<name>" → "<name>"
    raw = part.type.startsWith("tool-") ? part.type.slice("tool-".length) : part.type
  }
  // Fold `mcp__<server>__<tool>` down to `<tool>`.
  const mcpMatch = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(raw)
  if (mcpMatch) return mcpMatch[1]
  return raw
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

/** Aggregate status for a run of tool calls, used by the activity-group header. */
export type AggregateStatus = "running" | "error" | "complete" | "pending"

export function aggregateToolStatus(states: ToolPartLike["state"][]): AggregateStatus {
  if (states.some((s) => s === "output-error")) return "error"
  if (states.some((s) => s === "input-available" || s === "approval-requested")) return "running"
  if (states.some((s) => s === "input-streaming")) return "pending"
  return "complete"
}
