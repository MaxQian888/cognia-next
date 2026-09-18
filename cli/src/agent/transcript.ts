/**
 * Append-only JSONL transcript store at `~/.cognia/sessions/<sessionId>.jsonl`.
 *
 * One JSON object per line, in turn order. This is the source the CLI→app
 * handoff (Phase 2) ships to the desktop, and what `--continue`/`--resume`
 * (Phase 4) will replay. Effects go through an injectable {@link TranscriptFs}
 * so it unit-tests without real disk.
 */

import fs from "node:fs"
import path from "node:path"

export type TranscriptRole = "user" | "assistant" | "system"

export interface TranscriptEntry {
  ts: number
  role: TranscriptRole
  content: string
  /** Optional per-turn metadata (usage, model, sdkSessionId, …). */
  meta?: Record<string, unknown>
}

export interface TranscriptFs {
  append: (absPath: string, line: string) => void
  read: (absPath: string) => string | null
  mkdirp: (dir: string) => void
  /** Overwrite the whole file (used by `/rewind` to rebuild a truncated
   * transcript). Optional so existing append-only fakes keep type-checking. */
  write?: (absPath: string, content: string) => void
}

export const realTranscriptFs: TranscriptFs = {
  append: (p, line) => fs.appendFileSync(p, line),
  read: (p) => {
    try {
      return fs.readFileSync(p, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
      throw err
    }
  },
  mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
  write: (p, content) => fs.writeFileSync(p, content),
}

export const SESSIONS_DIR = "sessions"

/** Absolute path to a session's transcript file. */
export function sessionTranscriptPath(home: string, sessionId: string): string {
  return path.join(home, SESSIONS_DIR, `${sessionId}.jsonl`)
}

/** Append one entry to a session's transcript, creating the dir/file as needed. */
export function appendTranscript(
  home: string,
  sessionId: string,
  entry: Omit<TranscriptEntry, "ts"> & { ts?: number },
  fsx: TranscriptFs = realTranscriptFs,
  now: number = Date.now()
): void {
  const target = sessionTranscriptPath(home, sessionId)
  fsx.mkdirp(path.dirname(target))
  const record: TranscriptEntry = { ts: entry.ts ?? now, role: entry.role, content: entry.content }
  if (entry.meta) record.meta = entry.meta
  fsx.append(target, JSON.stringify(record) + "\n")
}

/**
 * Parse one JSONL line into a {@link TranscriptEntry}, or `undefined` for
 * blank/corrupt/wrong-shape lines. A partially migrated file can contain valid
 * JSON of the wrong shape, so validation lives at this boundary before
 * resume/list/export consume anything.
 */
function parseTranscriptLine(line: string): TranscriptEntry | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  try {
    const entry: unknown = JSON.parse(trimmed)
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !("ts" in entry) ||
      typeof entry.ts !== "number" ||
      !Number.isFinite(entry.ts) ||
      !("role" in entry) ||
      !["user", "assistant", "system"].includes(entry.role as string) ||
      !("content" in entry) ||
      typeof entry.content !== "string"
    )
      return undefined
    return entry as TranscriptEntry
  } catch {
    // A corrupt line is skipped rather than failing the whole read.
    return undefined
  }
}

/**
 * Lazily yield a session's transcript entries, parsing one line at a time.
 * `readTranscript` materializes an entries array on top of the raw file text,
 * so a resume that maps straight to cells held two full copies of the history;
 * iterating here keeps a single line resident between yields. Consumers that
 * only need the tail should use {@link readTranscriptTail} instead — it scans
 * backwards and stops as soon as the entries it needs are found.
 */
export function* iterTranscriptEntries(
  home: string,
  sessionId: string,
  fsx: TranscriptFs = realTranscriptFs
): Generator<TranscriptEntry> {
  const raw = fsx.read(sessionTranscriptPath(home, sessionId))
  if (raw === null) return
  let start = 0
  while (start < raw.length) {
    const nl = raw.indexOf("\n", start)
    const end = nl === -1 ? raw.length : nl
    const entry = parseTranscriptLine(raw.slice(start, end))
    start = end + 1
    if (entry !== undefined) yield entry
  }
}

/** Read + parse a session transcript. Returns [] when the file is missing. */
export function readTranscript(
  home: string,
  sessionId: string,
  fsx: TranscriptFs = realTranscriptFs
): TranscriptEntry[] {
  return Array.from(iterTranscriptEntries(home, sessionId, fsx))
}

/**
 * The tail of a transcript that a provider-runtime resume needs, found by
 * scanning lines backwards — the whole file is never parsed for this.
 */
export interface TranscriptTail {
  /** Whether at least one structurally valid entry exists. */
  hasEntries: boolean
  /** The most recent assistant entry (carries the saved runtime metadata). */
  latestAssistant?: TranscriptEntry
  /** Role of the most recent non-system entry, when one exists. */
  lastNonSystemRole?: TranscriptRole
}

/**
 * Backward scan for the resume-time tail. Stops as soon as both pieces it
 * looks for are found, so a fresh resume touches a handful of lines instead of
 * re-parsing a transcript the UI path already replayed.
 */
export function readTranscriptTail(
  home: string,
  sessionId: string,
  fsx: TranscriptFs = realTranscriptFs
): TranscriptTail {
  const raw = fsx.read(sessionTranscriptPath(home, sessionId))
  if (raw === null) return { hasEntries: false }
  let hasEntries = false
  let latestAssistant: TranscriptEntry | undefined
  let lastNonSystemRole: TranscriptRole | undefined
  let end = raw.length
  while (end > 0) {
    const nl = raw.lastIndexOf("\n", end - 1)
    const line = raw.slice(nl + 1, end)
    end = nl
    const entry = parseTranscriptLine(line)
    if (!entry) continue
    hasEntries = true
    if (entry.role === "assistant" && latestAssistant === undefined) latestAssistant = entry
    if (entry.role !== "system" && lastNonSystemRole === undefined) {
      lastNonSystemRole = entry.role
    }
    if (latestAssistant !== undefined && lastNonSystemRole !== undefined) break
  }
  const tail: TranscriptTail = { hasEntries }
  if (latestAssistant !== undefined) tail.latestAssistant = latestAssistant
  if (lastNonSystemRole !== undefined) tail.lastNonSystemRole = lastNonSystemRole
  return tail
}

/**
 * Overwrite a session transcript with `entries` (used by `/rewind` to rebuild a
 * truncated history that matches the restored conversation). An empty list
 * writes an empty file so a fully-rewound session starts clean.
 */
export function writeTranscript(
  home: string,
  sessionId: string,
  entries: TranscriptEntry[],
  fsx: TranscriptFs = realTranscriptFs
): void {
  const target = sessionTranscriptPath(home, sessionId)
  fsx.mkdirp(path.dirname(target))
  const body = entries.map((e) => JSON.stringify(e)).join("\n")
  fsx.write?.(target, body.length > 0 ? body + "\n" : "")
}
