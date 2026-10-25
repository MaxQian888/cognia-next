/**
 * Telling paired devices that an unattended run is waiting on a person
 * (ADR-0224 A7).
 *
 * Two kinds of question park a run with nobody watching it: a tool call an
 * unattended turn may only make with approval (`tool_approval`, raised by
 * `lib/claude/unattended-park.ts`) and a Bot handler's own approval step
 * (`bot_approval`, `lib/bot/runtime/step.ts`). Both are execution-run
 * interrupts, and both are announced the same way:
 *
 *   - `run://approval-pending` wakes a backgrounded phone (it is in the host's
 *     push trigger table). The payload is ids, the kind, the permission class
 *     and a deep link; it transits APNs/FCM, so the title and the tool input
 *     never ride it. The phone reads them with `execution_run_approval_list` on open.
 *   - `run://approval-resolved` tells a foreground approvals card to drop a
 *     row someone answered elsewhere, or that expired.
 */

import type { PermissionClass } from "@cognia/agent-config-types"
import { publishHostEvent } from "@/lib/companion/host-event-publisher"
import type { ExecutionRunInterrupt } from "@/types/execution/run"

import { RUN_APPROVAL_HREFS } from "./run-approval-tap"

export const RUN_APPROVAL_PENDING_CHANNEL = "run://approval-pending"
export const RUN_APPROVAL_RESOLVED_CHANNEL = "run://approval-resolved"

/** The interrupt kinds the approvals card answers. */
export const RUN_APPROVAL_TYPES = ["tool_approval", "bot_approval"] as const
export type RunApprovalType = (typeof RUN_APPROVAL_TYPES)[number]

export function isRunApprovalType(type: string): type is RunApprovalType {
  return (RUN_APPROVAL_TYPES as readonly string[]).includes(type)
}

/** Where the phone opens the approvals card for each origin. */
export type RunApprovalOrigin = "bot" | "scheduler" | "plugin" | "agent-team"

export function runApprovalHref(origin: RunApprovalOrigin): string {
  return origin === "scheduler"
    ? RUN_APPROVAL_HREFS.scheduler
    : origin === "agent-team"
      ? RUN_APPROVAL_HREFS.agentRuns
      : RUN_APPROVAL_HREFS.bots
}

export interface RunApprovalPendingPayload {
  interruptId: string
  runId: string
  type: RunApprovalType
  permissionClass?: PermissionClass
  expiresAt: number
  href: string
  /** Groups repeated wake-ups for one question on the phone. */
  dedupeKey: string
}

export interface RunApprovalResolvedPayload {
  interruptId: string
  runId: string
  status: "approved" | "denied" | "expired"
}

type Publish = (topic: string, payload: unknown) => Promise<void>

/** Announce one pending approval. Best-effort: a lost wake-up never fails the run. */
export async function announceRunApproval(
  interrupt: Pick<ExecutionRunInterrupt, "id" | "runId" | "type" | "expiresAt">,
  context: { origin: RunApprovalOrigin; permissionClass?: PermissionClass },
  publish: Publish = publishHostEvent
): Promise<void> {
  if (!isRunApprovalType(interrupt.type)) return
  const payload: RunApprovalPendingPayload = {
    interruptId: interrupt.id,
    runId: interrupt.runId,
    type: interrupt.type,
    ...(context.permissionClass ? { permissionClass: context.permissionClass } : {}),
    expiresAt: interrupt.expiresAt,
    href: runApprovalHref(context.origin),
    dedupeKey: `run-approval:${interrupt.id}`,
  }
  await publish(RUN_APPROVAL_PENDING_CHANNEL, payload).catch(() => undefined)
}

/** Announce that a pending approval is gone. Best-effort, like the wake-up. */
export async function announceRunApprovalResolved(
  payload: RunApprovalResolvedPayload,
  publish: Publish = publishHostEvent
): Promise<void> {
  await publish(RUN_APPROVAL_RESOLVED_CHANNEL, payload).catch(() => undefined)
}
