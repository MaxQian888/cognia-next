/**
 * Where a clicked Pro IDE workspace-panel row leads in Cognia.
 *
 * The extension echoes back the row id `buildWorkspaceSnapshot` minted
 * (`lib/codeserver/workspace-snapshot.ts`): `issue:<issueId>`, `plan:<planId>`
 * or `run:<issueRunId>`. Issues open on the board; a plan opens the chat
 * session it belongs to; a run opens the issue it is working. Plans and runs
 * need a lookup because the row carries only its own id.
 *
 * Returns null for an unknown prefix or a record that no longer exists, so the
 * caller can say so instead of navigating nowhere.
 */

import { issueHref } from "@/lib/issues/hrefs"
import { sessionHref } from "@/lib/issues/run/agent-task-adapter"

export interface WorkspaceRowTargetDeps {
  getPlan: (id: string) => Promise<{ sessionId: string } | undefined>
  getIssueRun: (id: string) => Promise<{ issueId: string } | undefined>
}

export async function resolveWorkspaceRowHref(
  rowId: string,
  deps: WorkspaceRowTargetDeps
): Promise<string | null> {
  const separator = rowId.indexOf(":")
  if (separator <= 0) return null
  const kind = rowId.slice(0, separator)
  const id = rowId.slice(separator + 1)
  if (!id) return null
  switch (kind) {
    case "issue":
      return issueHref(id)
    case "plan": {
      const plan = await deps.getPlan(id)
      return plan?.sessionId ? sessionHref(plan.sessionId) : null
    }
    case "run": {
      const run = await deps.getIssueRun(id)
      return run?.issueId ? issueHref(run.issueId) : null
    }
    default:
      return null
  }
}
