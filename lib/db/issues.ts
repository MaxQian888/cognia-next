/**
 * Issue CRUD — Dexie table `issues` (schema v170).
 *
 * Local issues are the ONLY writable source of truth on the board; GitHub
 * mirrors and agent tasks reach it as read-only federated rows through
 * `lib/issues/sources/`. Nothing in this module knows about those.
 *
 * NAMING: `Issue.projectId` is the WORKSPACE (repo-wide isolation column);
 * `Issue.issueProjectId` is the delivery container. See the invariant block in
 * `types/issues/index.ts`.
 *
 * Mechanical module — no gating, no LLM, no i18n. Guard decisions live in
 * `lib/issues/state-machine.ts` and are *applied* here, matching how
 * `lib/db/goals.ts` stays mechanical while `lib/goal/runtime.ts` enforces
 * invariants.
 *
 * Every mutation appends to the activity trail (`lib/db/issue-events.ts`) in
 * the same transaction as the row write, so the timeline can never disagree
 * with the row.
 */

import type { Issue, IssueActor, IssueGithubRef, IssuePriority, IssueStatus } from "@/types/issues"
import { statusCategoryOf } from "@/types/issues"
import { formatIssueIdentifier } from "@/lib/issues/identifier"
import { canMoveIssue, statusTimestampPatch, type IssueMoveError } from "@/lib/issues/state-machine"
import { FULL_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import { getDb } from "./schema"
import { allocateIssueNumber } from "./issue-counters"
import { appendIssueEvent, deleteIssueEvents } from "./issue-events"
import { deleteIssueRuns } from "./issue-runs"

function newIssueId(): string {
  return `iss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Write the polymorphic assignee together with its two flat mirrors.
 * IndexedDB cannot index nested paths, so `assigneeKind` / `assigneeId` exist
 * purely to make "assigned to me" and per-agent filters indexable. Keeping the
 * three in one helper is what stops them drifting apart.
 */
function withAssignee(row: Issue, assignee: IssueActor | null): Issue {
  const next = { ...row }
  if (assignee === null) {
    delete next.assignee
    delete next.assigneeKind
    delete next.assigneeId
    return next
  }
  next.assignee = assignee
  next.assigneeKind = assignee.kind
  if (assignee.id === undefined) delete next.assigneeId
  else next.assigneeId = assignee.id
  return next
}

export interface CreateIssueInput {
  /** Owning workspace id. */
  projectId: string
  /** Owning delivery container. */
  issueProjectId: string
  title: string
  description?: string
  status?: IssueStatus
  priority?: IssuePriority
  assignee?: IssueActor
  createdBy: IssueActor
  labelIds?: string[]
  githubRef?: IssueGithubRef
}

/**
 * Create an issue. Number allocation, identifier formatting, the row write and
 * the `created` event all happen in one transaction — a crash mid-way must not
 * burn an identifier or leave an issue with no trail.
 */
export async function createIssue(input: CreateIssueInput): Promise<Issue> {
  const db = getDb()
  const title = input.title.trim()
  if (!title) throw new Error("Issue title is required")

  return db.transaction(
    "rw",
    db.issues,
    db.issueEvents,
    db.issueCounters,
    db.issueProjects,
    async () => {
      const project = await db.issueProjects.get(input.issueProjectId)
      if (!project) throw new Error(`Unknown issue project: ${input.issueProjectId}`)

      const status = input.status ?? "backlog"
      const number = await allocateIssueNumber(input.issueProjectId)
      const now = Date.now()

      const siblings = await db.issues
        .where("issueProjectId")
        .equals(input.issueProjectId)
        .filter((row) => row.status === status)
        .toArray()
      const order = siblings.reduce((max, row) => Math.max(max, row.order + 1), 0)

      let row: Issue = {
        id: newIssueId(),
        identifier: formatIssueIdentifier(project.key, number),
        number,
        projectId: input.projectId,
        issueProjectId: input.issueProjectId,
        title,
        ...(input.description ? { description: input.description } : {}),
        status,
        statusCategory: statusCategoryOf(status),
        priority: input.priority ?? "none",
        createdBy: input.createdBy,
        labelIds: input.labelIds ?? [],
        order,
        ...(input.githubRef ? { githubRef: input.githubRef } : {}),
        createdAt: now,
        updatedAt: now,
      }
      row = withAssignee(row, input.assignee ?? null)

      await db.issues.add(row)
      await appendIssueEvent({
        issueId: row.id,
        payload: { kind: "created", by: input.createdBy },
      })
      if (input.assignee) {
        await appendIssueEvent({
          issueId: row.id,
          payload: { kind: "assigned", to: input.assignee, by: input.createdBy },
        })
      }
      return row
    }
  )
}

export async function getIssue(id: string): Promise<Issue | undefined> {
  return getDb().issues.get(id)
}

export async function getIssueByIdentifier(identifier: string): Promise<Issue | undefined> {
  return getDb().issues.where("identifier").equals(identifier).first()
}

export interface ListIssuesQuery {
  /** Workspace scope. Omit only for export/settings paths. */
  projectId?: string
  issueProjectId?: string
  statuses?: readonly IssueStatus[]
  assigneeKind?: IssueActor["kind"]
  assigneeId?: string
}

export async function listIssues(query: ListIssuesQuery = {}): Promise<Issue[]> {
  const db = getDb()

  let rows: Issue[]
  if (query.issueProjectId !== undefined) {
    rows = await db.issues.where("issueProjectId").equals(query.issueProjectId).toArray()
  } else if (query.projectId !== undefined) {
    rows = await db.issues.where("projectId").equals(query.projectId).toArray()
  } else {
    rows = await db.issues.toArray()
  }

  return rows
    .filter((row) => {
      if (query.projectId !== undefined && row.projectId !== query.projectId) return false
      if (query.statuses?.length && !query.statuses.includes(row.status)) return false
      if (query.assigneeKind !== undefined && row.assigneeKind !== query.assigneeKind) return false
      if (query.assigneeId !== undefined && row.assigneeId !== query.assigneeId) return false
      return true
    })
    .sort((a, b) => a.order - b.order || b.updatedAt - a.updatedAt)
}

export interface MoveIssueInput {
  id: string
  to: IssueStatus
  by: IssueActor
  /** True while an `IssueRunAdapter` run is in flight for this issue. */
  runActive?: boolean
}

/**
 * Guarded status change. Returns `null` on success or a structured reason on
 * refusal — never throws for a policy denial, so the caller (drag handler, IM
 * callback, mobile action sheet) can localize the message without string
 * matching.
 */
export async function moveIssue(input: MoveIssueInput): Promise<IssueMoveError | null> {
  const db = getDb()
  return db.transaction("rw", db.issues, db.issueEvents, async () => {
    const existing = await db.issues.get(input.id)
    if (!existing) return "issue-not-found" as const

    const verdict = canMoveIssue(FULL_ISSUE_CAPABILITIES, existing.status, input.to, {
      runActive: input.runActive ?? false,
    })
    if (!verdict.allowed) return verdict.reason

    if (existing.status === input.to) return null

    const now = Date.now()
    const timestamps = statusTimestampPatch(input.to, now, existing)
    const next: Issue = {
      ...existing,
      status: input.to,
      statusCategory: statusCategoryOf(input.to),
      updatedAt: now,
    }
    for (const key of ["startedAt", "completedAt", "canceledAt"] as const) {
      const value = timestamps[key]
      if (value === undefined) delete next[key]
      else next[key] = value
    }

    await db.issues.put(next)
    await appendIssueEvent({
      issueId: existing.id,
      payload: { kind: "status_changed", from: existing.status, to: input.to, by: input.by },
    })
    return null
  })
}

/** Persist a manual reorder produced by `reorderIssueColumn`. */
export async function reorderIssues(
  changes: ReadonlyArray<{ sourceId: string; order: number }>
): Promise<void> {
  if (changes.length === 0) return
  const db = getDb()
  await db.transaction("rw", db.issues, async () => {
    for (const change of changes) {
      const row = await db.issues.get(change.sourceId)
      if (!row || row.order === change.order) continue
      await db.issues.put({ ...row, order: change.order })
    }
  })
}

export interface IssueUpdatePatch {
  title?: string
  description?: string
  priority?: IssuePriority
}

/** Field edits. Each changed field appends its own event. */
export async function updateIssue(
  id: string,
  patch: IssueUpdatePatch,
  by: IssueActor
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.issues, db.issueEvents, async () => {
    const existing = await db.issues.get(id)
    if (!existing) return

    const now = Date.now()
    const next: Issue = { ...existing, updatedAt: now }

    // Event ordering is the event module's job (`nextEventTs`): millisecond
    // wall-clock resolution is not enough to sequence several events from one
    // edit, so timestamps are never passed in from here.
    if (patch.title !== undefined) {
      const title = patch.title.trim()
      if (title && title !== existing.title) {
        next.title = title
        await appendIssueEvent({
          issueId: id,
          payload: { kind: "title_changed", from: existing.title, to: title, by },
        })
      }
    }
    if (patch.description !== undefined && patch.description !== existing.description) {
      next.description = patch.description
      await appendIssueEvent({
        issueId: id,
        payload: { kind: "description_changed", by },
      })
    }
    if (patch.priority !== undefined && patch.priority !== existing.priority) {
      next.priority = patch.priority
      await appendIssueEvent({
        issueId: id,
        payload: {
          kind: "priority_changed",
          from: existing.priority,
          to: patch.priority,
          by,
        },
      })
    }

    await db.issues.put(next)
  })
}

/** Assign, reassign or clear. Emits the matching event kind, like `setAssignee`. */
export async function setIssueAssignee(
  id: string,
  assignee: IssueActor | null,
  by: IssueActor
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.issues, db.issueEvents, async () => {
    const existing = await db.issues.get(id)
    if (!existing) return

    const now = Date.now()
    const previous = existing.assignee ?? null
    const next = withAssignee({ ...existing, updatedAt: now }, assignee)
    await db.issues.put(next)

    if (previous && assignee) {
      await appendIssueEvent({
        issueId: id,
        payload: { kind: "reassigned", from: previous, to: assignee, by },
      })
    } else if (assignee) {
      await appendIssueEvent({
        issueId: id,
        payload: { kind: "assigned", to: assignee, by },
      })
    } else if (previous) {
      await appendIssueEvent({
        issueId: id,
        payload: { kind: "unassigned", from: previous, by },
      })
    }
  })
}

export async function addIssueLabel(id: string, labelId: string, by: IssueActor): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.issues, db.issueEvents, async () => {
    const existing = await db.issues.get(id)
    if (!existing || existing.labelIds.includes(labelId)) return
    const now = Date.now()
    await db.issues.put({
      ...existing,
      labelIds: [...existing.labelIds, labelId],
      updatedAt: now,
    })
    await appendIssueEvent({
      issueId: id,
      payload: { kind: "label_added", labelId, by },
    })
  })
}

export async function removeIssueLabel(id: string, labelId: string, by: IssueActor): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.issues, db.issueEvents, async () => {
    const existing = await db.issues.get(id)
    if (!existing || !existing.labelIds.includes(labelId)) return
    const now = Date.now()
    await db.issues.put({
      ...existing,
      labelIds: existing.labelIds.filter((candidate) => candidate !== labelId),
      updatedAt: now,
    })
    await appendIssueEvent({
      issueId: id,
      payload: { kind: "label_removed", labelId, by },
    })
  })
}

/** Add a comment. Comments are `issueEvents` rows — see that module's header. */
export async function addIssueComment(id: string, body: string, by: IssueActor): Promise<void> {
  const text = body.trim()
  if (!text) return
  const db = getDb()
  await db.transaction("rw", db.issues, db.issueEvents, async () => {
    const existing = await db.issues.get(id)
    if (!existing) return
    const now = Date.now()
    await db.issues.put({ ...existing, updatedAt: now })
    await appendIssueEvent({
      issueId: id,
      payload: { kind: "commented", commentId: crypto.randomUUID(), body: text, by },
    })
  })
}

/**
 * Move an issue to a different delivery container. The identifier is NOT
 * reallocated — it is a stable printed reference that may already be in a
 * commit message, so `MERC-2` stays `MERC-2` even after moving to project
 * `COGN`. This mirrors how Linear and GitHub both treat transferred issues.
 */
export async function moveIssueToProject(
  id: string,
  issueProjectId: string,
  by: IssueActor
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.issues, db.issueEvents, db.issueProjects, async () => {
    const existing = await db.issues.get(id)
    if (!existing || existing.issueProjectId === issueProjectId) return
    const target = await db.issueProjects.get(issueProjectId)
    if (!target) throw new Error(`Unknown issue project: ${issueProjectId}`)

    const now = Date.now()
    await db.issues.put({ ...existing, issueProjectId, updatedAt: now })
    await appendIssueEvent({
      issueId: id,
      payload: {
        kind: "project_changed",
        from: existing.issueProjectId,
        to: issueProjectId,
        by,
      },
    })
  })
}

export async function linkIssueToGithub(
  id: string,
  ref: IssueGithubRef,
  by: IssueActor
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.issues, db.issueEvents, async () => {
    const existing = await db.issues.get(id)
    if (!existing) return
    const now = Date.now()
    await db.issues.put({ ...existing, githubRef: ref, updatedAt: now })
    await appendIssueEvent({
      issueId: id,
      payload: { kind: "github_linked", ref, by },
    })
  })
}

/**
 * Hard delete. Issues have no soft-delete tier: unlike memories (which the
 * retrieval layer must keep excluding) a deleted issue has no downstream
 * consumer, and `canceled` already covers "kept for the record".
 */
export async function deleteIssue(id: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.issues, db.issueEvents, db.issueRuns, async () => {
    await deleteIssueEvents(id)
    await deleteIssueRuns(id)
    await db.issues.delete(id)
  })
}

/**
 * Runtime-owned status write, used ONLY by `lib/issues/run/` adapters.
 *
 * `moveIssue` applies the human guard, which (correctly) refuses to move an
 * issue into or out of `in_progress` while a run is active — that is the
 * runtime's column. This is the runtime's own door: it may enter
 * `in_progress` when a run starts, leave to `in_review` when the run
 * finishes, or hand the issue back to `todo` when the run is cancelled before
 * producing anything — and NOTHING else. `done` is never reachable from here;
 * promoting a reviewed issue is the human's call (`lib/issues/state-machine.ts`).
 */
export async function applyRuntimeIssueStatus(
  id: string,
  to: Extract<IssueStatus, "in_progress" | "in_review" | "todo">,
  by: IssueActor
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.issues, db.issueEvents, async () => {
    const existing = await db.issues.get(id)
    if (!existing || existing.status === to) return
    // A finished/cancelled issue is not dragged back into the pipeline by a
    // late engine callback.
    if (existing.statusCategory === "completed" || existing.statusCategory === "canceled") return
    // The cancel hand-back only relinquishes the runtime's own column; it never
    // demotes an issue a human has already moved elsewhere.
    if (to === "todo" && existing.status !== "in_progress") return
    const now = Date.now()
    const timestamps = statusTimestampPatch(to, now, existing)
    const next: Issue = {
      ...existing,
      status: to,
      statusCategory: statusCategoryOf(to),
      updatedAt: now,
    }
    for (const key of ["startedAt", "completedAt", "canceledAt"] as const) {
      const value = timestamps[key]
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    await db.issues.put(next)
    await appendIssueEvent({
      issueId: existing.id,
      payload: { kind: "status_changed", from: existing.status, to, by },
    })
  })
}

/** Count by status for a workspace — feeds the workspace overview summary. */
export async function countIssuesByStatus(projectId: string): Promise<Record<IssueStatus, number>> {
  const rows = await getDb().issues.where("projectId").equals(projectId).toArray()
  const counts = {
    backlog: 0,
    todo: 0,
    in_progress: 0,
    in_review: 0,
    done: 0,
    canceled: 0,
  } satisfies Record<IssueStatus, number>
  for (const row of rows) counts[row.status] += 1
  return counts
}
