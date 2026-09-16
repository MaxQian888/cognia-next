/** Local image paste recognition and the composer's compact attachment labels. */
import { statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { classifyRef, extractFileRefs } from "../../agent/attachments/classify"
import type { InputBuffer, InputEditOp } from "../state/types"
import {
  deleteWordLeft,
  deleteToLineStart,
  deleteToLineEnd,
  insertText,
  insertNewline,
} from "./buffer"

// A small shell-word reader, not a shell: nothing is expanded or executed.
function pathWords(text: string): string[] | null {
  const words: string[] = []
  let word = ""
  let quote = ""
  let started = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === "\\" && quote !== "'") {
      if (i + 1 === text.length) return null
      word += text[++i]
      started = true
    } else if (quote) {
      if (ch === quote) quote = ""
      else word += ch
    } else if (ch === "'" || ch === '"') {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started) words.push(word)
      word = ""
      started = false
    } else {
      word += ch
      started = true
    }
  }
  if (quote) return null
  if (started) words.push(word)
  return words
}

function serializable(file: string): boolean {
  return !/["\r\n\0]/.test(file)
}

/** Accept a paste only when every shell word names an existing local image. */
export function pastedImagePaths(chunk: string, cwd: string): string[] | null {
  const words = pathWords(chunk.trim())
  if (!words?.length) return null
  const paths: string[] = []
  for (const word of words) {
    try {
      const local = word.startsWith("file:")
        ? fileURLToPath(word)
        : word.startsWith("~/")
          ? path.join(homedir(), word.slice(2))
          : word
      const absolute = path.resolve(cwd, local)
      if (
        !serializable(absolute) ||
        classifyRef(absolute) !== "image" ||
        !statSync(absolute).isFile()
      )
        return null
      paths.push(absolute)
    } catch {
      return null
    }
  }
  return paths
}

export interface ImagePlaceholder {
  label: string
  path: string
  start: number
  end: number
}

/** Offsets are logical UTF-16 buffer offsets, matching the input buffer cursor. */
export function imagePlaceholderAt(
  text: string,
  col: number,
  pastes: Record<string, string>
): ImagePlaceholder | undefined {
  for (const match of text.matchAll(/\[Image \d+\]/g)) {
    const start = match.index
    const end = start + match[0].length
    if (col < start || col >= end) continue
    const stored = pastes[match[0]]
    if (!stored) return undefined
    const refs = extractFileRefs(stored)
    if (refs.length !== 1 || classifyRef(refs[0]) !== "image") return undefined
    return { label: match[0], path: refs[0], start, end }
  }
  return undefined
}

/** Return only new mapping entries; callers merge them into the shared paste map. */
export function createImagePaste(
  paths: string[],
  pastes: Record<string, string>,
  currentText: string
): { text: string; pastes: Record<string, string> } {
  const added: Record<string, string> = {}
  const labels: string[] = []
  let seq = 1
  for (const file of paths) {
    if (!serializable(file)) throw new Error("Image path cannot be represented as an attachment")
    let label = `[Image ${seq}]`
    while (label in pastes || label in added || currentText.includes(label)) {
      label = `[Image ${++seq}]`
    }
    added[label] = `@"${file}"`
    labels.push(label)
    seq++
  }
  return { text: labels.join(" "), pastes: added }
}

/** Compact explicit image refs for history and transcripts, including missing files. */
export function collapseImageRefs(
  text: string,
  pastes: Record<string, string> = {}
): { text: string; pastes: Record<string, string> } {
  const combined = { ...pastes }
  // Match the attachment classifier's quoted/bare grammar. Classify the
  // extracted value through that shared parser so skill/agent refs stay text.
  const compact = text.replace(/@"([^"\n]+)"|@([^\s"]+\.[A-Za-z0-9]+)/g, (ref) => {
    const paths = extractFileRefs(ref)
    if (paths.length !== 1 || classifyRef(paths[0]) !== "image" || !serializable(paths[0]))
      return ref
    const added = createImagePaste(paths, combined, text)
    // Keep the original spelling for exact submit/history round trips.
    combined[added.text] = ref
    return added.text
  })
  return { text: compact, pastes: combined }
}

/** Expand only placeholders present in the draft, never placeholders inside their payloads. */
export function expandComposerPastes(raw: string, pastes: Record<string, string>): string {
  const keys = Object.keys(pastes)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  if (!keys.length) return raw
  const pattern = keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  return raw.replace(new RegExp(pattern, "g"), (placeholder) => pastes[placeholder])
}

/** Keep an attachment label intact during editing, navigation and deletion. */
export function atomicImageEdit(
  buffer: InputBuffer,
  edit: InputEditOp,
  pastes: Record<string, string>
): InputBuffer | undefined {
  const line = buffer.lines[buffer.cursorRow]
  const col = buffer.cursorCol
  const interior = imagePlaceholderAt(line, col, pastes)
  if (interior && col > interior.start) {
    if (edit.op === "insert" || edit.op === "newline") {
      const cursorCol = col - interior.start < interior.end - col ? interior.start : interior.end
      const snapped = { ...buffer, cursorCol }
      return edit.op === "insert" ? insertText(snapped, edit.text) : insertNewline(snapped)
    }
    if (edit.op === "kill-to-start")
      return deleteToLineStart({ ...buffer, cursorCol: interior.end })
    if (edit.op === "kill-to-end") return deleteToLineEnd({ ...buffer, cursorCol: interior.start })
  }
  if (edit.op === "move") {
    const backwards = edit.dir === "left" || edit.dir === "word-left"
    const forwards = edit.dir === "right" || edit.dir === "word-right"
    if (!backwards && !forwards) return undefined
    const image = imagePlaceholderAt(line, backwards ? col - 1 : col, pastes)
    return image ? { ...buffer, cursorCol: backwards ? image.start : image.end } : undefined
  }
  if (edit.op !== "backspace" && edit.op !== "delete-word") return undefined
  const image = imagePlaceholderAt(line, col - 1, pastes)
  let start = image?.start
  let end = image?.end
  if (!image && edit.op === "delete-word") {
    const ordinary = deleteWordLeft(buffer)
    if (ordinary.cursorRow !== buffer.cursorRow) return undefined
    const target = imagePlaceholderAt(line, ordinary.cursorCol, pastes)
    if (!target) return undefined
    start = target.start
    end = col
  }
  if (start === undefined || end === undefined) return undefined
  const lines = [...buffer.lines]
  lines[buffer.cursorRow] = line.slice(0, start) + line.slice(Math.max(col, end))
  return { ...buffer, lines, cursorCol: start }
}

/** A live `[Image N]` attachment in the draft, in reading order. */
export interface ImageAttachment {
  /** The `[Image N]` placeholder label (also the paste-map key). */
  label: string
  /** Resolved image path from the paste map. */
  path: string
  /** Logical buffer row of the label's first occurrence. */
  row: number
}

/**
 * List every live image attachment in the draft — labels that appear in the
 * buffer AND resolve (via the paste map) to a single image ref. A label typed
 * by hand, or one whose paste-map entry is gone, is plain text rather than an
 * attachment. Duplicate label occurrences collapse to the first.
 */
export function listImageAttachments(
  lines: string[],
  pastes: Record<string, string>
): ImageAttachment[] {
  const seen = new Set<string>()
  const out: ImageAttachment[] = []
  lines.forEach((line, row) => {
    for (const match of line.matchAll(/\[Image \d+\]/g)) {
      const label = match[0]
      if (seen.has(label)) continue
      const stored = pastes[label]
      if (!stored) continue
      const refs = extractFileRefs(stored)
      if (refs.length !== 1 || classifyRef(refs[0]) !== "image") continue
      seen.add(label)
      out.push({ label, path: refs[0], row })
    }
  })
  return out
}

/** Removed label span within one line, in the line's original columns. */
interface RemovedSpan {
  start: number
  end: number
}

/**
 * Strip the matching labels (plus one adjoining space) from a single line.
 * A trailing space is preferred ("a [Image 1] b" → "a b"); a leading space is
 * eaten only when the label is at end-of-line ("x [Image 1]" → "x").
 */
function stripImageLabels(line: string, pattern: RegExp): { text: string; removed: RemovedSpan[] } {
  const removed: RemovedSpan[] = []
  let out = ""
  let last = 0
  for (const m of line.matchAll(pattern)) {
    const start = m.index
    let end = start + m[0].length
    let head = start
    if (line[end] === " ") {
      end += 1
    } else if (start > last && line[start - 1] === " ") {
      head = start - 1
    }
    out += line.slice(last, head)
    removed.push({ start: head, end })
    last = end
  }
  out += line.slice(last)
  return { text: out, removed }
}

/** Map a cursor column onto the stripped line, clamped to its new length. */
function colAfterRemoval(col: number, removed: RemovedSpan[], lineLength: number): number {
  let shift = 0
  for (const r of removed) {
    if (r.end <= col) {
      shift += r.end - r.start
      continue
    }
    // Inside a removed span → land where the label started.
    if (r.start < col) return Math.max(0, Math.min(lineLength, r.start - shift))
    break
  }
  return Math.max(0, Math.min(lineLength, col - shift))
}

/**
 * Remove whole `[Image N]` placeholders from the draft — the bulk remove
 * behind the `/images` panel. Lines left holding nothing but whitespace
 * collapse entirely; the cursor is remapped onto the shortened line. The
 * paste map is intentionally untouched: the reducer pushes the previous
 * buffer onto the undo stack first, and a restore still resolves the labels
 * because their entries were never dropped. Returns undefined when none of
 * `labels` resolves to a live image attachment.
 */
export function removeImagePlaceholders(
  buffer: InputBuffer,
  labels: string[],
  pastes: Record<string, string>
): InputBuffer | undefined {
  const targets = new Set(
    labels.filter((label) => {
      const stored = pastes[label]
      if (!stored) return false
      const refs = extractFileRefs(stored)
      return refs.length === 1 && classifyRef(refs[0]) === "image"
    })
  )
  if (!targets.size) return undefined
  const pattern = new RegExp(
    [...targets].map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "g"
  )

  const lines: string[] = []
  const droppedRows: number[] = []
  let cursorSpans: RemovedSpan[] = []
  let changed = false
  buffer.lines.forEach((line, row) => {
    const { text, removed } = stripImageLabels(line, pattern)
    if (!removed.length) {
      lines.push(text)
      return
    }
    changed = true
    if (text.trim() === "" && buffer.lines.length - droppedRows.length > 1) {
      droppedRows.push(row)
      return
    }
    if (row === buffer.cursorRow) cursorSpans = removed
    lines.push(text)
  })
  if (!changed) return undefined

  let cursorRow = buffer.cursorRow
  let cursorCol = buffer.cursorCol
  if (droppedRows.includes(cursorRow)) {
    // Land at the start of whatever row slid into the dropped position.
    cursorRow = Math.min(cursorRow, lines.length - 1)
    cursorCol = 0
  } else {
    cursorRow -= droppedRows.filter((r) => r < cursorRow).length
    cursorCol = colAfterRemoval(cursorCol, cursorSpans, lines[cursorRow].length)
  }
  return { ...buffer, lines, cursorRow, cursorCol }
}
