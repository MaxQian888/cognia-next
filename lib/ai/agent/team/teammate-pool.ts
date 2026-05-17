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

export interface TeammatePool {
  claim(taskId: string): AgentTeammate | null
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

  return {
    claim: () => {
      const ids = [...entries.keys()]
      if (ids.length === 0) return null
      for (let i = 0; i < ids.length; i++) {
        const id = ids[(rotationIndex + i) % ids.length]
        const entry = entries.get(id)
        if (!entry) continue
        if (isAvailable(entry)) {
          rotationIndex = (rotationIndex + i + 1) % ids.length
          return entry.teammate
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
    recordFailure: (teammateId, _error) => {
      const e = entries.get(teammateId)
      if (!e) return
      // PR 6 inserts classifyError() here. For v1, all failures are ordinary.
      e.breaker.recordFailure()
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
