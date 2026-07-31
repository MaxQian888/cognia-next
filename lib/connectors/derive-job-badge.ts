/**
 * Derive a UI badge for an outbound job from runtime context.
 *
 * The persistent `OutboundJobRow.status` enum carries only the five values
 * the runner writes (`pending` / `sending` / `sent` / `failed` / `deadlettered`).
 * Several user-visible states are **runtime-only** — they exist while the
 * job is sitting in the queue but never get written back to the row:
 *
 *   - The adapter is **muted** (operator-set switch).
 *   - The adapter's **quiet hours** window is currently active.
 *   - The adapter's outbound **circuit breaker** has tripped open.
 *
 * The outbound tab joins the live `outboundQueue` snapshot with the
 * adapter row and the latest heartbeat-derived breaker snapshot, and
 * passes them through this pure helper to compute a small badge for
 * each row. Pure so it's trivially unit-tested and so future surfaces
 * (mobile diagnostics, Slack `/cognia status`, …) can reuse the same
 * derivation without duplicating the rules.
 *
 * Reuses `isInQuietHours` and `msUntilQuietEnd` from `outbound-runner.ts`
 * — the same helpers the runner uses when deferring jobs — so the UI and
 * runtime always agree on the live state.
 */

import { isInQuietHours, msUntilQuietEnd } from "./outbound-runner"
import type { OutboundJobRow } from "@/lib/db/connector-types"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

export type DerivedJobBadgeKind =
  "normal" | "paused-muted" | "paused-quiet-hours" | "circuit-blocked"

export interface DerivedJobBadge {
  kind: DerivedJobBadgeKind
  /** Stable machine-readable reason — same vocabulary as the audit log. */
  reason: "muted" | "quiet_hours" | "circuit_open" | null
  /**
   * Estimated ms until the suppression lifts. Set only for
   * `"paused-quiet-hours"` (uses `msUntilQuietEnd`). `null` otherwise —
   * the muted switch is operator-controlled with no natural ETA; circuit
   * cool-down lives in runner memory and isn't worth surfacing on each
   * row.
   */
  etaMs: number | null
}

export interface DeriveJobBadgeInputs {
  job: Pick<OutboundJobRow, "status">
  adapter: Pick<AdapterInstanceRow, "muted" | "quietHours"> | null | undefined
  /** Latest breaker snapshot state from the heartbeat row; `null` when no data. */
  breakerState: "closed" | "open" | "half_open" | null
  /** Wall-clock ms — injected so callers can derive deterministically in tests. */
  now: number
}

const NORMAL: DerivedJobBadge = { kind: "normal", reason: null, etaMs: null }

/**
 * Compute the derived badge for one outbound row.
 *
 * Rules:
 *   1. Anything other than `pending` / `sending` keeps the `normal` badge —
 *      `sent` is terminal, `failed` and `deadlettered` already carry their
 *      own destructive `StatusBadge`, so layering a paused/circuit overlay
 *      on them adds noise.
 *   2. A tripped breaker dominates because retries will fail until it
 *      half-opens.
 *   3. Muted dominates quiet hours (it's the operator's explicit kill
 *      switch; quiet hours is a schedule that may still leave the channel
 *      live during the day).
 *   4. Quiet hours falls through last — we surface the remaining window
 *      via `etaMs` so the UI can render "resumes in 42 min".
 */
export function deriveJobBadge(inputs: DeriveJobBadgeInputs): DerivedJobBadge {
  const { job, adapter, breakerState, now } = inputs

  // Only pending / sending jobs benefit from the derived overlay; the
  // others already carry a definitive StatusBadge that says it all.
  if (job.status !== "pending" && job.status !== "sending") {
    return NORMAL
  }

  if (breakerState === "open") {
    return { kind: "circuit-blocked", reason: "circuit_open", etaMs: null }
  }

  if (!adapter) {
    return NORMAL
  }

  if (adapter.muted === true) {
    return { kind: "paused-muted", reason: "muted", etaMs: null }
  }

  const qh = adapter.quietHours
  if (qh && qh.from && qh.to && qh.tz && isInQuietHours(now, qh.from, qh.to, qh.tz)) {
    return {
      kind: "paused-quiet-hours",
      reason: "quiet_hours",
      etaMs: msUntilQuietEnd(now, qh.to, qh.tz),
    }
  }

  return NORMAL
}
