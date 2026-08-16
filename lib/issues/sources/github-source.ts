/**
 * GitHub issue source — the first READ-ONLY federated adapter.
 *
 * Projects `githubIssueMirror` rows onto the same board as local issues. Every
 * capability except commenting is off: GitHub owns these rows, and the board
 * must grey the affordances out rather than accept a gesture it would fail to
 * honour. (Commenting is on because `plugins/github-delivery` already has a
 * write path for it — see slice ②'s write-back.)
 *
 * Reads from Dexie only. Refreshing the mirror is a separate concern owned by
 * the scheduler executor, so opening the board never blocks on the network and
 * an expired token degrades to stale-but-visible rather than empty.
 */

import type { GithubIssueMirrorRow, GithubIssueState } from "@/lib/db/github-issue-mirror-types"
import { listGithubIssues } from "@/lib/db/github-issue-mirror"
import { listIssueProjects } from "@/lib/db/issue-projects"
import type { IssueStatus } from "@/types/issues"
import { statusCategoryOf } from "@/types/issues"
import type { IssueSourceAdapter, IssueSourceQuery, UnifiedIssueItem } from "@/types/issues/unified"
import { makeUnifiedIssueId, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import { getIssueSourceRegistry, type IssueSourceRegistry } from "./registry"

/**
 * GitHub has two states where the board has six, so the mapping is lossy by
 * nature. It goes through `statusCategoryOf` rather than inventing a parallel
 * category, which is exactly what the `statusCategory` anchor exists for:
 *
 *   open                       → todo        (unstarted)
 *   closed + completed/absent  → done        (completed)
 *   closed + not_planned       → canceled    (canceled)
 *
 * `not_planned` is the one distinction worth keeping — "we decided not to" is
 * not the same outcome as "we finished it", and collapsing them would inflate
 * every project's progress bar.
 */
export function githubStateToStatus(state: GithubIssueState, stateReason?: string): IssueStatus {
  if (state === "open") return "todo"
  return stateReason === "not_planned" ? "canceled" : "done"
}

/** Project a mirrored row into the board's normalized shape. */
export function toUnifiedGithubIssue(row: GithubIssueMirrorRow): UnifiedIssueItem {
  const status = githubStateToStatus(row.state, row.stateReason)
  const assigneeLogin = row.assigneeLogins[0]

  return {
    unifiedId: makeUnifiedIssueId("github", row.id),
    kind: "github",
    sourceId: row.id,
    // Deliberately NOT a local `KEY-n` identifier: two numbering schemes on one
    // board makes `MERC-7` and `#7` indistinguishable in conversation.
    identifier: `${row.repoFullName}#${row.number}`,
    title: row.title,
    ...(row.body ? { description: row.body } : {}),
    status,
    statusCategory: statusCategoryOf(status),
    // GitHub has no priority field; a fabricated one would sort wrongly.
    priority: "none",
    ...(assigneeLogin
      ? { assignee: { kind: "human" as const, id: assigneeLogin, label: assigneeLogin } }
      : {}),
    ...(row.authorLogin
      ? { createdBy: { kind: "human" as const, id: row.authorLogin, label: row.authorLogin } }
      : {}),
    // Label ids are namespaced so a GitHub label can never collide with a row
    // in the local `labels` catalogue.
    labelIds: row.labels.map((label) => `github:${label.name}`),
    ...(row.issueProjectId ? { issueProjectId: row.issueProjectId } : {}),
    // GitHub has no manual board order; recency is the only honest ordering.
    order: 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    origin: {
      tableName: "githubIssueMirror",
      deepLinkHref: row.htmlUrl,
      sourceLabel: "GitHub",
    },
    capabilities: { ...READ_ONLY_ISSUE_CAPABILITIES, canComment: true },
  }
}

export const githubIssueSource: IssueSourceAdapter = {
  kind: "github",
  label: "GitHub",
  async list(query: IssueSourceQuery): Promise<UnifiedIssueItem[]> {
    if (query.issueProjectId) {
      const rows = await listGithubIssues({ issueProjectId: query.issueProjectId })
      return rows.map(toUnifiedGithubIssue)
    }

    // Mirror rows are keyed by repo and delivery container — NOT by workspace.
    // So the workspace-wide read has to resolve this workspace's containers
    // first and filter to those; listing every bound row would put another
    // workspace's GitHub issues on this board.
    const containers = await listIssueProjects({ projectId: query.projectId })
    if (containers.length === 0) return []
    const allowed = new Set(containers.map((container) => container.id))

    const rows = await listGithubIssues({})
    return rows
      .filter((row) => row.issueProjectId !== undefined && allowed.has(row.issueProjectId))
      .map(toUnifiedGithubIssue)
  },
}

export function registerGithubIssueSource(
  registry: IssueSourceRegistry = getIssueSourceRegistry()
) {
  registry.register(githubIssueSource)
}
