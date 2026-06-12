/**
 * Persistent composer history, stored as newline-delimited entries in
 * `~/.cognia/history.json` (a `.json` extension by convention with the rest of
 * the CLI home, though the body is plain lines so a multi-line paste collapses
 * to a single visual entry on disk via the same placeholder the buffer uses).
 *
 * Pure core: the fs reader/writer is injected so this unit-tests without disk.
 * The store is best-effort — a read-only home or a corrupt file degrades to an
 * empty history rather than breaking the session.
 */
import fs from "node:fs"
import path from "node:path"

/** Max entries kept on disk. Matches Claude Code's 100-entry composer history. */
export const HISTORY_LIMIT = 100

export const HISTORY_FILE_NAME = "history.json"

export interface HistoryStoreDeps {
  readFile?: (absPath: string) => string | null
  writeFile?: (absPath: string, data: string) => void
}

/** Absolute path to the history file for a given home dir. */
export function historyPath(home: string): string {
  return path.join(home, HISTORY_FILE_NAME)
}

const defaultRead = (absPath: string): string | null => {
  try {
    return fs.readFileSync(absPath, "utf8")
  } catch {
    return null
  }
}

const defaultWrite = (absPath: string, data: string): void => {
  fs.writeFileSync(absPath, data, "utf8")
}

/**
 * One entry per line; blank lines are dropped. A trailing newline (common) does
 * not produce an empty entry. Newest entry is last (chronological), matching the
 * in-memory `history.entries` order the reducer keeps.
 */
function parse(raw: string): string[] {
  const lines = raw.split("\n")
  const out: string[] = []
  for (const line of lines) {
    // Entries are stored with newlines escaped (see serialize); a raw blank line
    // is just padding and is skipped.
    if (line.length === 0) continue
    out.push(line.replace(/\\n/g, "\n").replace(/\\\\/g, "\\"))
  }
  return out
}

function serialize(entries: string[]): string {
  // Escape backslashes first, then newlines, so a multi-line entry survives a
  // round-trip as one line.
  return entries.map((e) => e.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")).join("\n") + "\n"
}

/** Load persisted history (oldest → newest), capped, or `[]` when absent. */
export function loadHistory(home: string, deps: HistoryStoreDeps = {}): string[] {
  const read = deps.readFile ?? defaultRead
  const raw = read(historyPath(home))
  if (!raw) return []
  const entries = parse(raw)
  return entries.length > HISTORY_LIMIT ? entries.slice(entries.length - HISTORY_LIMIT) : entries
}

/**
 * Append one entry and persist the (capped, consecutive-deduped) history. A
 * blank entry is ignored. Returns the new full list so the caller can keep the
 * in-memory and on-disk views identical. Write failures are swallowed.
 */
export function appendHistory(home: string, entry: string, deps: HistoryStoreDeps = {}): string[] {
  const trimmed = entry.trim()
  const read = deps.readFile ?? defaultRead
  const write = deps.writeFile ?? defaultWrite
  const existing = loadHistory(home, { readFile: read })
  if (trimmed.length === 0) return existing
  const deduped = existing[existing.length - 1] === entry ? existing : [...existing, entry]
  const capped =
    deduped.length > HISTORY_LIMIT ? deduped.slice(deduped.length - HISTORY_LIMIT) : deduped
  try {
    write(historyPath(home), serialize(capped))
  } catch {
    // best-effort — a read-only home shouldn't break the turn.
  }
  return capped
}
