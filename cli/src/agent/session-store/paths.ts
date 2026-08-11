/**
 * On-disk layout of the canonical session store.
 *
 * ```
 * <home>/sessions/                     legacy flat transcripts (untouched)
 * <home>/sessions/<sessionId>.jsonl      ↑ ADR-0090 pre-canonical format
 * <home>/sessions/<sessionId>/         canonical store for that session
 *   manifest.json                      versioned header + index entry
 *   events.jsonl                       append-only AgentEventEnvelope log
 *   lease.json                         single-writer lease
 * ```
 *
 * A canonical session is a DIRECTORY named exactly `<sessionId>`, which can
 * never collide with the legacy `<sessionId>.jsonl` FILE beside it. That is
 * what lets the first canonical write land without touching (or needing to
 * delete) the legacy transcript.
 *
 * All effects route through an injectable {@link SessionStoreFs} so the store
 * unit-tests without real disk.
 */

import fs from "node:fs"
import path from "node:path"

import { SESSIONS_DIR } from "../transcript"

export { SESSIONS_DIR }

export const MANIFEST_FILE = "manifest.json"
export const EVENTS_FILE = "events.jsonl"
export const LEASE_FILE = "lease.json"

export interface SessionStoreFs {
  exists: (absPath: string) => boolean
  isDirectory: (absPath: string) => boolean
  readFile: (absPath: string) => string | null
  /** Overwrite atomically (temp file + rename), creating parents as needed. */
  writeFileAtomic: (absPath: string, content: string) => void
  appendFile: (absPath: string, content: string) => void
  mkdirp: (dir: string) => void
  readdir: (dir: string) => string[]
  removeFile: (absPath: string) => void
  /** Remove one resolved session directory and all files below it. */
  removeDir: (absPath: string) => void
  /**
   * Create a file only if it does not exist (`wx`). Returns false when it
   * already existed. This is the atomicity primitive the lease is built on.
   */
  writeFileExclusive: (absPath: string, content: string) => boolean
  /** Milliseconds since epoch of the file's last modification, or null. */
  mtimeMs: (absPath: string) => number | null
}

export const realSessionStoreFs: SessionStoreFs = {
  exists: (p) => fs.existsSync(p),
  isDirectory: (p) => {
    try {
      return fs.statSync(p).isDirectory()
    } catch {
      return false
    }
  },
  readFile: (p) => {
    try {
      return fs.readFileSync(p, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
      throw err
    }
  },
  writeFileAtomic: (p, content) => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    // Same-directory temp so the rename stays on one filesystem (rename across
    // devices is not atomic and throws EXDEV).
    const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    fs.writeFileSync(tmp, content)
    fs.renameSync(tmp, p)
  },
  appendFile: (p, content) => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, content)
  },
  mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
  readdir: (dir) => {
    try {
      return fs.readdirSync(dir)
    } catch {
      return []
    }
  },
  removeFile: (p) => {
    try {
      fs.unlinkSync(p)
    } catch {
      // best-effort
    }
  },
  removeDir: (p) => fs.rmSync(p, { recursive: true, force: true }),
  writeFileExclusive: (p, content) => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    try {
      fs.writeFileSync(p, content, { flag: "wx" })
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false
      throw err
    }
  },
  mtimeMs: (p) => {
    try {
      return fs.statSync(p).mtimeMs
    } catch {
      return null
    }
  },
}

/** Root under which every session (legacy file or canonical dir) lives. */
export function sessionsRoot(home: string, sessionDirOverride?: string): string {
  return sessionDirOverride ? path.resolve(sessionDirOverride) : path.join(home, SESSIONS_DIR)
}

/** Directory holding a session's canonical store. */
export function sessionDir(home: string, sessionId: string, override?: string): string {
  return path.join(sessionsRoot(home, override), sessionId)
}

export function manifestPath(home: string, sessionId: string, override?: string): string {
  return path.join(sessionDir(home, sessionId, override), MANIFEST_FILE)
}

export function eventLogPath(home: string, sessionId: string, override?: string): string {
  return path.join(sessionDir(home, sessionId, override), EVENTS_FILE)
}

export function leasePath(home: string, sessionId: string, override?: string): string {
  return path.join(sessionDir(home, sessionId, override), LEASE_FILE)
}

/** Path of the pre-canonical flat transcript for a session, if any. */
export function legacyTranscriptPath(home: string, sessionId: string, override?: string): string {
  return path.join(sessionsRoot(home, override), `${sessionId}.jsonl`)
}

/**
 * Canonical key for a workspace. `--continue` matches on this, so it must be
 * stable across invocations from different sub-directories of the same repo
 * and across `.`/trailing-slash spellings — but must NOT collapse two genuinely
 * different checkouts. `path.resolve` + trailing-separator strip does both;
 * case is preserved because macOS is case-INsensitive but Linux is not, and
 * lowercasing would merge two real directories there.
 */
export function workspaceKey(cwd: string): string {
  const resolved = path.resolve(cwd)
  if (resolved.length > 1 && resolved.endsWith(path.sep)) return resolved.slice(0, -1)
  return resolved
}

/** True when `id` is safe to use as a directory name (no traversal, no separators). */
export function isSafeSessionId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= 128 &&
    !id.includes("/") &&
    !id.includes("\\") &&
    !id.includes("\0") &&
    id !== "." &&
    id !== ".."
  )
}
