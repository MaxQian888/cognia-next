/**
 * The turns a runner drives right now, per chat session (ADR-0239 phase 2b).
 *
 * A turn `run-and-capture` drives (a scheduled task, a Bot, an IM reply, a
 * plugin's agent turn) plans its outbound calls with its own options
 * (`CaptureOptions.outboundPolicy`) and asks its person through its own
 * responder (`CaptureOptions.onPermissionRequest`): an IM card, a parked
 * approval on the phone. Something that happens inside such a turn but is not
 * a sidecar permission request, a browser submission, needs both, and finds
 * them here by the turn's session.
 *
 * A session with no captured turn is a desktop chat a person drives, asked on
 * the host's outbound dialog.
 */

import type { PermissionRequestEvent } from "@cognia/agent-config-types"
import type { CapturePermissionDecision } from "@/lib/claude/run-and-capture"

import type { OutboundToolPlannerOptions } from "./plan-tool-call"

export interface CapturedTurn {
  turnId: string
  /** How the turn plans its outbound calls. */
  outboundPolicy: OutboundToolPlannerOptions
  /** The turn's own way of asking its person; absent when it has none. */
  respond?: (
    request: PermissionRequestEvent
  ) => CapturePermissionDecision | Promise<CapturePermissionDecision>
  /**
   * Stop the turn's wall clock while its person is asked, as for its own
   * permission requests; call the returned function once they answered.
   */
  holdWallClock?: () => () => void
}

const turns = new Map<string, CapturedTurn[]>()

/**
 * Record that a captured turn runs in `sessionId` until the returned function
 * is called. Turns stack: the newest one in a session answers.
 */
export function beginCapturedTurn(sessionId: string, turn: CapturedTurn): () => void {
  const list = turns.get(sessionId) ?? []
  list.push(turn)
  turns.set(sessionId, list)
  return () => {
    const current = turns.get(sessionId)
    if (!current) return
    const index = current.indexOf(turn)
    if (index >= 0) current.splice(index, 1)
    if (current.length === 0) turns.delete(sessionId)
  }
}

/** The newest captured turn running in `sessionId`, if any. */
export function capturedTurnOf(sessionId: string): CapturedTurn | undefined {
  const list = turns.get(sessionId)
  return list?.[list.length - 1]
}

export function __resetCapturedTurnsForTesting(): void {
  turns.clear()
}
