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
 */
import type { BrowserSubmissionStatus } from "@/types/browser-companion"
import type { ExecutionRunStatus } from "@/types/execution/run"

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
 * The status of a submission whose session has no run yet.
 *
 * Not `failed`. A session that was created a moment ago and whose turn has not
 * reached the ledger is the ordinary state during the first second of every
 * submission, and calling it a failure would make every successful submission
 * flash red before it went green.
 */
export const BROWSER_STATUS_WITHOUT_RUN: BrowserSubmissionStatus = "queued"
