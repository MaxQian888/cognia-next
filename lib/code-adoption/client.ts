/**
 * Thin invoke wrappers for the Rust `code_adoption` engine. Everything here is
 * best-effort: it no-ops off-Tauri and swallows errors, because attribution
 * must never disrupt or block a turn.
 */

import { invoke } from "@tauri-apps/api/core"

import { isTauri } from "@/lib/tauri"

import type { CodeAdoptionTurnRow } from "./types"

export interface BeginTurnMeta {
  sessionId: string
  runId: number
  model: string | null
  /** Runtime attribution, for example `"in-app"` or `"external"`. */
  agentKind: string
}

/** Mirrors the Rust `BeginOutcome` serde shape (unused by callers, typed for tests). */
export type BeginOutcome = { status: "started" } | { status: "skipped"; reason: string }

export interface TrackingAttempt extends BeginTurnMeta {
  cwd: string
  status: "started" | "unavailable"
  reason?: string
}

const trackingAttempts = new Map<string, TrackingAttempt>()

/** Consume the begin-side coverage record when the matching turn settles. */
export function consumeCodeAdoptionTrackingAttempt(turnKey: string): TrackingAttempt | undefined {
  const attempt = trackingAttempts.get(turnKey)
  trackingAttempts.delete(turnKey)
  return attempt
}

/**
 * Open an attribution window for a turn. No-ops when not in Tauri or when the
 * turn has no workspace cwd (nothing to attribute). Never throws.
 */
export async function beginCodeAdoptionTurn(
  cwd: string | undefined,
  meta: BeginTurnMeta
): Promise<void> {
  if (!isTauri() || !cwd) return
  const turnKey = `${meta.sessionId}:${meta.runId}`
  try {
    const outcome = await invoke<BeginOutcome>("code_adoption_turn_begin", {
      args: {
        cwd,
        sessionId: meta.sessionId,
        runId: meta.runId,
        model: meta.model,
        agentKind: meta.agentKind,
      },
    })
    trackingAttempts.set(turnKey, {
      ...meta,
      cwd,
      status: outcome.status === "started" ? "started" : "unavailable",
      ...(outcome.status === "skipped" ? { reason: outcome.reason } : {}),
    })
  } catch {
    trackingAttempts.set(turnKey, { ...meta, cwd, status: "unavailable", reason: "beginFailed" })
    // best-effort — attribution must never disrupt a turn
  }
}

/**
 * Close the window for `turnKey` and return the turn's record, or `null` when
 * the turn was never tracked (skipped / orphaned) or on any error.
 */
export async function endCodeAdoptionTurn(turnKey: string): Promise<CodeAdoptionTurnRow | null> {
  if (!isTauri()) return null
  try {
    const row = await invoke<CodeAdoptionTurnRow | null>("code_adoption_turn_end", { turnKey })
    return row ?? null
  } catch {
    return null
  }
}
