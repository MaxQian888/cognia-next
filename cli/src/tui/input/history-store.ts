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

import {
  HISTORY_FILE_NAME,
  HISTORY_LIMIT,
  capHistory,
  parseHistory,
  serializeHistory,
} from "@/lib/cli-bridge/history-format"

// Re-exported so existing CLI consumers keep importing them from here; the
// canonical definitions live in the shared `lib/cli-bridge/history-format`
// module so the desktop→CLI push and the CLI write byte-for-byte identically.
export { HISTORY_FILE_NAME, HISTORY_LIMIT }

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

/** Load persisted history (oldest → newest), capped, or `[]` when absent. */
export function loadHistory(home: string, deps: HistoryStoreDeps = {}): string[] {
  const read = deps.readFile ?? defaultRead
  const raw = read(historyPath(home))
  if (!raw) return []
  return capHistory(parseHistory(raw))
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
  const capped = capHistory(deduped)
  try {
    write(historyPath(home), serializeHistory(capped))
  } catch {
    // best-effort — a read-only home shouldn't break the turn.
  }
  return capped
}
