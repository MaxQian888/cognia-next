/**
 * The plugin contract's share of `lib/db/issues.ts`, which re-exports these.
 */
import type { IssueActor, IssueStatus } from "../../types/issues/index"

export interface ListIssuesQuery {
  parentId?: string
  cycleId?: string
  /** Workspace scope. Omit only for export/settings paths. */
  projectId?: string
  issueProjectId?: string
  statuses?: readonly IssueStatus[]
  assigneeKind?: IssueActor["kind"]
  assigneeId?: string
}
