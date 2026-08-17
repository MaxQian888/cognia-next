/**
 * Issues (ADR-0129 roster addition, ADR-0130): the local issue tracker's rows
 * for the active workspace. Matches on identifier (`MERC-2`) and title, with
 * the description as secondary text; opens the issue on `/issues?id=…`.
 *
 * Only LOCAL issues are indexed — federated rows (GitHub mirrors, agent tasks)
 * have their own surfaces and their own search there; putting them here would
 * make ⌘K a second, competing board.
 */

import { CircleDotIcon } from "lucide-react"

import { listIssues } from "@/lib/db/issues"
import { issueHref } from "@/lib/issues/sources/local-source"
import type { Issue } from "@/types/issues"
import { createListProvider } from "./list-provider"

export const ISSUES_PROVIDER_ID = "builtin.issues"

export interface IssuesProviderDeps {
  listIssues: (projectId: string) => Promise<readonly Issue[]>
}

export function createIssuesProvider(deps: IssuesProviderDeps) {
  return createListProvider<Issue>({
    id: ISSUES_PROVIDER_ID,
    kind: "issue",
    // Per-workspace list, so the cache must not outlive a workspace switch.
    cache: false,
    load: (ctx) => (ctx.activeProjectId ? deps.listIssues(ctx.activeProjectId) : []),
    getTitle: (issue) => `${issue.identifier} ${issue.title}`,
    getSecondary: (issue) => issue.description,
    getKeywords: (issue) => [
      issue.identifier,
      issue.id,
      issue.status,
      issue.priority,
      ...(issue.assignee?.label ? [issue.assignee.label] : []),
    ],
    getTimestamp: (issue) => issue.updatedAt,
    toItem: ({ row, match }, ctx) => ({
      id: `issue:${row.id}`,
      kind: "issue",
      title: `${row.identifier} ${row.title}`,
      titlePositions: match.positions,
      subtitle: row.description?.trim() || undefined,
      meta: ctx.t(`issues.status.${row.status}`),
      icon: { lucide: CircleDotIcon },
      score: match.score,
      timestamp: row.updatedAt,
      extra: { archived: row.statusCategory === "completed" || row.statusCategory === "canceled" },
      action: { type: "navigate", href: issueHref(row.id) },
    }),
  })
}

export const issuesProvider = createIssuesProvider({
  listIssues: (projectId) => listIssues({ projectId }),
})
