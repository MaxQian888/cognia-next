/**
 * Render an edit/write tool input as diff lines for the tool card. Pure — reads
 * the well-known field shapes of the file-editing tools and emits add/del/meta
 * lines. Unknown shapes return an empty list (the card falls back to its input
 * summary).
 */
import type { DiffLine } from "./types"

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
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
  const name = toolName.toLowerCase()
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
