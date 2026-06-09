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
      out.push(JSON.parse(trimmed) as TranscriptEntry)
    } catch {
      // Skip a corrupt line rather than failing the whole read.
    }
  }
  return out
}
