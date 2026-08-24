"use client"

/**
 * Which host is allowed to fire time-based work.
 *
 * ADR-0128 made the scheduler host-owned, and `isTimingAuthority()` returns
 * `true` unconditionally whenever the timing driver has no leader election —
 * which is every driver in production. Two desktops signed into the same
 * account therefore both arm the same cron and both fire it. The deterministic
 * idempotency key means the second fire is now *absorbed* rather than executed,
 * but absorbing a duplicate every tick is not the same as agreeing who owns it.
 *
 * The rule is deliberately minimal and zero-regression:
 *
 *   * **unconfigured ⇒ self-authority.** A machine that has not been told
 *     otherwise behaves exactly as it does today. No inter-host protocol, no
 *     election, nothing to go wrong on a single-machine install.
 *   * **configured ⇒ that host owns timing.** Everyone else stands down.
 *   * **configured but unreachable ⇒ run locally and say so.** Silence would
 *     mean a team's cron simply stops the day the authority laptop is closed,
 *     with nothing anywhere explaining why.
 */

import { isPlaceable, type PlacementLiveness } from "./liveness"

const STORAGE_KEY = "cognia-execution-authority-v1"

export interface ExecutionAuthorityConfig {
  /**
   * `RemoteHost.id` of the host that owns timing, or `null` for self.
   *
   * Deliberately not a device id: the user picks from hosts they have already
   * paired and can see, and that record is where liveness comes from.
   */
  hostId: string | null
  /**
   * How long the authority may be unreachable before this host takes over.
   *
   * Not zero: a laptop that sleeps for thirty seconds should not trigger a
   * takeover, and a takeover is visible to the user.
   */
  degradeAfterMs: number
}

export const DEFAULT_AUTHORITY_CONFIG: ExecutionAuthorityConfig = {
  hostId: null,
  degradeAfterMs: 5 * 60_000,
}

export interface AuthorityDecision {
  /** May this host arm and fire scheduled work? */
  isAuthority: boolean
  /** Set when this host took over from a configured authority it cannot reach. */
  degraded: boolean
  /** The configured authority, when one exists. */
  authorityHostId: string | null
  /** How long the authority has been unreachable, when degraded. */
  unreachableForMs?: number
}

export interface AuthorityInput {
  config: ExecutionAuthorityConfig
  /** Liveness of the configured authority, or `null` when it is not known here. */
  authorityLiveness: PlacementLiveness | null
  now: number
}

export function resolveExecutionAuthority(input: AuthorityInput): AuthorityDecision {
  const { hostId } = input.config
  if (!hostId) {
    // The zero-configuration path, byte-for-byte today's behaviour.
    return { isAuthority: true, degraded: false, authorityHostId: null }
  }

  if (!input.authorityLiveness) {
    // Configured to a host this machine has never seen. Treating that as
    // "stand down" would strand every schedule forever, with no signal.
    return {
      isAuthority: true,
      degraded: true,
      authorityHostId: hostId,
    }
  }

  if (isPlaceable(input.authorityLiveness, input.now)) {
    return { isAuthority: false, degraded: false, authorityHostId: hostId }
  }

  const unreachableForMs = Math.max(0, input.now - input.authorityLiveness.lastSeenAt)
  if (unreachableForMs < input.config.degradeAfterMs) {
    // Still inside the grace window — a sleeping laptop is not a failover.
    return { isAuthority: false, degraded: false, authorityHostId: hostId, unreachableForMs }
  }
  return { isAuthority: true, degraded: true, authorityHostId: hostId, unreachableForMs }
}

function isConfig(value: unknown): value is ExecutionAuthorityConfig {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  const hostIdOk = record.hostId === null || typeof record.hostId === "string"
  return hostIdOk && typeof record.degradeAfterMs === "number" && record.degradeAfterMs >= 0
}

export function readExecutionAuthorityConfig(): ExecutionAuthorityConfig {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_AUTHORITY_CONFIG
    const parsed: unknown = JSON.parse(raw)
    return isConfig(parsed) ? parsed : DEFAULT_AUTHORITY_CONFIG
  } catch {
    // A malformed record must fall back to self-authority, never to "nobody
    // fires anything".
    return DEFAULT_AUTHORITY_CONFIG
  }
}

export function writeExecutionAuthorityConfig(config: ExecutionAuthorityConfig): void {
  snapshot = config
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(config))
  } catch {
    // Storage unavailable (private mode, quota). The in-memory decision for
    // this session still stands; nothing here may throw into the scheduler.
  }
  for (const listener of listeners) listener()
}

// ---------------------------------------------------------------------------
// React seam
// ---------------------------------------------------------------------------
//
// `readExecutionAuthorityConfig` parses on every call, which is what the
// scheduler wants (another tab may have rewritten the key between ticks) and
// exactly what `useSyncExternalStore` cannot have: a fresh object every read is
// an infinite render loop. The cache below is therefore confined to the UI
// seam and leaves the scheduler's per-tick semantics untouched.

let snapshot: ExecutionAuthorityConfig | null = null
const listeners = new Set<() => void>()
let storageBound = false

function invalidate(): void {
  snapshot = null
  for (const listener of listeners) listener()
}

/** Subscribe to config changes from this tab and from any other one. */
export function subscribeExecutionAuthorityConfig(listener: () => void): () => void {
  listeners.add(listener)
  if (!storageBound && typeof window !== "undefined") {
    storageBound = true
    // Another tab writing the same key must not leave this one showing — or
    // acting on — a stale authority.
    window.addEventListener("storage", (event) => {
      if (event.key === null || event.key === STORAGE_KEY) invalidate()
    })
  }
  return () => {
    listeners.delete(listener)
  }
}

/** Referentially stable snapshot for `useSyncExternalStore`. */
export function getExecutionAuthorityConfigSnapshot(): ExecutionAuthorityConfig {
  snapshot ??= readExecutionAuthorityConfig()
  return snapshot
}

/** Server/prerender snapshot — storage is not readable during a static export. */
export function getExecutionAuthorityConfigServerSnapshot(): ExecutionAuthorityConfig {
  return DEFAULT_AUTHORITY_CONFIG
}

/** Test-only reset of the module-level snapshot and listener set. */
export function __resetExecutionAuthorityConfigForTests(): void {
  snapshot = null
  listeners.clear()
}
