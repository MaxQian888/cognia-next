/**
 * Per-teammate selection pool composing a circuit breaker per worker.
 *
 * v1 (this task / PR 2): round-robin selection; transient quarantine via
 * breaker open; onAllUnavailable edge-triggered for HITL deadlock gate;
 * forceUnquarantine for gate-approved recovery.
 *
 * PR 6 adds error classification (rate_limited / catastrophic), disqualified
 * state, rejoin, onTeammateDisqualified. v1 baseline below treats every
 * `recordFailure` as ordinary; PR 6 swaps in classifyError().
 */

import {
  createCircuitBreaker,
  type CircuitBreaker,
  type CircuitBreakerOptions,
} from "@/lib/connectors/circuit-breaker"
import type { AgentTeammate } from "@/types/agent/agent-team"

export type TeammateFailureKind =
  | "ordinary"
  | "rate_limited"
  | "catastrophic"
  | "empty_output"
  | "refusal"

/** Options for a single claim. */
export interface ClaimOptions {
  /**
   * Skill-aware assignment: when set and that teammate is currently available,
   * claim it directly (matching a task's `assignedTo`); otherwise fall back to
   * round-robin. Circuit-breaker availability is always respected.
   */
  preferTeammateId?: string
}

export interface TeammatePool {
  claim(taskId: string, options?: ClaimOptions): AgentTeammate | null
  recordSuccess(teammateId: string): void
  recordFailure(teammateId: string, error: unknown): void
  availableCount(): number
  isDisqualified(teammateId: string): boolean
  allUnavailable(): boolean
  onAllUnavailable(cb: () => void): () => void
  onTeammateDisqualified(cb: (teammateId: string, reason: TeammateFailureKind) => void): () => void
  forceUnquarantine(input: { teammateIds?: string[]; resetAll?: boolean }): void
  rejoin(teammateId: string): void
}

export interface TeammatePoolOptions {
  teammates: AgentTeammate[]
  breakerOptions?: Partial<CircuitBreakerOptions>
  strategy?: "round-robin"
  now?: () => number
  /**
   * Team + run context, accepted for call-site symmetry. The pool no longer
   * dispatches the `onTeammateClaim` / `onTeammateRelease` plugin hooks itself —
   * `dispatchTeammate` (the sole production caller of `claim` / `record*`) is
   * the single source of those hooks, so firing them here too double-counted
   * every claim/release for plugin consumers. Kept optional + unused so existing
   * construction sites compile unchanged.
   */
  teamId?: string
  runId?: string
}

interface Entry {
  teammate: AgentTeammate
  breaker: CircuitBreaker
  disqualified: boolean
}

const DEFAULT_BREAKER_OPTIONS: Partial<CircuitBreakerOptions> = {
  windowMs: 5 * 60 * 1000,
  minEvents: 2,
  failureThresholdPct: 50,
  cooldownMs: 60 * 1000,
  closeOnSuccessCount: 1,
}

/**
 * Per ADR-0022 §2.5. Classify a failure to decide how to advance the
 * teammate's lifecycle.
 *
 *  - catastrophic (401/403/404/auth/config): teammate is disqualified;
 *    requires user rejoin via the teammate-fix gate.
 *  - rate_limited (429): breaker opens IMMEDIATELY (bypasses sliding window
 *    so we don't keep hammering the rate-limited provider). Cooldown still
 *    recovers automatically.
 *  - empty_output / refusal: ordinary path — sliding-window breaker.
 *  - ordinary: standard sliding-window breaker.
 */
export function classifyError(err: unknown): TeammateFailureKind {
  const msg = err instanceof Error ? err.message : String(err)
  if (/EMPTY_OUTPUT/.test(msg)) return "empty_output"
  if (/REFUSAL_DETECTED/.test(msg)) return "refusal"
  if (/\b429\b|rate.?limit/i.test(msg)) return "rate_limited"
  if (/\b40[134]\b|unauthor(ized|ised)|invalid.{0,5}key|forbidden/i.test(msg)) {
    return "catastrophic"
  }
  return "ordinary"
}

export function createTeammatePool(opts: TeammatePoolOptions): TeammatePool {
  const buildBreaker = (): CircuitBreaker =>
    createCircuitBreaker({
      ...DEFAULT_BREAKER_OPTIONS,
      ...opts.breakerOptions,
      now: opts.now,
    })

  const entries = new Map<string, Entry>()
  for (const t of opts.teammates) {
    entries.set(t.id, {
      teammate: t,
      breaker: buildBreaker(),
      disqualified: false,
    })
  }

  const allUnavailListeners = new Set<() => void>()
  const disqualListeners = new Set<(teammateId: string, reason: TeammateFailureKind) => void>()
  let lastAllUnavailable = entries.size === 0
  let rotationIndex = 0

  const isAvailable = (e: Entry): boolean => !e.disqualified && e.breaker.canPass()

  const computeAllUnavailable = (): boolean => {
    if (entries.size === 0) return true
    for (const e of entries.values()) {
      if (isAvailable(e)) return false
    }
    return true
  }

  const checkAllUnavailableEdge = (): void => {
    const nowAllUnavail = computeAllUnavailable()
    if (nowAllUnavail && !lastAllUnavailable) {
      lastAllUnavailable = true
      for (const fn of allUnavailListeners) {
        try {
          fn()
        } catch (err) {
          console.warn("TeammatePool onAllUnavailable listener threw:", err)
        }
      }
    } else if (!nowAllUnavail && lastAllUnavailable) {
      lastAllUnavailable = false
    }
  }

  // Claim/release lifecycle hooks are dispatched by `dispatchTeammate`, not the
  // pool — see TeammatePoolOptions. `taskId` is still threaded through claim for
  // the skill-aware preference path and call-site symmetry.
  const finalizeClaim = (entry: Entry, _taskId: string): AgentTeammate => entry.teammate

  return {
    claim: (taskId, options) => {
      const ids = [...entries.keys()]
      if (ids.length === 0) return null

      // Skill-aware fast path: honor the preferred teammate when available.
      const preferId = options?.preferTeammateId
      if (preferId) {
        const preferred = entries.get(preferId)
        if (preferred && isAvailable(preferred)) return finalizeClaim(preferred, taskId)
      }

      // Round-robin fallback.
      for (let i = 0; i < ids.length; i++) {
        const id = ids[(rotationIndex + i) % ids.length]
        const entry = entries.get(id)
        if (!entry) continue
        if (isAvailable(entry)) {
          rotationIndex = (rotationIndex + i + 1) % ids.length
          return finalizeClaim(entry, taskId)
        }
      }
      return null
    },
    recordSuccess: (teammateId) => {
      const e = entries.get(teammateId)
      if (!e) return
      e.breaker.recordSuccess()
      checkAllUnavailableEdge()
    },
    recordFailure: (teammateId, error) => {
      const e = entries.get(teammateId)
      if (!e) return
      const kind = classifyError(error)
      switch (kind) {
        case "catastrophic":
          if (!e.disqualified) {
            e.disqualified = true
            for (const fn of disqualListeners) {
              try {
                fn(teammateId, "catastrophic")
              } catch (err) {
                console.warn("TeammatePool onTeammateDisqualified listener threw:", err)
              }
            }
          }
          break
        case "rate_limited":
          // Force the breaker open by recording enough failures to exceed the
          // configured threshold (the default sliding window would otherwise
          // wait for minEvents). 100 is a high-enough safety margin to trip
          // any sensible configuration in a single call.
          for (let i = 0; i < 100; i += 1) e.breaker.recordFailure()
          break
        default:
          e.breaker.recordFailure()
      }
      checkAllUnavailableEdge()
    },
    availableCount: () => {
      let count = 0
      for (const e of entries.values()) {
        if (isAvailable(e)) count += 1
      }
      return count
    },
    isDisqualified: (teammateId) => entries.get(teammateId)?.disqualified ?? false,
    allUnavailable: () => computeAllUnavailable(),
    onAllUnavailable: (cb) => {
      allUnavailListeners.add(cb)
      return () => {
        allUnavailListeners.delete(cb)
      }
    },
    onTeammateDisqualified: (cb) => {
      disqualListeners.add(cb)
      return () => {
        disqualListeners.delete(cb)
      }
    },
    forceUnquarantine: ({ teammateIds, resetAll }) => {
      const targets = resetAll ? [...entries.keys()] : (teammateIds ?? [])
      for (const id of targets) {
        const e = entries.get(id)
        if (!e) continue
        e.breaker = buildBreaker()
      }
      checkAllUnavailableEdge()
    },
    rejoin: (teammateId) => {
      const e = entries.get(teammateId)
      if (!e) return
      e.disqualified = false
      e.breaker = buildBreaker()
      checkAllUnavailableEdge()
    },
  }
}
