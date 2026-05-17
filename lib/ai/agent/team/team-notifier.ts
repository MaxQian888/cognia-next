/**
 * Placeholder — real implementation lands in PR 2 Task 2.4.
 * Defined here so team-run-context.ts can import the type contract.
 */

import type { ApprovalKey } from "@/lib/runtime/approval-bus"

export type TeamNotifyLevel = "info" | "warn" | "critical"

export interface TeamNotifyPayload {
  level: TeamNotifyLevel
  title: string
  body?: string
  runId: string
  teamId: string
  taskId?: string
  openApproval?: ApprovalKey
  detailHref?: string
  dedupeKey?: string
}

export interface TeamNotifier {
  notify(p: TeamNotifyPayload): void
  suspend(): void
  resume(): void
}
