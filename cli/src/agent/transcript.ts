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

/** Read + parse a session transcript. Returns [] when the file is missing. */
export function readTranscript(
  home: string,
  sessionId: string,
  fsx: TranscriptFs = realTranscriptFs
): TranscriptEntry[] {
  const raw = fsx.read(sessionTranscriptPath(home, sessionId))
  if (raw === null) return []
  const out: TranscriptEntry[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const entry: unknown = JSON.parse(trimmed)
      // A partially migrated/corrupt file can contain valid JSON of the wrong
      // shape. Validate at the disk boundary before resume/list/export consume it.
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
        continue
      out.push(entry as TranscriptEntry)
    } catch {
      // Skip a corrupt line rather than failing the whole read.
    }
  }
  return out
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
