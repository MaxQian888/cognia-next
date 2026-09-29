/**
 * Shared lookup for the `issue.wakeup_*` verbs that act on an existing rule:
 * the id names a wakeup, and that wakeup's issue is in this session's
 * workspace. Identifiers are unique across workspaces and wakeup ids are
 * opaque, so without the scope check an id from another workspace would let a
 * conversation pause or delete rules it cannot see.
 */

import type { ScheduledTask } from "@/types/scheduler"
import type { Issue } from "@/types/issues"
import type { BuiltInSkillContext } from "../types"
import { resolveWorkspaceId } from "./_core"

export async function resolveWakeupInWorkspace(
  wakeupId: string,
  ctx: Pick<BuiltInSkillContext, "sessionId">
): Promise<{ task: ScheduledTask; issue: Issue }> {
  const [{ getIssueWakeup }, { readWakeupPayload }, { getIssue }] = await Promise.all([
    import("@/lib/issues/wakeups/service"),
    import("@/lib/issues/wakeups/model"),
    import("@/lib/db/issues"),
  ])
  const task = await getIssueWakeup(wakeupId)
  if (!task) throw new Error(`No issue wakeup ${wakeupId}. Use issue_wakeup_list first.`)
  const payload = readWakeupPayload(task.payload)!
  const issue = await getIssue(payload.issueId)
  const workspaceId = await resolveWorkspaceId(ctx)
  if (!issue || issue.projectId !== workspaceId) {
    throw new Error(`Issue wakeup ${wakeupId} belongs to another workspace`)
  }
  return { task, issue }
}
