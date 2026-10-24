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
 * This responder makes the decision at the call site, the same way on every
 * shell. With a park (ADR-0224 A7, `./unattended-park.ts`), which every Bot,
 * scheduled-task and plugin turn now passes, the request waits for a person:
 * it raises an approval interrupt, wakes a paired phone, and the turn resumes
 * on approval. A person's denial is their decision and tells the model so. A
 * question nobody answered before the park timed out, or that the turn ended
 * on, is recorded as a denial so the caller can mark its run `needs_approval`
 * instead of `completed`. Without a park, or when parking itself fails, the
 * request is denied at once, as before.
 *
 * A `bypassPermissions` turn rarely reaches it, but an unattended turn's
 * permission profile still makes its outbound, secret and host-configuration
 * calls ask, so even a bypass turn can park.
 *
 * Every answer says who gave it, so its action-review receipt is written: a
 * person's answer to a parked request is `human`, an expiry or a withdrawn
 * question is `timeout`, and a denial for want of any approver is `system`.
 * None of those but the person's denial fences an outbound recipient
 * (ADR-0239). The outbound policy itself runs ahead of this responder, in
 * `answerWithOutboundPolicy`.
 */

import type { PermissionRequestEvent } from "@cognia/agent-config-types"
import type { CapturePermissionDecision } from "./run-and-capture"
import type { UnattendedPark } from "./unattended-park"

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

/** A request a person answered with a denial while it was parked. */
export interface UnattendedPermissionRefusal {
  requestId: string
  toolName: string
  at: number
}

export interface UnattendedPermissionResponder {
  /** Plug into `RunAndCaptureOptions.onPermissionRequest`. */
  onPermissionRequest: (
    request: PermissionRequestEvent
  ) => CapturePermissionDecision | Promise<CapturePermissionDecision>
  /** Requests nobody approved (denied at once, timed out, or withdrawn), in arrival order. */
  readonly denials: readonly UnattendedPermissionDenial[]
  /** Requests a person explicitly denied while they were parked. */
  readonly refusals: readonly UnattendedPermissionRefusal[]
  /** True once any request went unapproved for want of an answer. */
  needsApproval: () => boolean
  /** Distinct tool names that were denied, for a one-line summary. */
  deniedToolNames: () => string[]
  /** Whether requests wait for a person instead of being denied at once. */
  readonly parks: boolean
  /** Close the run a parked request opened, once the turn is over. */
  finish: (status: "completed" | "failed" | "cancelled", summary?: string) => Promise<void>
}

/** Provider-visible text for a parked request a person refused. */
export function unattendedRefusalMessage(toolName: string, reason?: string): string {
  return (
    `A person reviewed the request to use tool "${toolName}" and denied it` +
    `${reason ? ` (${reason})` : ""}. Do not retry it. Finish what you can without it.`
  )
}

/** Provider-visible text for a parked request nobody answered in time. */
export function unattendedTimeoutMessage(surface: string, toolName: string): string {
  return (
    `Tool "${toolName}" needs a human approval. This ${surface} turn runs unattended, ` +
    `and nobody approved the request before it timed out, so it was recorded as ` +
    `${NEEDS_APPROVAL_STATUS}. Do not retry it. Finish what you can without it ` +
    `and state plainly what still needs approval.`
  )
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
 * @param options.park Park requests for a person instead of denying them.
 */
export function createUnattendedPermissionResponder(
  surface: string,
  options: { now?: () => number; park?: UnattendedPark } = {}
): UnattendedPermissionResponder {
  const now = options.now ?? (() => Date.now())
  const denials: UnattendedPermissionDenial[] = []
  const refusals: UnattendedPermissionRefusal[] = []
  const park = options.park

  const deny = (
    request: PermissionRequestEvent,
    reason: string,
    authority: "system" | "timeout"
  ): CapturePermissionDecision => {
    denials.push({ requestId: request.requestId, toolName: request.toolName, at: now(), reason })
    return { decision: "deny", message: reason, attribution: { authority } }
  }

  const parked = async (
    request: PermissionRequestEvent,
    parking: UnattendedPark
  ): Promise<CapturePermissionDecision> => {
    let outcome: Awaited<ReturnType<UnattendedPark["park"]>>
    try {
      outcome = await parking.park(request)
    } catch (error) {
      // Nowhere to park (no database, a broken journal): say so and fall back
      // to what an unattended turn did before parking existed.
      console.warn(
        `[unattended] could not park ${request.toolName}; denying it instead:`,
        error instanceof Error ? error.message : error
      )
      return deny(request, unattendedDenialMessage(surface, request.toolName), "system")
    }
    switch (outcome.kind) {
      case "approved":
        return {
          ...outcome.decision,
          attribution: outcome.decision.attribution ?? { authority: "human" },
        }
      case "denied": {
        refusals.push({ requestId: request.requestId, toolName: request.toolName, at: now() })
        return {
          decision: "deny",
          message: unattendedRefusalMessage(request.toolName, outcome.message),
          attribution: { authority: "human" },
        }
      }
      case "expired":
      case "withdrawn":
        return deny(request, unattendedTimeoutMessage(surface, request.toolName), "timeout")
    }
  }

  return {
    denials,
    refusals,
    parks: Boolean(park),
    onPermissionRequest: (request) =>
      park
        ? parked(request, park)
        : deny(request, unattendedDenialMessage(surface, request.toolName), "system"),
    needsApproval: () => denials.length > 0,
    deniedToolNames: () => [...new Set(denials.map((denial) => denial.toolName))],
    finish: async (status, summary) => {
      await park?.finish(status, summary)
    },
  }
}

/** One line for run lists: `needs approval: Edit, Bash`. */
export function needsApprovalSummary(responder: UnattendedPermissionResponder): string {
  return `${NEEDS_APPROVAL_STATUS.replace("_", " ")}: ${responder.deniedToolNames().join(", ")}`
}
