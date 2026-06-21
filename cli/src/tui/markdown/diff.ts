/**
 * Render an edit/write tool input as diff lines for the tool card. Pure — reads
 * the well-known field shapes of the file-editing tools and emits add/del/meta
 * lines. Unknown shapes return an empty list (the card falls back to its input
 * summary).
 */
import { highlightLine, tintAnsi } from "./highlight"
import type { DiffLine } from "./types"

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/**
 * Strip an `mcp__<server>__` / `plugin__<id>__` namespace to the bare tool name
 * (e.g. `mcp__cognia-tools__edit` → `edit`); returns the name unchanged when it
 * carries no namespace. The cognia builtin edit/write tools arrive namespaced on
 * the ai-sdk path but bare (SDK-native `Edit`/`Write`) on the Anthropic path —
 * stripping here lets the diff predicate + renderer recognise both.
 */
export function bareToolName(toolName: string): string {
  const parts = toolName.split("__")
  return parts.length >= 3 && (parts[0] === "mcp" || parts[0] === "plugin")
    ? parts.slice(2).join("__")
    : toolName
}

/** Running 1-based counters for the old (del) and new (add) sides. */
interface Counters {
  oldNo: number
  newNo: number
}

function addLines(out: DiffLine[], kind: "add" | "del", text: string, c: Counters): void {
  for (const line of text.split("\n")) {
    if (kind === "add") out.push({ kind, text: line, newNo: c.newNo++ })
    else out.push({ kind, text: line, oldNo: c.oldNo++ })
  }
}

export function formatEditDiff(toolName: string, input: Record<string, unknown>): DiffLine[] {
  const name = bareToolName(toolName).toLowerCase()
  const out: DiffLine[] = []
  const c: Counters = { oldNo: 1, newNo: 1 }
  const filePath = str(input.file_path) ?? str(input.filePath) ?? str(input.path)
  if (filePath) out.push({ kind: "meta", text: filePath })

  if (name === "write" || name === "create") {
    const content = str(input.content) ?? str(input.contents) ?? ""
    if (content) addLines(out, "add", content, c)
    return out
  }

  if (name === "multi_edit" || name === "multiedit") {
    const edits = Array.isArray(input.edits) ? input.edits : []
    for (const edit of edits) {
      if (!edit || typeof edit !== "object") continue
      const oldS = str((edit as Record<string, unknown>).old_string)
      const newS = str((edit as Record<string, unknown>).new_string)
      if (oldS) addLines(out, "del", oldS, c)
      if (newS) addLines(out, "add", newS, c)
    }
    return out
  }

  // edit / str_replace
  const oldS = str(input.old_string) ?? str(input.oldString)
  const newS = str(input.new_string) ?? str(input.newString)
  if (oldS) addLines(out, "del", oldS, c)
  if (newS) addLines(out, "add", newS, c)
  return out
}

/** The diff-role colours, supplied by the caller from the active theme. */
export interface DiffColors {
  add: string
  del: string
  context: string
}

/**
 * Pull the edited file's path out of an edit/write tool's input so its extension
 * can drive language inference. Mirrors the field aliases {@link formatEditDiff}
 * reads. Returns undefined when no path-shaped field is present.
 */
export function diffFilePath(input: Record<string, unknown>): string | undefined {
  return str(input.file_path) ?? str(input.filePath) ?? str(input.path)
}

/**
 * Render one {@link DiffLine}'s code text: syntax-highlight it for `lang`, then
 * re-tint with the line's diff-role colour so the diff semantics win on conflict
 * (highlighted tokens keep their colour, everything else takes the role colour).
 * `meta` lines and lines with no inferable language are tinted without
 * highlighting. Returns an ANSI string Ink renders verbatim.
 */
export function highlightDiffText(
  line: DiffLine,
  lang: string | undefined,
  colors: DiffColors
): string {
  const role = line.kind === "add" ? colors.add : line.kind === "del" ? colors.del : colors.context
  if (line.kind === "meta" || !lang) return tintAnsi(line.text, role)
  return tintAnsi(highlightLine(line.text, lang), role)
}
