/**
 * Status projections for the two agent-side federated sources.
 *
 * Both engines have eight statuses where the board has six, so the mapping is
 * lossy by design and follows the rule `github-source.ts` established: map to
 * the *category* the board keys everything off, and preserve the "we decided
 * not to" (`canceled`) vs "we finished" (`done`) distinction.
 *
 *   pending                → backlog      (unstarted — nobody has queued it yet)
 *   blocked / claimed      → todo         (unstarted — it is next, but not running)
 *   in_progress / paused   → in_progress  (started — paused still owns its slot)
 *   review                 → in_review    (started — waiting on the human)
 *   completed              → done
 *   failed / cancelled     → canceled     (an engine that gave up is not "done")
 *
 * `failed → canceled` is the deliberate choice: on the issue board a failed
 * agent task must not inflate any project's progress bar, and the card badge
 * plus deep link carry the engine's own status for the detail.
 */

import type { AgentTaskStatus } from "@/types/agent/agent-task"
import type { TeamTaskStatus } from "@/types/agent/agent-team"
import type { SubAgentPriority } from "@/types/agent/sub-agent"
import type { IssuePriority, IssueStatus } from "@/types/issues"

export function agentTaskStatusToIssueStatus(status: AgentTaskStatus): IssueStatus {
  switch (status) {
    case "pending":
      return "backlog"
    case "blocked":
      return "todo"
    case "in_progress":
    case "paused":
      return "in_progress"
    case "review":
      return "in_review"
    case "completed":
      return "done"
    case "failed":
    case "cancelled":
      return "canceled"
  }
}

export function teamTaskStatusToIssueStatus(status: TeamTaskStatus): IssueStatus {
  switch (status) {
    case "pending":
      return "backlog"
    case "blocked":
    case "claimed":
      return "todo"
    case "in_progress":
      return "in_progress"
    case "review":
      return "in_review"
    case "completed":
      return "done"
    case "failed":
    case "cancelled":
      return "canceled"
  }
}

/** `AgentTaskPriority` (`low|normal|high|critical`) → `IssuePriority`. */
export function agentTaskPriorityToIssuePriority(
  priority: "low" | "normal" | "high" | "critical"
): IssuePriority {
  switch (priority) {
    case "critical":
      return "urgent"
    case "high":
      return "high"
    case "normal":
      return "medium"
    case "low":
      return "low"
  }
}

/** `SubAgentPriority` → `IssuePriority`; `background` has no board meaning → `none`. */
export function subAgentPriorityToIssuePriority(priority: SubAgentPriority): IssuePriority {
  switch (priority) {
    case "critical":
      return "urgent"
    case "high":
      return "high"
    case "normal":
      return "medium"
    case "low":
      return "low"
    case "background":
      return "none"
  }
}
