export type WorkflowWaitpointKind = "approval" | "risk_gate" | "event_wait" | "human_input"

export type WorkflowWaitpointStatus =
  "pending" | "resolved" | "rejected" | "timed_out" | "cancelled"

export interface WorkflowWaitpointResolution {
  outcome: "approved" | "rejected" | "event" | "timed_out" | "cancelled"
  respondedBy?: string
  data?: unknown
  resolvedAt: number
}

/** Durable, single-decision checkpoint shared by approvals, risk gates, and event waits. */
export interface WorkflowWaitpoint {
  id: string
  kind: WorkflowWaitpointKind
  status: WorkflowWaitpointStatus
  runId: string
  workflowId: string
  stepId: string
  key: string
  correlationId?: string
  title?: string
  message?: string
  createdAt: number
  /** Earliest event eligible to resolve this checkpoint (normally run.startedAt). */
  notBefore: number
  /** Absolute deadline; never recomputed during crash recovery. */
  expiresAt?: number
  resolution?: WorkflowWaitpointResolution
  notificationSentAt?: number
  resolutionNotificationSentAt?: number
  updatedAt: number
}

/** Persist-before-match event consumed by at most one event waitpoint. */
export interface WorkflowWaitEvent {
  id: string
  key: string
  correlationId?: string
  source: string
  data?: unknown
  emittedAt: number
  expiresAt: number
  consumedByWaitpointId?: string
  consumedAt?: number
}

export type WorkflowWaitpointDecisionResult =
  | { ok: true; waitpoint: WorkflowWaitpoint }
  | { ok: false; reason: "not-found" | "already-decided" }

export interface WorkflowWaitpointRepository {
  create(waitpoint: WorkflowWaitpoint): Promise<WorkflowWaitpoint>
  get(id: string): Promise<WorkflowWaitpoint | undefined>
  listPending(kind?: WorkflowWaitpointKind): Promise<WorkflowWaitpoint[]>
  decide(
    id: string,
    resolution: WorkflowWaitpointResolution
  ): Promise<WorkflowWaitpointDecisionResult>
  cancel(
    id: string,
    respondedBy: string,
    resolvedAt?: number
  ): Promise<WorkflowWaitpointDecisionResult>
  emit(event: WorkflowWaitEvent): Promise<WorkflowWaitEvent>
  pruneExpiredEvents(now?: number): Promise<number>
}
