/**
 * Project an execution run onto the status vocabulary the side panel shows.
 *
 * A separate, pure function because the two vocabularies are not the same
 * shape and never will be. `ExecutionRunStatus` is the runtime's own eight
 * states; the panel's is what a person standing in a browser needs to know,
 * which is narrower — `paused` and `waiting` both mean "it wants you", and
 * `recovery_required` means "it stopped and only the desktop can fix it".
 *
 * Collapsing them here rather than in the reader keeps the mapping in one
 * place and testable without a database.
 *
 * A session with no run at all is deliberately NOT projected here. It used to
 * answer `queued`, which quietly overwrote a row that had already recorded
 * `failed` or `host_unavailable` — the run the reader looked for does not exist
 * precisely because the enqueue never happened. The reader answers `null` for
 * that case and the recorded row stands.
 */
import type { AgentTaskStatus } from "@/types/agent/agent-task"
import type { BrowserSubmissionStatus } from "@/types/browser-companion"
import type { ExecutionRunStatus } from "@/types/execution/run"
import { statusCategoryOf, type IssueStatus } from "@/types/issues"

export function browserStatusForRun(status: ExecutionRunStatus): BrowserSubmissionStatus {
  switch (status) {
    case "queued":
      return "queued"
    case "running":
      return "running"
    // Both mean the run has stopped and is waiting on a person. The panel
    // deliberately offers no way to answer — it deep-links to Cognia — so a
    // single "needs you" state is the honest projection of both.
    case "waiting":
    case "paused":
      return "needs_input"
    case "completed":
      return "completed"
    case "cancelled":
      return "cancelled"
    // `recovery_required` is a failure the browser cannot act on. Reporting it
    // as `needs_input` would invite the user to answer a prompt that is not
    // there; reporting it as `failed` sends them to the desktop, which is the
    // only place it can be resolved.
    case "recovery_required":
    case "failed":
      return "failed"
  }
}

/**
 * Project an issue's column onto the panel's vocabulary.
 *
 * Through `statusCategoryOf` rather than the raw column, because that mapping
 * is the tracker's stated authority for every cross-system projection — a
 * custom column added later lands in a category and needs no change here.
 *
 * A filed issue is never `running`: nothing is executing it. `unstarted` and
 * `started` both read as `queued`, which is the honest thing to say about a
 * card on a board — it is waiting for somebody, and the panel offers no way to
 * be that somebody.
 */
export function browserStatusForIssue(status: IssueStatus): BrowserSubmissionStatus {
  switch (statusCategoryOf(status)) {
    case "completed":
      return "completed"
    case "canceled":
      return "cancelled"
    default:
      return "queued"
  }
}

/**
 * Project an agent task's state onto the panel's vocabulary.
 *
 * `blocked` is `queued` rather than `needs_input`: it is waiting on another
 * task, not on a person, and "it wants you" would send somebody looking for a
 * prompt that does not exist. `review` and `paused` are the two that genuinely
 * want a person, which is what `needs_input` means everywhere else here.
 */
export function browserStatusForAgentTask(status: AgentTaskStatus): BrowserSubmissionStatus {
  switch (status) {
    case "pending":
    case "blocked":
      return "queued"
    case "in_progress":
      return "running"
    case "review":
    case "paused":
      return "needs_input"
    case "completed":
      return "completed"
    case "cancelled":
      return "cancelled"
    case "failed":
      return "failed"
  }
}
