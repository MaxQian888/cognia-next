/**
 * `action.issue.*` and `trigger.issue.event` (spec 2026-09-06 D9).
 *
 * Every executor goes through `lib/issues/service.ts`, the same face the
 * /issue command, `ctx.issues` and the External Bridge use, so a workflow
 * can do exactly what a person at the board can and is refused the same
 * moves for the same reasons. Writes land in the trail with a workflow actor,
 * which is what the activity panel and the sync engine's field clock read.
 *
 * `trigger.issue.event` is a pass-through like `trigger.pet.event`: real
 * firing lives in `lib/workflow/runtime/issue-event-trigger.ts`. This handler
 * round-trips the trigger payload when a workflow runs manually.
 */

import { registerNodeExecutor } from "../registry"
import { nonRetryable } from "../shared/executor-support"
import type { StepExecutionContext } from "@/types/workflow/visual"
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
} from "@/lib/issues/service"
import { ensureIssueLabels } from "@/lib/issues/sync/apply"
import type { Issue, IssueActor, IssueStatus } from "@/types/issues"

/** The actor stamped on everything a workflow writes. */
export function workflowIssueActor(ctx: Pick<StepExecutionContext, "workflowId">): IssueActor {
  return { kind: "agent", id: `workflow:${ctx.workflowId}`, label: "Workflow" }
}

function requireIssueRef(params: Record<string, unknown>, kind: string): string {
  const ref = typeof params.issue === "string" ? params.issue.trim() : ""
  if (!ref) throw nonRetryable(`${kind} requires 'issue' (an id or identifier such as MERC-12)`)
  return ref
}

async function requireIssue(params: Record<string, unknown>, kind: string): Promise<Issue> {
  const ref = requireIssueRef(params, kind)
  const issue = await resolveIssue(ref)
  if (!issue) throw nonRetryable(`${kind}: no issue matches '${ref}'`)
  return issue
}

/** `["a", "b"]` or `"a, b"`. */
function nameList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string")
  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
  }
  return []
}

function optionalNumberOrNull(
  value: unknown,
  field: string,
  kind: string
): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value
  throw nonRetryable(`${kind}: '${field}' must be a non-negative number or null`)
}

function summarize(issue: Issue, outcomes: readonly IssueBulkOutcome[]) {
  const applied = outcomes.reduce((n, o) => n + o.applied, 0)
  const skipped = outcomes.reduce((n, o) => n + o.skipped, 0)
  const failed = outcomes.reduce((n, o) => n + o.failed, 0)
  const reason = outcomes.find((o) => o.reason)?.reason
  return {
    issueId: issue.id,
    identifier: issue.identifier,
    applied,
    skipped,
    failed,
    ...(reason ? { reason } : {}),
  }
}

async function applyAll(
  ctx: StepExecutionContext,
  issue: Issue,
  actions: readonly IssueBulkAction[]
) {
  const by = workflowIssueActor(ctx)
  const outcomes: IssueBulkOutcome[] = []
  for (const action of actions) outcomes.push(await applyIssueAction(issue, action, by))
  return { output: summarize(issue, outcomes) }
}

// ── action.issue.* ────────────────────────────────────────────────────────
registerNodeExecutor({
  kind: "action.issue.create",
  typeVersion: 1,
  execute: async (ctx) => {
    const p = ctx.params as Record<string, unknown>
    const title = typeof p.title === "string" ? p.title.trim() : ""
    if (!title) throw nonRetryable("action.issue.create requires non-empty 'title'")
    if (p.status !== undefined && !isIssueStatus(p.status)) {
      throw nonRetryable(`action.issue.create: unknown status '${String(p.status)}'`)
    }
    if (p.priority !== undefined && !isIssuePriority(p.priority)) {
      throw nonRetryable(`action.issue.create: unknown priority '${String(p.priority)}'`)
    }
    const dueDate = optionalNumberOrNull(p.dueDate, "dueDate", "action.issue.create")
    const estimate = optionalNumberOrNull(p.estimate, "estimate", "action.issue.create")
    const issue = await createIssueRecord({
      title,
      by: workflowIssueActor(ctx),
      ...(typeof p.description === "string" ? { description: p.description } : {}),
      ...(typeof p.projectId === "string" && p.projectId ? { projectId: p.projectId } : {}),
      ...(typeof p.issueProjectId === "string" && p.issueProjectId
        ? { issueProjectId: p.issueProjectId }
        : {}),
      ...(typeof p.projectKey === "string" && p.projectKey ? { projectKey: p.projectKey } : {}),
      ...(isIssueStatus(p.status) ? { status: p.status } : {}),
      ...(isIssuePriority(p.priority) ? { priority: p.priority } : {}),
      ...(nameList(p.labels).length ? { labels: nameList(p.labels) } : {}),
      ...(typeof p.parentId === "string" && p.parentId ? { parentId: p.parentId } : {}),
      ...(typeof p.cycleId === "string" && p.cycleId ? { cycleId: p.cycleId } : {}),
      ...(typeof dueDate === "number" ? { dueDate } : {}),
      ...(typeof estimate === "number" ? { estimate } : {}),
    })
    return {
      output: { issueId: issue.id, identifier: issue.identifier, issue: toIssueWire(issue) },
    }
  },
})

registerNodeExecutor({
  kind: "action.issue.get",
  typeVersion: 1,
  execute: async (ctx) => {
    const p = ctx.params as Record<string, unknown>
    const ref = requireIssueRef(p, "action.issue.get")
    const issue = await resolveIssue(ref)
    return {
      output: issue
        ? {
            found: true,
            issueId: issue.id,
            identifier: issue.identifier,
            issue: toIssueWire(issue),
          }
        : { found: false, ref },
    }
  },
})

registerNodeExecutor({
  kind: "action.issue.list",
  typeVersion: 1,
  execute: async (ctx) => {
    const p = ctx.params as Record<string, unknown>
    const statuses = Array.isArray(p.statuses) ? p.statuses.filter(isIssueStatus) : undefined
    const rows = await queryIssues({
      ...(typeof p.projectId === "string" && p.projectId ? { projectId: p.projectId } : {}),
      ...(typeof p.issueProjectId === "string" && p.issueProjectId
        ? { issueProjectId: p.issueProjectId }
        : {}),
      ...(typeof p.projectKey === "string" && p.projectKey ? { projectKey: p.projectKey } : {}),
      ...(statuses?.length ? { statuses } : {}),
      ...(typeof p.cycleId === "string" && p.cycleId ? { cycleId: p.cycleId } : {}),
      ...(typeof p.parentId === "string" && p.parentId ? { parentId: p.parentId } : {}),
      ...(typeof p.text === "string" && p.text.trim() ? { text: p.text } : {}),
      ...(typeof p.limit === "number" ? { limit: p.limit } : {}),
    })
    return { output: { count: rows.length, issues: rows.map(toIssueWire) } }
  },
})

registerNodeExecutor({
  kind: "action.issue.update",
  typeVersion: 1,
  execute: async (ctx) => {
    const p = ctx.params as Record<string, unknown>
    const issue = await requireIssue(p, "action.issue.update")
    const actions: IssueBulkAction[] = []
    if (typeof p.title === "string" && p.title.trim())
      actions.push({ kind: "title", to: p.title.trim() })
    if (typeof p.description === "string") actions.push({ kind: "description", to: p.description })
    if (p.status !== undefined) {
      if (!isIssueStatus(p.status)) {
        throw nonRetryable(`action.issue.update: unknown status '${String(p.status)}'`)
      }
      actions.push({ kind: "status", to: p.status as IssueStatus })
    }
    if (p.priority !== undefined) {
      if (!isIssuePriority(p.priority)) {
        throw nonRetryable(`action.issue.update: unknown priority '${String(p.priority)}'`)
      }
      actions.push({ kind: "priority", to: p.priority })
    }
    const dueDate = optionalNumberOrNull(p.dueDate, "dueDate", "action.issue.update")
    if (dueDate !== undefined) actions.push({ kind: "dueDate", to: dueDate })
    const estimate = optionalNumberOrNull(p.estimate, "estimate", "action.issue.update")
    if (estimate !== undefined) actions.push({ kind: "estimate", to: estimate })
    if (p.cycleId === null) actions.push({ kind: "cycle", cycleId: null })
    else if (typeof p.cycleId === "string" && p.cycleId)
      actions.push({ kind: "cycle", cycleId: p.cycleId })
    if (actions.length === 0) throw nonRetryable("action.issue.update: nothing to change")
    return applyAll(ctx, issue, actions)
  },
})

registerNodeExecutor({
  kind: "action.issue.assign",
  typeVersion: 1,
  execute: async (ctx) => {
    const p = ctx.params as Record<string, unknown>
    const issue = await requireIssue(p, "action.issue.assign")
    const kind = p.assigneeKind
    let to: IssueActor | null
    if (kind === "none") to = null
    else if (kind === "human") {
      to = {
        kind: "human",
        ...(typeof p.assigneeLabel === "string" ? { label: p.assigneeLabel } : {}),
      }
    } else if (kind === "agent" || kind === "team") {
      const id = typeof p.assigneeId === "string" ? p.assigneeId.trim() : ""
      if (!id) throw nonRetryable(`action.issue.assign: '${kind}' needs 'assigneeId'`)
      to = { kind, id, ...(typeof p.assigneeLabel === "string" ? { label: p.assigneeLabel } : {}) }
    } else {
      throw nonRetryable("action.issue.assign: 'assigneeKind' must be human, agent, team or none")
    }
    return applyAll(ctx, issue, [{ kind: "assignee", to }])
  },
})

registerNodeExecutor({
  kind: "action.issue.comment",
  typeVersion: 1,
  execute: async (ctx) => {
    const p = ctx.params as Record<string, unknown>
    const issue = await requireIssue(p, "action.issue.comment")
    const body = typeof p.body === "string" ? p.body.trim() : ""
    if (!body) throw nonRetryable("action.issue.comment requires non-empty 'body'")
    return applyAll(ctx, issue, [{ kind: "comment", body }])
  },
})

registerNodeExecutor({
  kind: "action.issue.label",
  typeVersion: 1,
  execute: async (ctx) => {
    const p = ctx.params as Record<string, unknown>
    const issue = await requireIssue(p, "action.issue.label")
    const add = nameList(p.add)
    const remove = nameList(p.remove)
    if (add.length === 0 && remove.length === 0) {
      throw nonRetryable("action.issue.label: give 'add' and/or 'remove' label names")
    }
    const actions: IssueBulkAction[] = []
    for (const row of await ensureIssueLabels(add))
      actions.push({ kind: "addLabel", labelId: row.id })
    if (remove.length) {
      // Removing never creates: resolve against what exists.
      const { listLabels } = await import("@/lib/db/labels")
      const existing = await listLabels("issue")
      const wanted = new Set(remove.map((name) => name.toLowerCase()))
      for (const row of existing) {
        if (wanted.has(row.name.toLowerCase()))
          actions.push({ kind: "removeLabel", labelId: row.id })
      }
    }
    if (actions.length === 0)
      throw nonRetryable("action.issue.label: none of the names to remove exist")
    return applyAll(ctx, issue, actions)
  },
})

// ── trigger.issue.event (pass-through) ────────────────────────────────────
registerNodeExecutor({
  kind: "trigger.issue.event",
  typeVersion: 1,
  execute: async (ctx) => {
    const kinds = (Array.isArray(ctx.params.kinds) ? ctx.params.kinds : []) as string[]
    return { output: { kinds, firedAt: ctx.trigger.originAt, payload: ctx.trigger.payload } }
  },
})
