export type AgentTaskStatus =
  "pending" | "blocked" | "in_progress" | "review" | "paused" | "completed" | "failed" | "cancelled"

export type AgentTaskPriority = "low" | "normal" | "high" | "critical"
export type AgentTaskApprovalPolicy = "auto" | "on-risk" | "manual"

export interface AgentTaskComment {
  id: string
  author: "user" | "agent" | "system"
  text: string
  createdAt: number
}

export interface AgentTask {
  id: string
  agentId: string
  projectId?: string
  title: string
  description: string
  status: AgentTaskStatus
  priority: AgentTaskPriority
  dependencies: string[]
  tags: string[]
  order: number
  approvalPolicy: AgentTaskApprovalPolicy
  scheduledFor?: number
  scheduledTaskId?: string
  activeAttemptId?: string
  latestAttemptNo: number
  comments: AgentTaskComment[]
  createdAt: number
  updatedAt: number
  revision: number
}

export type AgentTaskAttemptStatus =
  "queued" | "running" | "paused" | "review" | "completed" | "failed" | "cancelled" | "interrupted"

export interface AgentTaskAttempt {
  id: string
  taskId: string
  agentId: string
  attemptNo: number
  status: AgentTaskAttemptStatus
  sessionId?: string
  runId?: string
  schedulerExecutionId?: string
  result?: string
  errorCode?: string
  errorMessage?: string
  createdAt: number
  startedAt?: number
  completedAt?: number
  updatedAt: number
}
