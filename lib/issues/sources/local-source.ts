/**
 * Local issue source — the only WRITABLE adapter on the federated board.
 *
 * Projects Dexie `issues` rows into `UnifiedIssueItem`. Everything else that
 * reaches the board (GitHub mirrors in slice ②, agent tasks in slice ③) is
 * read-only and comes through its own adapter with reduced capabilities.
 */

import type { Issue } from "@/types/issues"
import type {
  IssueSourceAdapter,
  IssueSourceMutation,
  IssueSourceQuery,
  UnifiedIssueItem,
} from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, makeUnifiedIssueId } from "@/types/issues/unified"
import {
  addIssueComment,
  addIssueLabel,
  deleteIssue,
  listIssues,
  moveIssue,
  moveIssueToProject,
  removeIssueLabel,
  setIssueAssignee,
  updateIssue,
} from "@/lib/db/issues"
import { getIssueSourceRegistry, type IssueSourceRegistry } from "./registry"

/** Deep link to an issue. Static export → query param, never a `[id]` route. */
export function issueHref(issueId: string): string {
  return `/issues?id=${encodeURIComponent(issueId)}`
}

/** Project a stored issue into the board's normalized shape. */
export function toUnifiedIssue(issue: Issue): UnifiedIssueItem {
  return {
    unifiedId: makeUnifiedIssueId("local", issue.id),
    kind: "local",
    sourceId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    ...(issue.description ? { description: issue.description } : {}),
    status: issue.status,
    statusCategory: issue.statusCategory,
    priority: issue.priority,
    ...(issue.assignee ? { assignee: issue.assignee } : {}),
    createdBy: issue.createdBy,
    labelIds: issue.labelIds,
    issueProjectId: issue.issueProjectId,
    order: issue.order,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    origin: {
      tableName: "issues",
      deepLinkHref: issueHref(issue.id),
    },
    capabilities: FULL_ISSUE_CAPABILITIES,
  }
}

export const localIssueSource: IssueSourceAdapter = {
  kind: "local",
  label: "Local",
  async list(query: IssueSourceQuery): Promise<UnifiedIssueItem[]> {
    const rows = await listIssues({
      projectId: query.projectId,
      ...(query.issueProjectId ? { issueProjectId: query.issueProjectId } : {}),
    })
    return rows.map(toUnifiedIssue)
  },
  async mutate(sourceId, action, by) {
    await mutateLocalIssue(sourceId, action, by)
  },
}

async function mutateLocalIssue(
  sourceId: string,
  action: IssueSourceMutation,
  by: Parameters<NonNullable<IssueSourceAdapter["mutate"]>>[2]
): Promise<void> {
  switch (action.kind) {
    case "status": {
      const error = await moveIssue({ id: sourceId, to: action.to, by })
      if (error && error !== "issue-not-found") throw new Error(error)
      return
    }
    case "title":
    case "description":
    case "priority":
      await updateIssue(sourceId, { [action.kind]: action.to }, by)
      return
    case "assignee":
      await setIssueAssignee(sourceId, action.to, by)
      return
    case "addLabel":
      await addIssueLabel(sourceId, action.labelId, by)
      return
    case "removeLabel":
      await removeIssueLabel(sourceId, action.labelId, by)
      return
    case "project":
      await moveIssueToProject(sourceId, action.issueProjectId, by)
      return
    case "comment":
      await addIssueComment(sourceId, action.body, by)
      return
    case "delete":
      await deleteIssue(sourceId)
  }
}

/**
 * Register the local source. Called from the tracker's initializer; takes an
 * explicit registry in tests so cases stay isolated from the singleton.
 */
export function registerLocalIssueSource(registry: IssueSourceRegistry = getIssueSourceRegistry()) {
  registry.register(localIssueSource)
}
