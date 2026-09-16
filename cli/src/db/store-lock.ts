/**
 * Single-writer lock for the CLI local-DB snapshot store.
 *
 * The table store (`db.json.tables/` plus its manifest) has no inter-process
 * coordination of its own: two cognia processes on different builds used to
 * fight over the manifest — one re-flushed it at its own schema version, the
 * other quarantined the result, and generations piled up without anyone ever
 * losing a byte. Exactly one process may own the store for WRITING; followers
 * restore the snapshot read-only and never rename, adopt, or delete a file.
 *
 * The lock is a file created with `wx` (exclusive create) beside the snapshot
 * (`${file}.lock`). Staleness is host-aware: on the same host the process
 * table is authoritative — a lock is dead only when its pid is gone, so a
 * suspended writer's cold heartbeat is never stolen from under it. On a
 * foreign host we cannot see the process table, so the conservative rule
 * stands — reclaim only when the heartbeat has not advanced for
 * `staleAfterMs`.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  LEASE_HEARTBEAT_MS,
  LEASE_STALE_AFTER_MS,
  defaultIsProcessAlive,
} from "../agent/session-store/lease"
import { VERSION } from "../version"

export interface StoreLock {
  lockVersion: 1
  pid: number
  host: string
  /** Process start time (ISO), so a recycled pid cannot pass as the holder. */
  startedAt: string
  /** Random token proving ownership — only the holder may release or renew. */
  token: string
  /** Epoch ms of the last renew. */
  heartbeatAt: number
  /** CLI version of the holder, for diagnostics only. */
  cliVersion: string
}

export type StoreLockAcquisition =
  { ok: true; lock: StoreLock; reclaimed: boolean } | { ok: false; heldBy: StoreLock | null }

export interface StoreLockEnvironment {
  now?: () => number
  host?: string
  pid?: number
  /** Randomness for the ownership token. Injected in tests. */
  mintToken?: () => string
  /** True when a pid is running on THIS host. Defaults to `process.kill(pid, 0)`. */
  isProcessAlive?: (pid: number) => boolean
  staleAfterMs?: number
  cliVersion?: string
}

/** The lock file lives beside the snapshot it guards. */
export function storeLockPath(file: string): string {
  return `${file}.lock`
}

function environment(env: StoreLockEnvironment) {
  return {
    now: env.now ?? Date.now,
    host: env.host ?? os.hostname(),
    pid: env.pid ?? process.pid,
    mintToken: env.mintToken ?? (() => Math.random().toString(36).slice(2, 14)),
    isProcessAlive: env.isProcessAlive ?? defaultIsProcessAlive,
    staleAfterMs: env.staleAfterMs ?? LEASE_STALE_AFTER_MS,
    cliVersion: env.cliVersion ?? VERSION,
  }
}

function writeFileExclusive(target: string, body: string): boolean {
  try {
    fs.writeFileSync(target, body, { flag: "wx", mode: 0o600 })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // The store directory does not exist yet (first-ever boot): create it
      // and retry once so the first process can still become the writer.
      // mkdir is idempotent — racing creators get the same outcome.
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, body, { flag: "wx", mode: 0o600 })
        return true
      } catch {
        return false
      }
    }
    return false
  }
}

function readFile(target: string): string | null {
  try {
    return fs.readFileSync(target, "utf8")
  } catch {
    return null
  }
}

function removeFile(target: string): void {
  try {
    fs.rmSync(target, { force: true })
  } catch {
    // Nothing to remove.
  }
}

function writeFileAtomic(target: string, body: string): void {
  const temporary = `${target}.tmp`
  fs.writeFileSync(temporary, body, { mode: 0o600 })
  if (process.platform === "win32") {
    try {
      fs.rmSync(target, { force: true })
    } catch {
      // A missing destination is fine; rename below remains the source of truth.
    }
  }
  fs.renameSync(temporary, target)
}

/**
 * Whether a recorded lock can be reclaimed. Same host: only a dead pid — a
 * suspended writer keeps its lock even with a frozen heartbeat, because the
 * process table says it is still running. Other host: the heartbeat alone,
 * since we cannot prove anything about its pids.
 */
function isStoreLockStale(
  lock: StoreLock | null,
  env: {
    now: () => number
    host: string
    isProcessAlive: (pid: number) => boolean
    staleAfterMs: number
  }
): boolean {
  if (!lock) return true
  if (lock.host === env.host) return !env.isProcessAlive(lock.pid)
  return env.now() - lock.heartbeatAt > env.staleAfterMs
}

function parseStoreLock(raw: string | null): StoreLock | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as Partial<StoreLock>
    if (
      parsed.lockVersion !== 1 ||
      typeof parsed.pid !== "number" ||
      typeof parsed.host !== "string" ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.token !== "string" ||
      typeof parsed.heartbeatAt !== "number" ||
      typeof parsed.cliVersion !== "string"
    ) {
      return null
    }
    return parsed as StoreLock
  } catch {
    return null
  }
}

/**
 * Try to take the writer lock for `file`'s store.
 *
 * On contention this NEVER blocks or retries: the caller gets `ok:false` with
 * the current holder so it can run read-only and report who owns the store.
 */
export function acquireStoreLock(
  file: string,
  env: StoreLockEnvironment = {}
): StoreLockAcquisition {
  const e = environment(env)
  const target = storeLockPath(file)
  const lock: StoreLock = {
    lockVersion: 1,
    pid: e.pid,
    host: e.host,
    startedAt: new Date(e.now()).toISOString(),
    token: e.mintToken(),
    heartbeatAt: e.now(),
    cliVersion: e.cliVersion,
  }
  const body = JSON.stringify(lock)

  if (writeFileExclusive(target, body)) {
    return { ok: true, lock, reclaimed: false }
  }

  const existing = parseStoreLock(readFile(target))
  if (!isStoreLockStale(existing, e)) {
    return { ok: false, heldBy: existing }
  }

  // Stale: drop it and re-race. Losing the re-race means another process
  // reclaimed first — report the conflict rather than clobbering its lock.
  removeFile(target)
  if (writeFileExclusive(target, body)) {
    return { ok: true, lock, reclaimed: true }
  }
  return { ok: false, heldBy: parseStoreLock(readFile(target)) }
}

/**
 * Renew a held lock. Returns false when the lock was lost (file gone, or
 * another token now owns it) — the caller must then stop writing.
 */
export function renewStoreLock(
  lock: StoreLock,
  file: string,
  env: StoreLockEnvironment = {}
): boolean {
  const e = environment(env)
  const target = storeLockPath(file)
  const current = parseStoreLock(readFile(target))
  if (!current || current.token !== lock.token) return false
  const renewed: StoreLock = { ...current, heartbeatAt: e.now() }
  try {
    writeFileAtomic(target, JSON.stringify(renewed))
  } catch {
    // A failed heartbeat write cannot prove ownership — treat it as lost
    // rather than throwing inside the (unref'd) timer.
    return false
  }
  lock.heartbeatAt = renewed.heartbeatAt
  return true
}

/**
 * Release a held lock. A lock that already belongs to someone else is left
 * alone — releasing is idempotent and never steals.
 */
export function releaseStoreLock(
  lock: StoreLock,
  file: string,
  _env: StoreLockEnvironment = {}
): void {
  const target = storeLockPath(file)
  const current = parseStoreLock(readFile(target))
  if (current && current.token !== lock.token) return
  removeFile(target)
}

/** Read the current holder without attempting to take it. */
export function readStoreLock(file: string): StoreLock | null {
  return parseStoreLock(readFile(storeLockPath(file)))
}

/**
 * Start renewing `lock` on the heartbeat cadence. Returns a stop function.
 * The timer is `unref`'d so a held lock never keeps the process alive — the
 * runtime's own shutdown path releases it.
 */
export function startStoreLockHeartbeat(
  lock: StoreLock,
  file: string,
  env: StoreLockEnvironment = {},
  onLost?: () => void,
  intervalMs: number = LEASE_HEARTBEAT_MS
): () => void {
  const timer = setInterval(() => {
    if (!renewStoreLock(lock, file, env)) {
      clearInterval(timer)
      onLost?.()
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
