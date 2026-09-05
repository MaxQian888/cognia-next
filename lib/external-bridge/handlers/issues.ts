/**
 * MCP tool handlers: the issue tracker (spec 2026-09-06 D9).
 *
 *   issues_list / issues_get         scope `issues:read`
 *   issues_create / issues_update / issues_comment   scope `issues:write`
 *
 * Pure handlers: validation plus delegation to `lib/issues/service.ts`, the
 * same face the board, the /issue command, the workflow nodes and `ctx.issues`
 * use. The MCP server layer owns the permission gate and the audit log. A
 * refused move (an issue the runtime currently owns, a read-only row) comes
 * back as `{ ok: false, reason }`, so an external agent can react without
 * string-matching error text. Writes are stamped with an `mcp` actor.
 */

import { listIssueEvents } from "@/lib/db/issue-events"
import {
  applyIssueAction,
  createIssueRecord,
  isIssuePriority,
  isIssueStatus,
  queryIssues,
  resolveIssue,
  toIssueWire,
  type IssueBulkAction,
  type IssueBulkOutcome,
  type IssueWire,
} from "@/lib/issues/service"
import type { IssueActor, IssueEvent, IssueStatus } from "@/types/issues"

export type { IssueWire }

export const MAX_ISSUE_TITLE_CHARS = 300
export const MAX_ISSUE_BODY_CHARS = 20_000
export const MAX_ISSUE_LIST = 200

/** Every write from the bridge carries this actor, so the trail says who did it. */
export const MCP_ISSUE_ACTOR: IssueActor = { kind: "agent", id: "mcp", label: "External agent" }

function requireText(value: string | undefined, field: string, max: number): string {
  const trimmed = (value ?? "").trim()
  if (trimmed.length === 0) throw new Error(`${field} must not be empty`)
  if (trimmed.length > max) throw new Error(`${field} exceeds ${max} characters`)
  return trimmed
}

export type IssueWriteFailure = {
  ok: false
  reason: "not_found" | "refused" | "invalid"
  detail?: string
}

export interface IssuesListInput {
  projectKey?: string
  issueProjectId?: string
  statuses?: string[]
  cycleId?: string
  text?: string
  limit?: number
}

export type IssuesListResult = { ok: true; issues: IssueWire[]; total: number }

export async function issuesList(input: IssuesListInput = {}): Promise<IssuesListResult> {
  const statuses = (input.statuses ?? []).filter(isIssueStatus)
  const limit = Math.min(Math.max(1, input.limit ?? 50), MAX_ISSUE_LIST)
  const rows = await queryIssues({
    ...(input.projectKey ? { projectKey: input.projectKey } : {}),
    ...(input.issueProjectId ? { issueProjectId: input.issueProjectId } : {}),
    ...(statuses.length ? { statuses } : {}),
    ...(input.cycleId ? { cycleId: input.cycleId } : {}),
    ...(input.text?.trim() ? { text: input.text } : {}),
  })
  return { ok: true, issues: rows.slice(0, limit).map(toIssueWire), total: rows.length }
}

export interface IssuesGetInput {
  /** Row id or printed identifier (MERC-12). */
  ref: string
  /** Include the newest trail entries (default 20, max 100). */
  events?: number
}

export type IssuesGetResult =
  { ok: true; issue: IssueWire; events: IssueEvent[] } | { ok: false; reason: "not_found" }

export async function issuesGet(input: IssuesGetInput): Promise<IssuesGetResult> {
  const ref = requireText(input.ref, "ref", 200)
  const issue = await resolveIssue(ref)
  if (!issue) return { ok: false, reason: "not_found" }
  const limit = Math.min(Math.max(0, input.events ?? 20), 100)
  const events =
    limit === 0 ? [] : await listIssueEvents({ issueId: issue.id, descending: true, limit })
  return { ok: true, issue: toIssueWire(issue), events }
}

export interface IssuesCreateInput {
  title: string
  description?: string
  projectKey?: string
  issueProjectId?: string
  status?: string
  priority?: string
  labels?: string[]
  parentId?: string
  cycleId?: string
  dueDate?: number
  estimate?: number
}

export type IssuesCreateResult = { ok: true; issue: IssueWire } | IssueWriteFailure

export async function issuesCreate(input: IssuesCreateInput): Promise<IssuesCreateResult> {
  const title = requireText(input.title, "title", MAX_ISSUE_TITLE_CHARS)
  if ((input.description ?? "").length > MAX_ISSUE_BODY_CHARS) {
    throw new Error(`description exceeds ${MAX_ISSUE_BODY_CHARS} characters`)
  }
  if (input.status !== undefined && !isIssueStatus(input.status)) {
    return { ok: false, reason: "invalid", detail: `unknown status '${input.status}'` }
  }
  if (input.priority !== undefined && !isIssuePriority(input.priority)) {
    return { ok: false, reason: "invalid", detail: `unknown priority '${input.priority}'` }
  }
  try {
    const issue = await createIssueRecord({
      title,
      by: MCP_ISSUE_ACTOR,
      ...(input.description?.trim() ? { description: input.description } : {}),
      ...(input.projectKey ? { projectKey: input.projectKey } : {}),
      ...(input.issueProjectId ? { issueProjectId: input.issueProjectId } : {}),
      ...(isIssueStatus(input.status) ? { status: input.status } : {}),
      ...(isIssuePriority(input.priority) ? { priority: input.priority } : {}),
      ...(input.labels?.length ? { labels: input.labels } : {}),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.cycleId ? { cycleId: input.cycleId } : {}),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
      ...(input.estimate !== undefined ? { estimate: input.estimate } : {}),
    })
    return { ok: true, issue: toIssueWire(issue) }
  } catch (error) {
    // "No project", "unknown key": the caller can fix these, so they are
    // answers, not transport failures.
    return {
      ok: false,
      reason: "invalid",
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

export interface IssuesUpdateInput {
  ref: string
  title?: string
  description?: string
  status?: string
  priority?: string
  assignee?: { kind: "human" | "agent" | "team"; id?: string; label?: string } | null
  dueDate?: number | null
  estimate?: number | null
  cycleId?: string | null
}

export type IssuesUpdateResult =
  { ok: true; issue: IssueWire; outcome: IssueBulkOutcome } | IssueWriteFailure

async function applyMany(
  ref: string,
  actions: readonly IssueBulkAction[]
): Promise<IssuesUpdateResult> {
  const issue = await resolveIssue(requireText(ref, "ref", 200))
  if (!issue) return { ok: false, reason: "not_found" }
  let applied = 0
  let skipped = 0
  let failed = 0
  let reason: IssueBulkOutcome["reason"]
  for (const action of actions) {
    const outcome = await applyIssueAction(issue, action, MCP_ISSUE_ACTOR)
    applied += outcome.applied
    skipped += outcome.skipped
    failed += outcome.failed
    reason ??= outcome.reason
  }
  const outcome: IssueBulkOutcome = { applied, skipped, failed, ...(reason ? { reason } : {}) }
  if (applied === 0) return { ok: false, reason: "refused", ...(reason ? { detail: reason } : {}) }
  const fresh = (await resolveIssue(issue.id)) ?? issue
  return { ok: true, issue: toIssueWire(fresh), outcome }
}

export async function issuesUpdate(input: IssuesUpdateInput): Promise<IssuesUpdateResult> {
  const actions: IssueBulkAction[] = []
  if (input.title !== undefined) {
    actions.push({ kind: "title", to: requireText(input.title, "title", MAX_ISSUE_TITLE_CHARS) })
  }
  if (input.description !== undefined) {
    if (input.description.length > MAX_ISSUE_BODY_CHARS) {
      throw new Error(`description exceeds ${MAX_ISSUE_BODY_CHARS} characters`)
    }
    actions.push({ kind: "description", to: input.description })
  }
  if (input.status !== undefined) {
    if (!isIssueStatus(input.status)) {
      return { ok: false, reason: "invalid", detail: `unknown status '${input.status}'` }
    }
    actions.push({ kind: "status", to: input.status as IssueStatus })
  }
  if (input.priority !== undefined) {
    if (!isIssuePriority(input.priority)) {
      return { ok: false, reason: "invalid", detail: `unknown priority '${input.priority}'` }
    }
    actions.push({ kind: "priority", to: input.priority })
  }
  if (input.assignee !== undefined) {
    if (input.assignee && input.assignee.kind !== "human" && !input.assignee.id) {
      return { ok: false, reason: "invalid", detail: "an agent or team assignee needs an id" }
    }
    actions.push({ kind: "assignee", to: input.assignee })
  }
  if (input.dueDate !== undefined) actions.push({ kind: "dueDate", to: input.dueDate })
  if (input.estimate !== undefined) actions.push({ kind: "estimate", to: input.estimate })
  if (input.cycleId !== undefined) actions.push({ kind: "cycle", cycleId: input.cycleId })
  if (actions.length === 0) return { ok: false, reason: "invalid", detail: "nothing to change" }
  return applyMany(input.ref, actions)
}

export interface IssuesCommentInput {
  ref: string
  body: string
}

export async function issuesComment(input: IssuesCommentInput): Promise<IssuesUpdateResult> {
  const body = requireText(input.body, "body", MAX_ISSUE_BODY_CHARS)
  return applyMany(input.ref, [{ kind: "comment", body }])
}
