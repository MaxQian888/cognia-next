import type { WorkflowAppRequestActor } from "@/lib/workflow/apps/app-execution"

export type WorkflowBatchJobStatus =
  "queued" | "running" | "pausing" | "paused" | "cancelling" | "cancelled" | "completed" | "failed"

export type WorkflowBatchRowStatus =
  "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled"

export interface WorkflowBatchJob {
  id: string
  accountId: string
  appId: string
  appSlug: string
  appReleaseId: string
  versionId: string
  actor: WorkflowAppRequestActor
  /** Caller-provided key that makes batch creation retry-safe for this app owner. */
  idempotencyKey?: string
  status: WorkflowBatchJobStatus
  concurrency: number
  totalRows: number
  queuedRows: number
  activeRows: number
  waitingRows: number
  succeededRows: number
  failedRows: number
  cancelledRows: number
  createdAt: number
  updatedAt: number
  expiresAt: number
  totalDeadlineAt: number
  completedAt?: number
  runnerLeaseOwner?: string
  runnerLeaseExpiresAt?: number
}

export interface WorkflowBatchPage {
  job: WorkflowBatchJob
  rows: WorkflowBatchRow[]
  nextRowNumber?: number
}

export interface WorkflowBatchRow {
  id: string
  accountId: string
  jobId: string
  rowNumber: number
  idempotencyKey: string
  input: Record<string, unknown>
  status: WorkflowBatchRowStatus
  attempts: number
  runId?: string
  output?: unknown
  error?: { code: string; message: string }
  createdAt: number
  updatedAt: number
  expiresAt: number
}
