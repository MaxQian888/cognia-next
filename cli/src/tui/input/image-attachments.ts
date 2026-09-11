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
