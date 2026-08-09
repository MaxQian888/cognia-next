import type { AgentTaskStatus } from "@/types/agent/agent-task"

export type AgentTaskMoveDenial = "dependency-owned" | "runtime-owned" | "illegal-transition"
export type AgentTaskMoveVerdict =
  | { allowed: true }
  | { allowed: false; reason: AgentTaskMoveDenial }

const HUMAN_MOVES: Readonly<Record<AgentTaskStatus, readonly AgentTaskStatus[]>> = {
  pending: ["cancelled"],
  blocked: [],
  in_progress: ["paused", "cancelled"],
  review: ["completed", "failed"],
  paused: ["pending", "cancelled"],
  completed: [],
  failed: ["pending", "cancelled"],
  cancelled: [],
}

export function guardAgentTaskMove(
  from: AgentTaskStatus,
  to: AgentTaskStatus
): AgentTaskMoveVerdict {
  if (from === to) return { allowed: true }
  if (from === "blocked" || to === "blocked") {
    return { allowed: false, reason: "dependency-owned" }
  }
  if (to === "in_progress" || to === "review") {
    return { allowed: false, reason: "runtime-owned" }
  }
  return HUMAN_MOVES[from].includes(to)
    ? { allowed: true }
    : { allowed: false, reason: "illegal-transition" }
}

export function allowedAgentTaskMoves(status: AgentTaskStatus): AgentTaskStatus[] {
  return [...HUMAN_MOVES[status]]
}

export function deriveDependencyStatus(
  current: AgentTaskStatus,
  dependencyStatuses: readonly AgentTaskStatus[]
): AgentTaskStatus {
  if (current !== "pending" && current !== "blocked") return current
  return dependencyStatuses.every((status) => status === "completed") ? "pending" : "blocked"
}
