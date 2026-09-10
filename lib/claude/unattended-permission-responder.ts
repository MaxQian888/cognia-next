/**
 * The permission responder for turns nobody is watching.
 *
 * Plugin `agent-turn`, the Bot `agent-turn` executor and scheduled chat / agent
 * / skill tasks all start a tool-enabled turn with no approver attached. What
 * happened to a `permission_request` on such a turn depended on the shell:
 * the desktop's chat event listener auto-denied it with "session not open"
 * and the turn "completed" with the work not done, the headless brain had no
 * listener at all so the turn sat on the sidecar's `canUseTool` until the
 * five-minute capture timeout and was reported as a timeout, and a standalone
 * browser threw before the send. None of the three told the caller that a tool
 * needed a human.
 *
 * This responder makes the decision at the call site, once, the same way on
 * every shell: deny immediately, tell the model why, and record the denial so
 * the caller can mark its run `needs_approval` instead of `completed`.
 *
 * `bypassPermissions` turns never reach it (the runtime asks nothing), so a
 * caller that resolved that authority keeps unattended autonomy. Everything
 * else fails fast and honestly.
 */

import type { PermissionRequestEvent } from "@cognia/agent-config-types"
import type { CapturePermissionDecision } from "./run-and-capture"

/** The status a run carries when at least one tool was denied for want of an approver. */
export const NEEDS_APPROVAL_STATUS = "needs_approval" as const

/** One tool request the responder turned away. */
export interface UnattendedPermissionDenial {
  requestId: string
  toolName: string
  /** Wall-clock ms when the denial was issued. */
  at: number
  /** The message the model was given. */
  reason: string
}

export interface UnattendedPermissionResponder {
  /** Plug into `RunAndCaptureOptions.onPermissionRequest`. */
  onPermissionRequest: (request: PermissionRequestEvent) => CapturePermissionDecision
  /** Every denial so far, in arrival order. */
  readonly denials: readonly UnattendedPermissionDenial[]
  /** True once any request was denied. */
  needsApproval: () => boolean
  /** Distinct tool names that were denied, for a one-line summary. */
  deniedToolNames: () => string[]
}

/** Provider-visible text. English on purpose: the model reads it. */
export function unattendedDenialMessage(surface: string, toolName: string): string {
  return (
    `Tool "${toolName}" needs a human approval, and this ${surface} turn runs ` +
    `unattended with no approver attached. The request was recorded as ` +
    `${NEEDS_APPROVAL_STATUS}. Do not retry it. Finish what you can without it ` +
    `and state plainly what still needs approval.`
  )
}

/**
 * Build a responder for one turn.
 *
 * @param surface Where the turn came from ("plugin", "bot", "scheduled task").
 *   Only used in the message the model sees and in logs.
 */
export function createUnattendedPermissionResponder(
  surface: string,
  options: { now?: () => number } = {}
): UnattendedPermissionResponder {
  const now = options.now ?? (() => Date.now())
  const denials: UnattendedPermissionDenial[] = []
  return {
    denials,
    onPermissionRequest: (request) => {
      const reason = unattendedDenialMessage(surface, request.toolName)
      denials.push({ requestId: request.requestId, toolName: request.toolName, at: now(), reason })
      return { decision: "deny", message: reason }
    },
    needsApproval: () => denials.length > 0,
    deniedToolNames: () => [...new Set(denials.map((denial) => denial.toolName))],
  }
}

/** One line for run lists: `needs approval: Edit, Bash`. */
export function needsApprovalSummary(responder: UnattendedPermissionResponder): string {
  return `${NEEDS_APPROVAL_STATUS.replace("_", " ")}: ${responder.deniedToolNames().join(", ")}`
}
