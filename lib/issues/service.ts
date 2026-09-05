/**
 * The tracker's programmatic face (spec 2026-09-06 D9).
 *
 * Workflow nodes, the /issue slash command, the plugin `ctx.issues` API and
 * the External Bridge all want the same handful of operations: find an
 * issue by id or printed identifier, create one into a container, apply one
 * board action through the same gate the board itself uses, and list. They
 * used to each reach into `lib/db/issues.ts` and reimplement the defaults.
 * This module is the one place those defaults live, so every caller refuses
 * the same moves for the same reasons (`canApplyBulkAction`), resolves
 * `MERC-12` the same way, and stamps the same provenance.
 *
 * No React, no stores beyond the active-workspace read. Writes never bypass
 * the trail: creation and every action append `issueEvents`, which also
 * publishes on `lib/issues/event-bus.ts`.
 */

import { getIssueProject, getIssueProjectByKey, listIssueProjects } from "@/lib/db/issue-projects"
import { listActiveIssueRunIssueIds } from "@/lib/db/issue-runs"
import {
  createIssue,
  getIssue,
  getIssueByIdentifier,
  listIssues,
  type CreateIssueInput,
  type ListIssuesQuery,
} from "@/lib/db/issues"
import { applyIssueBulkAction, type IssueBulkAction, type IssueBulkOutcome } from "./bulk-actions"
import { toUnifiedIssue } from "./sources/local-source"
import { ensureIssueLabels } from "./sync/apply"
import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  type Issue,
  type IssueActor,
  type IssueOrigin,
  type IssuePriority,
  type IssueStatus,
} from "@/types/issues"

/** The active workspace, or null outside a signed-in shell. */
export async function activeWorkspaceId(): Promise<string | null> {
  const { useProjectStore } = await import("@/stores/project/project-store")
  return useProjectStore.getState().activeProjectId ?? null
}

/** `MERC-12` or a row id. Identifiers are case-insensitive. */
export async function resolveIssue(ref: string): Promise<Issue | undefined> {
  const trimmed = ref.trim()
  if (!trimmed) return undefined
  const byId = await getIssue(trimmed)
  if (byId) return byId
  return getIssueByIdentifier(trimmed.toUpperCase())
}

export function isIssueStatus(value: unknown): value is IssueStatus {
  return typeof value === "string" && (ISSUE_STATUSES as readonly string[]).includes(value)
}

export function isIssuePriority(value: unknown): value is IssuePriority {
  return typeof value === "string" && (ISSUE_PRIORITIES as readonly string[]).includes(value)
}

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
  by: IssueActor
  origin?: IssueOrigin
}

/**
 * Resolve the container a caller named, or the workspace's first one. Throws
 * a readable error rather than creating an orphan row.
 */
export async function resolveIssueContainer(input: {
  projectId?: string
  issueProjectId?: string
  projectKey?: string
}): Promise<{ projectId: string; issueProjectId: string }> {
  if (input.issueProjectId) {
    // A named container carries its workspace, so a caller outside the shell
    // (the bridge, a headless job) does not need an active workspace.
    const container = await getIssueProject(input.issueProjectId)
    if (!container) throw new Error(`No project with id ${input.issueProjectId}`)
    if (input.projectId && container.projectId !== input.projectId) {
      throw new Error(`Project ${input.issueProjectId} is not in workspace ${input.projectId}`)
    }
    return { projectId: container.projectId, issueProjectId: container.id }
  }
  const projectId = input.projectId ?? (await activeWorkspaceId())
  if (!projectId) throw new Error("No active workspace to file the issue in")
  if (input.projectKey) {
    const byKey = await getIssueProjectByKey(input.projectKey.trim().toUpperCase())
    if (!byKey || byKey.projectId !== projectId) {
      throw new Error(
        `No project with key ${input.projectKey.trim().toUpperCase()} in this workspace`
      )
    }
    return { projectId, issueProjectId: byKey.id }
  }
  const containers = await listIssueProjects({ projectId })
  const first = containers[0]
  if (!first) throw new Error("Create a project first: issues need somewhere to live")
  return { projectId, issueProjectId: first.id }
}

export async function createIssueRecord(request: CreateIssueRequest): Promise<Issue> {
  const title = request.title.trim()
  if (!title) throw new Error("Issue title is required")
  const { projectId, issueProjectId } = await resolveIssueContainer(request)
  const labelIds = new Set<string>(request.labelIds ?? [])
  if (request.labels?.length) {
    for (const row of await ensureIssueLabels(request.labels)) labelIds.add(row.id)
  }
  const input: CreateIssueInput = {
    projectId,
    issueProjectId,
    title,
    createdBy: request.by,
    ...(request.description?.trim() ? { description: request.description.trim() } : {}),
    ...(request.status ? { status: request.status } : {}),
    ...(request.priority ? { priority: request.priority } : {}),
    ...(request.assignee ? { assignee: request.assignee } : {}),
    ...(labelIds.size ? { labelIds: [...labelIds] } : {}),
    ...(request.parentId ? { parentId: request.parentId } : {}),
    ...(request.cycleId ? { cycleId: request.cycleId } : {}),
    ...(request.dueDate !== undefined ? { dueDate: request.dueDate } : {}),
    ...(request.estimate !== undefined ? { estimate: request.estimate } : {}),
    ...(request.origin ? { origin: request.origin } : {}),
  }
  return createIssue(input)
}

/**
 * One board action on one local issue, through the board's own gate. The
 * outcome says whether it applied, was skipped (and why) or failed, exactly
 * as a bulk selection would report it.
 */
export async function applyIssueAction(
  issue: Issue,
  action: IssueBulkAction,
  by: IssueActor
): Promise<IssueBulkOutcome> {
  const running = await listActiveIssueRunIssueIds(issue.projectId)
  const runningUnified = new Set([...running].map((id) => `local:${id}`))
  return applyIssueBulkAction([toUnifiedIssue(issue)], action, by, runningUnified)
}

export interface IssueQuery extends ListIssuesQuery {
  projectKey?: string
  /** Case-insensitive substring over identifier, title and description. */
  text?: string
  limit?: number
}

export async function queryIssues(query: IssueQuery = {}): Promise<Issue[]> {
  const projectId = query.projectId ?? (await activeWorkspaceId()) ?? undefined
  let issueProjectId = query.issueProjectId
  if (!issueProjectId && query.projectKey) {
    const container = await getIssueProjectByKey(query.projectKey.trim().toUpperCase())
    if (!container) return []
    issueProjectId = container.id
  }
  const { projectKey: _key, text, limit, ...rest } = query
  void _key
  let rows = await listIssues({
    ...rest,
    ...(projectId ? { projectId } : {}),
    ...(issueProjectId ? { issueProjectId } : {}),
  })
  const needle = text?.trim().toLowerCase()
  if (needle) {
    rows = rows.filter((issue) =>
      [issue.identifier, issue.title, issue.description ?? ""].some((field) =>
        field.toLowerCase().includes(needle)
      )
    )
  }
  return limit !== undefined ? rows.slice(0, Math.max(0, limit)) : rows
}

/** The row without its indexed mirror (`externalKeys`) for callers outside the app. */
export type IssueWire = Omit<Issue, "externalKeys">

export function toIssueWire(issue: Issue): IssueWire {
  const { externalKeys: _keys, ...wire } = issue
  void _keys
  return wire
}

export type { IssueBulkAction, IssueBulkOutcome }
