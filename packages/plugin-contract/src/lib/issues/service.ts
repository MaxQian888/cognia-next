/**
 * The plugin contract's share of `lib/issues/service.ts`, which re-exports these.
 */
import type {
  Issue,
  IssueActor,
  IssueOrigin,
  IssuePriority,
  IssueStatus,
  IssueTriageState,
} from "../../types/issues/index"
import type { ListIssuesQuery } from "../db/issues"

export interface CreateIssueRequest {
  /** Workspace. Defaults to the active one. */
  projectId?: string
  /** Container by id, or by key (`MERC`). Defaults to the workspace's first container. */
  issueProjectId?: string
  projectKey?: string
  title: string
  description?: string
  status?: IssueStatus
  priority?: IssuePriority
  assignee?: IssueActor
  /** Label NAMES, created when missing. */
  labels?: readonly string[]
  labelIds?: readonly string[]
  parentId?: string
  cycleId?: string
  dueDate?: number
  estimate?: number
  /** Sub-issue stage (`Issue.stage`), 1 to `ISSUE_STAGE_MAX`. Only meaningful with a parent. */
  stage?: number
  /** File it straight into triage (`Issue.triage`), for an intake that proposes work. */
  triage?: IssueTriageState
  by: IssueActor
  origin?: IssueOrigin
}

export interface IssueQuery extends ListIssuesQuery {
  projectKey?: string
  /** Case-insensitive substring over identifier, title and description. */
  text?: string
  limit?: number
}

/** The row without its indexed mirror (`externalKeys`) for callers outside the app. */
export type IssueWire = Omit<Issue, "externalKeys">
