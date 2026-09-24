// Builders for the chat-composer's `kind: "file"` context chips (the same
// `ContextSelectionRef` the DiffPane's "send to chat" stages). Kept pure and
// dep-injected so the workbench, the file tree and the problems panel share
// one snapshot contract — and so tests never touch the transport layer.
//
// Snapshot rules, matching how the composer consumes the chip:
//  - an OPEN file stages its live buffer (the draft the user is looking at),
//    never the stale disk copy — the agent reads files itself, the chip's job
//    is to say exactly what the user pointed at;
//  - a line range narrows the snapshot to that excerpt, like a diff hunk;
//  - a folder stages a formatted child listing — the honest "context" for a
//    directory since it has no file body;
//  - a problem stages "location — diagnostic + the offending line", so the
//    agent sees both the complaint and the code it complains about.

import type { FileSelectionRef } from "@/types/artifact/artifact"
import type { WorkspaceEntry } from "@/lib/files/types"
import type { readWorkspaceFile } from "@/lib/files/workspace-fs"

export interface FileContextChatDeps {
  readFile: typeof readWorkspaceFile
  listDir: (root: string, rel?: string) => Promise<WorkspaceEntry[]>
}

/** Whole-file snapshots beyond this are truncated — a chip is context, not a transfer. */
export const FILE_SNAPSHOT_MAX_BYTES = 64 * 1024
/** Folder listings beyond this keep the first entries and a "… and N more" tail. */
const FOLDER_LISTING_MAX_ENTRIES = 200

const basename = (relPath: string) => relPath.split("/").pop() ?? relPath

function truncate(body: string): string {
  if (body.length <= FILE_SNAPSHOT_MAX_BYTES) return body
  return `${body.slice(0, FILE_SNAPSHOT_MAX_BYTES)}\n…`
}

/**
 * Read the snapshot body for a file: the open buffer when the caller has one,
 * else disk. A read failure degrades to an empty body rather than dropping the
 * chip — the relPath reference itself is still meaningful to the agent.
 */
async function fileBody(
  deps: FileContextChatDeps,
  rootPath: string,
  relPath: string,
  draftContent?: string
): Promise<string> {
  if (draftContent !== undefined) return draftContent
  try {
    return await deps.readFile(rootPath, relPath, FILE_SNAPSHOT_MAX_BYTES)
  } catch {
    return ""
  }
}

/** Slice a 1-based inclusive line range out of `body`. */
function lineRangeExcerpt(body: string, range: { startLine: number; endLine: number }): string {
  const lines = body.split("\n")
  const start = Math.max(1, range.startLine)
  const end = Math.min(lines.length, Math.max(start, range.endLine))
  return lines.slice(start - 1, end).join("\n")
}

interface FileContextOptions {
  rootPath: string
  relPath: string
  /** Live buffer when the file is open — wins over the disk read. */
  draftContent?: string
  /** Narrow the chip to a line range (Monaco selection, marker span). */
  range?: { startLine: number; endLine: number }
  /**
   * Pre-captured text for the range (the editor's `getValueInRange`), so the
   * chip holds exactly what was selected rather than a re-sliced guess.
   */
  selectedText?: string
  deps: FileContextChatDeps
}

/** Stage a file — or a range inside one — as a chat context chip. */
export async function buildFileContextSelection(
  opts: FileContextOptions
): Promise<FileSelectionRef> {
  const body = await fileBody(opts.deps, opts.rootPath, opts.relPath, opts.draftContent)
  const snapshot = opts.range
    ? truncate(opts.selectedText ?? lineRangeExcerpt(body, opts.range))
    : truncate(body)
  return {
    kind: "file",
    relPath: opts.relPath,
    title: basename(opts.relPath),
    snapshot,
    comment: "",
    ...(opts.range ? { range: opts.range } : {}),
  }
}

/**
 * Stage a folder as a chat context chip. The body is its direct-child listing
 * (`name/` marks directories) — enough for the agent to know the layout
 * without us inlining every descendant file.
 */
export async function buildFolderContextSelection(opts: {
  rootPath: string
  relPath: string
  deps: FileContextChatDeps
}): Promise<FileSelectionRef> {
  let entries: WorkspaceEntry[] = []
  try {
    entries = await opts.deps.listDir(opts.rootPath, opts.relPath)
  } catch {
    entries = []
  }
  const shown = entries.slice(0, FOLDER_LISTING_MAX_ENTRIES)
  const lines = shown.map((entry) => `  ${basename(entry.relPath)}${entry.isDir ? "/" : ""}`)
  if (entries.length > shown.length) {
    lines.push(`  … and ${entries.length - shown.length} more`)
  }
  return {
    kind: "file",
    relPath: opts.relPath,
    title: `${basename(opts.relPath)}/`,
    snapshot: `${opts.relPath}/ (${entries.length} items)\n${lines.join("\n")}`,
    comment: "",
  }
}

export interface ProblemMarkerLike {
  message: string
  /** Panel severity label: "error" | "warning" | "info" | "hint". */
  kind: string
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
  source?: string
}

/**
 * Stage a diagnostic as a chat context chip. The snapshot pairs the marker
 * (`path:line:col — kind: message (source)`) with the offending line read
 * from the buffer/disk, so "ask the agent to fix this" carries everything
 * the fix needs.
 */
export async function buildProblemContextSelection(opts: {
  rootPath: string
  relPath: string
  marker: ProblemMarkerLike
  /** Live buffer when the file is open — wins over the disk read. */
  draftContent?: string
  deps: FileContextChatDeps
}): Promise<FileSelectionRef> {
  const { marker } = opts
  const body = await fileBody(opts.deps, opts.rootPath, opts.relPath, opts.draftContent)
  const codeLine = body.split("\n")[marker.startLineNumber - 1]?.trim() ?? ""
  const head =
    `${opts.relPath}:${marker.startLineNumber}:${marker.startColumn} — ` +
    `${marker.kind}: ${marker.message}` +
    (marker.source ? ` (${marker.source})` : "")
  return {
    kind: "file",
    relPath: opts.relPath,
    title: `${basename(opts.relPath)}:${marker.startLineNumber}`,
    snapshot: codeLine ? `${head}\n\n${marker.startLineNumber} | ${codeLine}` : head,
    comment: "",
    range: { startLine: marker.startLineNumber, endLine: marker.endLineNumber },
  }
}

/** Cap on a whole file's staged diagnostics — a chip is context, not a dump. */
export const PROBLEM_LIST_MAX_MARKERS = 20

/**
 * Stage every diagnostic of one file as a single chip — the "fix all problems
 * in this file" case. The snapshot is the marker list (`line:col kind: msg`),
 * not the file body: the agent reads the file itself through its own tools.
 */
export function buildProblemsContextSelection(opts: {
  relPath: string
  markers: ProblemMarkerLike[]
}): FileSelectionRef {
  const shown = opts.markers.slice(0, PROBLEM_LIST_MAX_MARKERS)
  const lines = shown.map(
    (m) =>
      `${m.startLineNumber}:${m.startColumn} ${m.kind}: ${m.message}` +
      (m.source ? ` (${m.source})` : "")
  )
  if (opts.markers.length > shown.length) {
    lines.push(`… and ${opts.markers.length - shown.length} more`)
  }
  return {
    kind: "file",
    relPath: opts.relPath,
    title: `${basename(opts.relPath)} (${opts.markers.length})`,
    snapshot: `${opts.relPath} — ${opts.markers.length} problems\n${lines.join("\n")}`,
    comment: "",
  }
}
