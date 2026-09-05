/**
 * Pure helpers for presenting tool calls in the TUI: a one-line summary, the
 * diff-tool predicate, the TodoWrite parser, plus display-name normalization,
 * diff stats, and result-size hints for the tool card. No Ink, no I/O.
 */
import { formatEditDiff, bareToolName } from "../markdown/diff"
import { truncateToWidth } from "../markdown/width"
import type { Todo, ToolCell } from "../state/types"

/** Tools whose input describes a file edit we render as a diff. */
const DIFF_TOOLS = new Set(["edit", "write", "multi_edit", "multiedit", "str_replace", "create"])

export function isDiffTool(toolName: string): boolean {
  // Namespace-aware: the cognia builtin edit/write tools arrive as
  // `mcp__cognia-tools__edit` on the ai-sdk path; recognise them too, not just
  // the bare SDK-native names on the Anthropic path.
  return DIFF_TOOLS.has(bareToolName(toolName).toLowerCase())
}

/** Where a tool comes from — drives the small namespace badge on the card. */
export type ToolKind = "mcp" | "plugin" | "builtin"

/**
 * Classify a tool by its name prefix: MCP tools arrive as `mcp__<server>__…`
 * and plugin tools as `plugin__<id>__…`; everything else is a builtin.
 */
export function toolKind(toolName: string): ToolKind {
  if (toolName.startsWith("mcp__")) return "mcp"
  if (toolName.startsWith("plugin__")) return "plugin"
  return "builtin"
}

/**
 * A readable label for the tool card header. MCP tools (`mcp__<server>__<tool>`)
 * and plugin tools (`plugin__<id>__<tool>`) collapse to `<source>:<tool>`;
 * builtins are returned unchanged.
 */
export function toolDisplayName(toolName: string): string {
  const m = /^(?:mcp|plugin)__(.+?)__(.+)$/.exec(toolName)
  return m ? `${m[1]}:${m[2]}` : toolName
}

/**
 * Coarse icon bucket for a tool — the terminal counterpart of the GUI's
 * `ToolIconKey` (`lib/chat/tool-summary.ts`). The two surfaces classify the same
 * names into the same buckets (including the third-party aliases `cat`/`view`/
 * `search`/`list`), so a `grep` reads as a search in the app and in the CLI.
 */
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

/** Name → bucket. Mirrors `ICON_BY_NAME` in `lib/chat/tool-summary.ts`. */
const ICON_BY_NAME: Record<string, ToolIconKey> = {
  read: "read",
  cat: "read",
  view: "read",
  write: "write",
  create: "write",
  edit: "edit",
  multiedit: "edit",
  multi_edit: "edit",
  str_replace: "edit",
  apply_patch: "edit",
  notebookedit: "notebook",
  bash: "terminal",
  shell: "terminal",
  grep: "search",
  search: "search",
  glob: "glob",
  ls: "folder",
  list: "folder",
  webfetch: "web",
  web_fetch: "web",
  fetch: "web",
  websearch: "web",
  web_search: "web",
  todowrite: "task",
  task: "task",
  agent: "task",
  dispatch_agent: "task",
}

/**
 * The icon bucket for a tool name. Namespace-aware: `mcp__github__read` buckets
 * as a read, exactly as the GUI folds the namespace before classifying.
 */
export function toolIconKey(toolName: string): ToolIconKey {
  return ICON_BY_NAME[bareToolName(toolName).toLowerCase()] ?? "generic"
}

/**
 * One-column glyph per bucket — the terminal stand-in for the GUI's lucide
 * icons. Every glyph is deliberately outside the ranges
 * `markdown/width.stringWidth` measures as two columns, so a tool header's
 * width math (and therefore the virtualized renderer's wrapping) stays exact.
 */
const GLYPH_BY_ICON: Record<ToolIconKey, string> = {
  read: "\u25a4",
  write: "\u229e",
  edit: "\u22a1",
  search: "\u2315",
  glob: "\u2042",
  terminal: "\u00bb",
  web: "\u25cd",
  folder: "\u2261",
  notebook: "\u25a6",
  task: "\u25a3",
  generic: "\u2317",
}

/** The glyph for a tool name's bucket — see {@link GLYPH_BY_ICON}. */
export function toolGlyph(toolName: string): string {
  return GLYPH_BY_ICON[toolIconKey(toolName)]
}

/**
 * Humanize a machine tool name for display: `multi_edit` → "Multi edit",
 * `todoWrite` → "Todo Write". Same transformation the GUI applies
 * (`humanizeToolName` in `lib/chat/tool-summary.ts`) so the two surfaces title
 * a tool identically.
 */
export function humanizeToolName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!words) return "Tool"
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The header label for a tool card. A builtin is humanized (`bash` → "Bash");
 * an MCP / plugin tool keeps its `<source>:<tool>` identity — the namespace is
 * the useful half in a terminal, and the `[mcp]` / `[plugin]` badge sits beside
 * it — with only the tool segment humanized.
 */
export function toolHeaderLabel(toolName: string): string {
  const m = /^(?:mcp|plugin)__(.+?)__(.+)$/.exec(toolName)
  return m ? `${m[1]}:${humanizeToolName(m[2])}` : humanizeToolName(toolName)
}

/** The TodoWrite tool name (case-insensitive match). */
export function isTodoTool(toolName: string): boolean {
  return toolName.toLowerCase() === "todowrite"
}

/**
 * Parse a TodoWrite tool input into a typed todo list. Tolerant of partial or
 * malformed entries (skips anything without a string `content`).
 */
export function parseTodos(input: unknown): Todo[] {
  if (!input || typeof input !== "object") return []
  const raw = (input as { todos?: unknown }).todos
  if (!Array.isArray(raw)) return []
  const out: Todo[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const content = (entry as { content?: unknown }).content
    if (typeof content !== "string" || content.length === 0) continue
    const statusRaw = (entry as { status?: unknown }).status
    const status = statusRaw === "in_progress" || statusRaw === "completed" ? statusRaw : "pending"
    const activeForm = (entry as { activeForm?: unknown }).activeForm
    out.push({
      content,
      status,
      ...(typeof activeForm === "string" ? { activeForm } : {}),
    })
  }
  return out
}

/** A `:offset-end` / `:offset+` / `:0-limit` suffix for a `read` line range. */
function readRange(input: Record<string, unknown>): string | undefined {
  const offset = typeof input.offset === "number" ? input.offset : undefined
  const limit = typeof input.limit === "number" ? input.limit : undefined
  if (offset === undefined && limit === undefined) return undefined
  if (offset !== undefined && limit !== undefined) return `:${offset}-${offset + limit}`
  if (offset !== undefined) return `:${offset}+`
  return `:0-${limit}`
}

/** First string field present among the candidates, trimmed to `max` chars. */
function firstString(input: Record<string, unknown>, keys: string[], max = 80): string | undefined {
  for (const key of keys) {
    const v = input[key]
    if (typeof v === "string" && v.length > 0) {
      return v.length > max ? v.slice(0, max - 1) + "…" : v
    }
  }
  return undefined
}

/** First non-empty string field among the candidates, UNtruncated (paths must
 * stay verbatim so they can be opened / hyperlinked). */
function firstStringRaw(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = input[key]
    if (typeof v === "string" && v.length > 0) return v
  }
  return undefined
}

/** Candidate input keys that name the file a tool acts on, in precedence order. */
const FILE_PATH_KEYS = ["file_path", "filePath", "path", "notebook_path"]

/**
 * The (verbatim, untruncated) file path a tool's input refers to — the single
 * source of "which file does this card point at", shared by the OSC-8 clickable
 * path in the tool card and the `/open` last-file selector. Returns undefined for
 * tools that don't act on a file (bash/shell carry a command, not a path).
 */
export function toolFilePath(toolName: string, input: Record<string, unknown>): string | undefined {
  const name = bareToolName(toolName).toLowerCase()
  if (name === "bash" || name === "shell") return undefined
  return firstStringRaw(input, FILE_PATH_KEYS)
}

/** The 1-based line a `read` tool starts at (its `offset`), or undefined. Used to
 * build a `file:line` editor target / OSC-8 link. */
export function toolFileLine(toolName: string, input: Record<string, unknown>): number | undefined {
  if (bareToolName(toolName).toLowerCase() !== "read") return undefined
  return typeof input.offset === "number" && input.offset > 0 ? input.offset : undefined
}

/**
 * A compact, human-readable summary of a tool call for the collapsed tool card
 * header — e.g. the file path for an edit, the command for bash, the pattern
 * for grep.
 */
export function summarizeToolCall(toolName: string, input: Record<string, unknown>): string {
  // Namespace-aware, like the GUI's `summarizeToolCall` (which folds the
  // namespace via `normalizeToolName` before dispatching): the cognia builtins
  // arrive as `mcp__cognia-tools__bash` on the ai-sdk path, and without this
  // fold every one of them fell through to the generic key scan — so a wrapped
  // `bash` showed no command and a wrapped `grep` no pattern.
  const name = bareToolName(toolName).toLowerCase()
  if (name === "terminal_repl_spawn") {
    const argv = Array.isArray(input.args)
      ? input.args.filter((arg) => typeof arg === "string")
      : []
    return (
      firstString({ command: [input.shell, ...argv].filter(Boolean).join(" ") }, ["command"]) ?? ""
    )
  }
  if (["terminal_repl_write", "terminal_repl_read", "terminal_repl_kill"].includes(name)) {
    return [firstString(input, ["sessionId"]), firstString(input, ["data", "signal"])]
      .filter(Boolean)
      .join("  ")
  }
  if (name === "bash" || name === "shell") {
    return firstString(input, ["command", "cmd"]) ?? ""
  }
  if (name === "grep" || name === "search") {
    const pattern = firstString(input, ["pattern", "query", "regex"])
    const path = firstString(input, ["path", "glob"], 40)
    return [pattern, path].filter(Boolean).join("  ")
  }
  if (name === "glob") {
    return [firstString(input, ["pattern", "glob"]), firstString(input, ["path", "cwd"], 40)]
      .filter(Boolean)
      .join("  ")
  }
  if (name === "read" || name === "cat" || name === "view") {
    const path = firstString(input, ["file_path", "filePath", "path"])
    if (!path) return ""
    const range = readRange(input)
    return range ? `${path} ${range}` : path
  }
  if (name === "webfetch" || name === "web_fetch" || name === "fetch") {
    return firstString(input, ["url", "uri"]) ?? ""
  }
  if (name === "task" || name === "dispatch_agent" || name === "agent") {
    return firstString(input, ["subagent_type", "description", "prompt"]) ?? ""
  }
  if (name === "apply_patch" || name === "patch" || name === "apply-patch") {
    const patch = typeof input.patch === "string" ? input.patch : ""
    const files = (patch.match(/^\+\+\+ /gm) ?? []).length
    return files > 0 ? `${files} file${files === 1 ? "" : "s"}` : ""
  }
  return (
    firstString(input, [
      "file_path",
      "filePath",
      "path",
      "cwd",
      "url",
      "query",
      "command",
      "action",
      "description",
    ]) ?? ""
  )
}

/** Inline object output is a labeled outline, not escaped JSON. Traversal is
 * bounded independently of the view's line cap; the full payload stays in the
 * existing pager/export path. Text content blocks retain their natural lines. */
export function toolResultPreviewText(result: unknown): string {
  if (result == null) return ""
  if (typeof result === "string") return result
  const ancestors = new Set<object>()
  function* outline(value: unknown, depth: number): Generator<string> {
    if (value === null || typeof value !== "object") {
      yield* String(value).split("\n")
      return
    }
    if (depth >= 5 || ancestors.has(value)) {
      yield "… nested details — /expand"
      return
    }
    ancestors.add(value)
    if (Array.isArray(value)) {
      if (value.length === 0) yield "(empty)"
      for (const item of value) yield* outline(item, depth + 1)
    } else {
      const object = value as Record<string, unknown>
      if (object.type === "text" && typeof object.text === "string") {
        yield* object.text.split("\n")
      } else {
        const keys = Object.keys(object)
        if (keys.length === 0) yield "(empty)"
        for (const key of keys) {
          const item = object[key]
          const label = humanizeToolName(key)
          if (item !== null && typeof item === "object") {
            yield `${label}:`
            for (const line of outline(item, depth + 1)) yield `  ${line}`
          } else {
            const lines = String(item).split("\n")
            yield `${label}: ${lines[0]}`
            for (const line of lines.slice(1)) yield `  ${line}`
          }
        }
      }
    }
    ancestors.delete(value)
  }
  const lines: string[] = []
  for (const line of outline(result, 0)) {
    if (lines.length === 120) {
      lines.push("… structured preview — /expand")
      break
    }
    lines.push(line)
  }
  return lines.join("\n")
}

/**
 * The live "what's running" detail line for the working indicator, Codex-style:
 * `└ <tool>: <summary>` (e.g. `└ Bash: npm test`). Reuses {@link toolHeaderLabel}
 * and {@link summarizeToolCall} so the label and summary match the tool card.
 * Truncated to `columns` display columns; the `: <summary>` tail is dropped when
 * the tool has no natural summary.
 */
export function toolDetailLine(tool: ToolCell, columns = 80): string {
  const name = toolHeaderLabel(tool.toolName)
  const summary = summarizeToolCall(tool.toolName, tool.input)
  const body = summary ? `${name}: ${summary}` : name
  return truncateToWidth(`└ ${body}`, columns)
}

/**
 * Detail lines for the tools still running in the current turn (`status` ===
 * "running"), most-recent last, capped at `max` lines. Drives the live detail
 * block under the working indicator. Empty when nothing is running.
 */
export function runningToolLines(tools: ToolCell[], columns = 80, max = 3): string[] {
  const running = tools.filter((t) => t.status === "running")
  const tail = running.slice(Math.max(0, running.length - max))
  return tail.map((t) => toolDetailLine(t, columns))
}

/** Added / removed line counts for a diff tool. */
export interface DiffStat {
  added: number
  removed: number
}

/**
 * Count added / removed lines for a diff tool by reusing the diff renderer
 * ({@link formatEditDiff}). Non-diff tools (and inputs the renderer can't
 * parse) yield zeros.
 */
export function diffStat(toolName: string, input: Record<string, unknown>): DiffStat {
  if (!isDiffTool(toolName)) return { added: 0, removed: 0 }
  let added = 0
  let removed = 0
  for (const line of formatEditDiff(toolName, input)) {
    if (line.kind === "add") added++
    else if (line.kind === "del") removed++
  }
  return { added, removed }
}

/** Magnitude of a tool result, for the collapsed-card size hint. */
export interface ResultSize {
  lines: number
  bytes: number
}

/**
 * Measure a tool result so a collapsed card can show its size (e.g. "· 320
 * lines") without expanding. Strings are measured directly; objects by their
 * JSON serialization. Nullish / empty results → zeros.
 */
export function summarizeResult(result: unknown): ResultSize {
  if (result == null) return { lines: 0, bytes: 0 }
  let text: string
  if (typeof result === "string") text = result
  else {
    try {
      text = JSON.stringify(result)
    } catch {
      text = String(result)
    }
  }
  if (text.length === 0) return { lines: 0, bytes: 0 }
  return { lines: text.split("\n").length, bytes: text.length }
}

/**
 * A one-line preview of a (usually error) result for the collapsed card — the
 * first non-blank line, trimmed to `max` chars. Lets an errored tool show what
 * failed without expanding. Objects are JSON-stringified; empty → "".
 */
export function resultPreview(result: unknown, max = 60): string {
  if (result == null) return ""
  const text = toolResultPreviewText(result)
  const line =
    text
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? ""
  return line.length > max ? line.slice(0, max - 1) + "…" : line
}
