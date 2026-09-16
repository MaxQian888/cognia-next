/**
 * Run lifecycle machine, generated from `contracts/spec/state_transitions.json`.
 *
 * The JSON file is the public contract; this module only reads it, so a change
 * to the allowed transitions is a contract change (ADR + migration), never a
 * local edit. Terminal states have no outgoing edges: a finished run is never
 * resumed — a retry is a NEW run pointing back through `parent_run_id`.
 */

import transitions from "../contracts/spec/state_transitions.json"
import { RUN_STATUSES, type RunStatus } from "../contracts/schemas"

const TABLE = transitions as Record<RunStatus, RunStatus[]>

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = RUN_STATUSES.filter(
  (status) => TABLE[status].length === 0
)

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TABLE[status].length === 0
}

export function allowedRunTransitions(from: RunStatus): readonly RunStatus[] {
  return TABLE[from]
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return TABLE[from].includes(to)
}

export class IllegalRunTransitionError extends Error {
  readonly code = "ILLEGAL_RUN_TRANSITION"
  constructor(
    readonly from: RunStatus,
    readonly to: RunStatus
  ) {
    super(`run status cannot move from ${from} to ${to}`)
    this.name = "IllegalRunTransitionError"
  }
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) throw new IllegalRunTransitionError(from, to)
}

/** Statuses from which no new billable business call may start (INV-08). */
export function acceptsNewCalls(status: RunStatus): boolean {
  return status === "running"
}

/**
 * The host's coarse run status (`ExecutionRunStatus` in the app) plus the
 * detail that keeps the spec status recoverable. The app only *projects* into
 * this shape; the fusion event log remains the single source of truth.
 */
export type HostRunStatus =
  "queued" | "running" | "waiting" | "recovery_required" | "completed" | "failed" | "cancelled"

export type HostRunStatusDetail =
  "waiting_for_input" | "waiting_for_approval" | "reconciling" | "cancelling" | "expired"

export interface HostRunStatusProjection {
  status: HostRunStatus
  statusDetail?: HostRunStatusDetail
}

export function projectHostRunStatus(status: RunStatus): HostRunStatusProjection {
  switch (status) {
    case "queued":
      return { status: "queued" }
    case "running":
      return { status: "running" }
    case "waiting_for_input":
      return { status: "waiting", statusDetail: "waiting_for_input" }
    case "waiting_for_approval":
      return { status: "waiting", statusDetail: "waiting_for_approval" }
    case "reconciling":
      return { status: "running", statusDetail: "reconciling" }
    case "cancelling":
      return { status: "running", statusDetail: "cancelling" }
    case "succeeded":
      return { status: "completed" }
    case "failed":
      return { status: "failed" }
    case "cancelled":
      return { status: "cancelled" }
    case "expired":
      return { status: "failed", statusDetail: "expired" }
  }
}

/** Inverse of {@link projectHostRunStatus}; `paused` is not a routed-run state. */
export function specRunStatusFromHost(projection: HostRunStatusProjection): RunStatus {
  const { status, statusDetail } = projection
  if (statusDetail) {
    if (statusDetail === "expired" && status === "failed") return "expired"
    if (
      status === "waiting" &&
      (statusDetail === "waiting_for_input" || statusDetail === "waiting_for_approval")
    ) {
      return statusDetail
    }
    if (status === "running" && (statusDetail === "reconciling" || statusDetail === "cancelling")) {
      return statusDetail
    }
    throw new Error(`inconsistent host projection ${status}/${statusDetail}`)
  }
  switch (status) {
    case "queued":
    case "running":
    case "failed":
    case "cancelled":
      return status
    case "completed":
      return "succeeded"
    case "recovery_required":
      return "reconciling"
    case "waiting":
      throw new Error("waiting without a detail is not a routed-run state")
  }
}
