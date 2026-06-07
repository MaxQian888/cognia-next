/**
 * Interval parsing + scheduler-task mapping for `/loop` interval mode.
 *
 * `/loop 5m <prompt>` runs as a session-scoped scheduler task of the
 * existing `"chat"` type — that reuses the scheduler's overlap policies,
 * jitter, missed-run coalescing, and the Rust alarm daemon instead of a
 * second timing engine. The mapping below pins the Claude Code-style
 * semantics: overlap "skip" (no missed-fire catch-up), `maxRuns` as the
 * iteration cap, and a 7-day hard expiry via `endAt`.
 */

import type { CreateScheduledTaskInput } from "@/types/scheduler"
import type { Loop } from "@/types/loop"

/** Hard expiry for every loop — a forgotten loop can't run forever. */
export const LOOP_EXPIRY_MS = 7 * 24 * 60 * 60_000

/** Floor for interval cadence (sub-minute fires would thrash the agent). */
export const MIN_INTERVAL_MS = 60_000
/** Ceiling — longer than the 7-day expiry makes no sense. */
export const MAX_INTERVAL_MS = LOOP_EXPIRY_MS

const INTERVAL_RE = /^(\d+)(s|m|h|d)$/i

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/**
 * Parse a leading interval token (`30s` / `5m` / `2h` / `1d`) into ms.
 * Seconds round UP to the 1-minute floor (Claude Code parity). Returns
 * `null` for anything that isn't a clean interval token, zero, or a value
 * past the 7-day ceiling — the caller treats `null` as "not an interval,
 * part of the prompt".
 */
export function parseInterval(token: string): number | null {
  const match = INTERVAL_RE.exec(token.trim())
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return null
  const ms = value * UNIT_MS[match[2].toLowerCase()]
  if (ms > MAX_INTERVAL_MS) return null
  return Math.max(MIN_INTERVAL_MS, ms)
}

/**
 * Map a persisted interval loop onto the scheduler's task model. The task
 * is self-identified via `tags: ["loop"]` (the scheduler page filter keys
 * off it) and bound to the loop's session so every fire appends to the
 * same conversation.
 */
export function buildLoopTaskInput(loop: Loop): CreateScheduledTaskInput {
  return {
    name: `Loop: ${truncate(loop.rawPrompt, 60)}`,
    description: `/loop interval task for session ${loop.sessionId}`,
    type: "chat",
    trigger: {
      type: "interval",
      intervalMs: loop.intervalMs ?? MIN_INTERVAL_MS,
    },
    payload: {
      prompt: loop.safePrompt,
      sessionId: loop.sessionId,
    },
    config: {
      // No missed-fire catch-up; a fire colliding with a running execution
      // coalesces away instead of stacking (Claude Code parity).
      overlapPolicy: "skip",
      runMissedOnStartup: false,
      maxRuns: loop.config.maxIterations,
    },
    tags: ["loop"],
    endAt: new Date(loop.expiresAt ?? Date.now() + LOOP_EXPIRY_MS),
  }
}

function truncate(s: string, max: number): string {
  const trimmed = s.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`
}
