/**
 * Asking a person about an integration job the outbound policy held (ADR-0239
 * phase 2).
 *
 * A held job waits `awaiting_approval` in the integration hub, where a person
 * can approve or cancel it. Nobody may be looking at the hub, so the hold is
 * also pushed the way an unattended tool request is (`createUnattendedPark`):
 * an `agent-turn` run with a `tool_approval` interrupt, announced on
 * `run://approval-pending`, which wakes a paired phone and shows in the
 * desktop cockpit with the recipients the write reaches. The answer is written
 * back to the job through `onAnswer`.
 *
 * Nobody answering before the park's TTL leaves the job held in the hub; it
 * is not a refusal. A person answering in the hub first withdraws the push
 * ({@link withdrawHeldIntegrationJob}).
 *
 * An Agent Team's held stack publish is pushed the same way, under its own
 * id and session (`sessionId`).
 */

import type { PendingOutboundReview } from "@cognia/agent-config-types"

import type { RunApprovalOrigin } from "@/lib/execution/run-approval-push"
import type { UnattendedParkOptions } from "@/lib/claude/unattended-park"

export interface HeldIntegrationJobPush {
  /** What is held: a job's id, or `team-delivery:<runId>` for a stack publish. */
  jobId: string
  /** The session the run is filed under. Default: {@link heldIntegrationJobSessionId}. */
  sessionId?: string
  /** The tool name the card shows, e.g. `integration__github-delivery__github__openPr`. */
  toolName: string
  /** The run's title, e.g. "GitHub: Open pull request". */
  label: string
  /** Where the phone opens the run: a Bot's runs, or the plugin's. */
  origin: RunApprovalOrigin
  review: PendingOutboundReview
  /** A person answered on the card. */
  onAnswer: (
    answer: { kind: "approved"; forRequest?: boolean } | { kind: "denied" }
  ) => Promise<unknown>
  /** Test seam: the park's own dependencies and TTL. */
  park?: Pick<UnattendedParkOptions, "deps" | "ttlMs" | "now">
}

const pushes = new Map<string, AbortController>()

/** The session a held job's run is filed under. */
export function heldIntegrationJobSessionId(jobId: string): string {
  return `integration-job:${jobId}`
}

/** Push a held job to a person; resolves once it is answered, expired or withdrawn. */
export async function pushHeldIntegrationJob(push: HeldIntegrationJobPush): Promise<void> {
  pushes.get(push.jobId)?.abort()
  const controller = new AbortController()
  pushes.set(push.jobId, controller)
  const { createUnattendedPark } = await import("@/lib/claude/unattended-park")
  const sessionId = push.sessionId ?? heldIntegrationJobSessionId(push.jobId)
  const park = createUnattendedPark({
    origin: push.origin,
    sessionId,
    label: push.label,
    signal: controller.signal,
    ...push.park,
  })
  let status: "completed" | "cancelled" = "cancelled"
  try {
    const outcome = await park.park({
      type: "permission_request",
      sessionId,
      requestId: `integration-hold:${push.jobId}`,
      toolUseID: push.jobId,
      toolName: push.toolName,
      input: {},
      permissionClass: "outbound",
      outbound: push.review,
    })
    if (outcome.kind === "approved") {
      status = "completed"
      await push.onAnswer({
        kind: "approved",
        ...(outcome.decision.forRequest ? { forRequest: true } : {}),
      })
    } else if (outcome.kind === "denied") {
      status = "completed"
      await push.onAnswer({ kind: "denied" })
    }
  } catch (error) {
    // The job stays held in the hub, where a person can still answer it.
    console.warn("[outbound] pushing a held integration job failed", error)
  } finally {
    if (pushes.get(push.jobId) === controller) pushes.delete(push.jobId)
    await park.finish(status).catch(() => undefined)
  }
}

/** Withdraw a held job's push: a person answered it somewhere else. */
export function withdrawHeldIntegrationJob(jobId: string): void {
  const controller = pushes.get(jobId)
  if (!controller) return
  pushes.delete(jobId)
  controller.abort()
}

/** Whether a held job's push is still waiting for an answer. */
export function isHeldIntegrationJobPushed(jobId: string): boolean {
  return pushes.has(jobId)
}
