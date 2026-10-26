export type { DBScheduledTask } from "@cognia/plugin-contract/lib/db/scheduled-task-types"

/** One execution attempt of a scheduled task, as persisted. */
export interface DBTaskExecution {
  id: string
  taskId: string
  taskName: string
  taskType: string
  status: string
  input?: string // JSON serialized
  output?: string // JSON serialized
  error?: string
  retryAttempt: number
  duration?: number
  scheduledFor?: string // ISO date string
  triggerSource?: string
  terminalReason?: string
  retryScheduledAt?: string // ISO date string
  startedAt: string // ISO date string
  completedAt?: string // ISO date string
  logs: string // JSON serialized TaskExecutionLog[]
  phases?: string // JSON serialized TaskExecutionPhase[] (non-indexed)
}
