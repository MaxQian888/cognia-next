/**
 * Single-writer session lease.
 *
 * Exactly one process may hold a session open for WRITING. The lease is a file
 * created with `wx` (exclusive create) — the only primitive that is atomic
 * across every filesystem we support, including network mounts where advisory
 * locks are unreliable.
 *
 * Reclaiming is deliberately conservative. A lease is stale only when it is
 * DEMONSTRABLY dead:
 *   - the recorded host matches this host AND the recorded pid is gone, or
 *   - the heartbeat has not advanced for `staleAfterMs`.
 * A lease from another host with a fresh heartbeat is never stolen, because
 * this process cannot see that host's process table and a wrong guess corrupts
 * a live session's log.
 */

import os from "node:os"

import { leasePath, type SessionStoreFs } from "./paths"

/** Heartbeat cadence. The holder rewrites its lease at this interval. */
export const LEASE_HEARTBEAT_MS = 5_000

/**
 * A lease whose heartbeat is older than this is reclaimable. Six missed
 * heartbeats — long enough that a GC pause or a busy disk never trips it,
 * short enough that a crashed run does not block the next one for a minute.
 */
export const LEASE_STALE_AFTER_MS = 30_000

export interface SessionLease {
  leaseVersion: 1
  sessionId: string
  pid: number
  host: string
  /** Process start time, so a recycled pid on this host cannot look alive. */
  startedAt: string
  /** Random token proving ownership — only the holder may release or renew. */
  token: string
  /** Epoch ms of the last renew. */
  heartbeatAt: number
}

export type LeaseAcquisition =
  { ok: true; lease: SessionLease; reclaimed: boolean } | { ok: false; heldBy: SessionLease | null }

export interface LeaseEnvironment {
  fsx: SessionStoreFs
  home: string
  sessionDirOverride?: string
  now?: () => number
  host?: string
  pid?: number
  /** Randomness for the ownership token. Injected in tests. */
  mintToken?: () => string
  /** True when a pid is running on THIS host. Defaults to `process.kill(pid, 0)`. */
  isProcessAlive?: (pid: number) => boolean
  staleAfterMs?: number
}

/** Default liveness probe for a pid on THIS host. Exported for the store's own staleness checks. */
export function defaultIsProcessAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but belongs to another user — alive.
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

function parseLease(raw: string | null): SessionLease | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as Partial<SessionLease>
    if (
      parsed.leaseVersion !== 1 ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.host !== "string" ||
      typeof parsed.token !== "string" ||
      typeof parsed.heartbeatAt !== "number"
    ) {
      return null
    }
    return parsed as SessionLease
  } catch {
    return null
  }
}

/**
 * Is `lease` demonstrably dead? A malformed lease file counts as stale — it
 * cannot identify a live holder, so refusing forever would strand the session.
 */
export function isLeaseStale(
  lease: SessionLease | null,
  env: {
    now: number
    host: string
    isProcessAlive: (pid: number) => boolean
    staleAfterMs: number
  }
): boolean {
  if (!lease) return true
  if (env.now - lease.heartbeatAt > env.staleAfterMs) return true
  // Same host: the process table is authoritative and beats the heartbeat.
  if (lease.host === env.host && !env.isProcessAlive(lease.pid)) return true
  return false
}

function environment(env: LeaseEnvironment) {
  return {
    now: env.now ?? Date.now,
    host: env.host ?? os.hostname(),
    pid: env.pid ?? process.pid,
    mintToken: env.mintToken ?? (() => Math.random().toString(36).slice(2, 14)),
    isProcessAlive: env.isProcessAlive ?? defaultIsProcessAlive,
    staleAfterMs: env.staleAfterMs ?? LEASE_STALE_AFTER_MS,
  }
}

/**
 * Try to take the writable lease for `sessionId`.
 *
 * On contention this NEVER blocks or retries: the caller gets `ok:false` with
 * the current holder so it can report `session_locked` with a useful message.
 */
export function acquireLease(sessionId: string, env: LeaseEnvironment): LeaseAcquisition {
  const e = environment(env)
  const target = leasePath(env.home, sessionId, env.sessionDirOverride)
  const lease: SessionLease = {
    leaseVersion: 1,
    sessionId,
    pid: e.pid,
    host: e.host,
    startedAt: new Date(e.now()).toISOString(),
    token: e.mintToken(),
    heartbeatAt: e.now(),
  }
  const body = JSON.stringify(lease)

  if (env.fsx.writeFileExclusive(target, body)) {
    return { ok: true, lease, reclaimed: false }
  }

  const existing = parseLease(env.fsx.readFile(target))
  if (!isLeaseStale(existing, { ...e, now: e.now() })) {
    return { ok: false, heldBy: existing }
  }

  // Stale: drop it and re-race. Losing the re-race means another process
  // reclaimed first — report the conflict rather than clobbering its lease.
  env.fsx.removeFile(target)
  if (env.fsx.writeFileExclusive(target, body)) {
    return { ok: true, lease, reclaimed: true }
  }
  return { ok: false, heldBy: parseLease(env.fsx.readFile(target)) }
}

/**
 * Renew a held lease. Returns false when the lease was lost (file gone, or
 * another token now owns it) — the caller must then stop writing.
 */
export function renewLease(lease: SessionLease, env: LeaseEnvironment): boolean {
  const e = environment(env)
  const target = leasePath(env.home, lease.sessionId, env.sessionDirOverride)
  const current = parseLease(env.fsx.readFile(target))
  if (!current || current.token !== lease.token) return false
  const renewed: SessionLease = { ...current, heartbeatAt: e.now() }
  env.fsx.writeFileAtomic(target, JSON.stringify(renewed))
  lease.heartbeatAt = renewed.heartbeatAt
  return true
}

/**
 * Release a held lease. A lease that already belongs to someone else is left
 * alone — releasing is idempotent and never steals.
 */
export function releaseLease(lease: SessionLease, env: LeaseEnvironment): void {
  const target = leasePath(env.home, lease.sessionId, env.sessionDirOverride)
  const current = parseLease(env.fsx.readFile(target))
  if (current && current.token !== lease.token) return
  env.fsx.removeFile(target)
}

/** Read the current holder without attempting to take it. */
export function readLease(sessionId: string, env: LeaseEnvironment): SessionLease | null {
  return parseLease(env.fsx.readFile(leasePath(env.home, sessionId, env.sessionDirOverride)))
}

/**
 * Start renewing `lease` on the heartbeat cadence. Returns a stop function.
 * The timer is `unref`'d so a held lease never keeps the process alive — the
 * runtime's own shutdown path releases it.
 */
export function startLeaseHeartbeat(
  lease: SessionLease,
  env: LeaseEnvironment,
  onLost?: () => void,
  intervalMs: number = LEASE_HEARTBEAT_MS
): () => void {
  const timer = setInterval(() => {
    if (!renewLease(lease, env)) {
      clearInterval(timer)
      onLost?.()
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
