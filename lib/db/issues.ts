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

import type {
  Issue,
  IssueActor,
  IssueExternalRef,
  IssueGithubRef,
  IssueOrigin,
  IssuePriority,
  IssueStatus,
} from "@/types/issues"
import { externalKeyOf, statusCategoryOf } from "@/types/issues"
import { formatIssueIdentifier } from "@/lib/issues/identifier"
import { canMoveIssue, statusTimestampPatch, type IssueMoveError } from "@/lib/issues/state-machine"
import { FULL_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import { getDb } from "./schema"
import { allocateIssueNumber } from "./issue-counters"
import { appendIssueEvent, deleteIssueEvents } from "./issue-events"
import { deleteIssueRuns } from "./issue-runs"
import { recordTombstones } from "@/lib/sync/tombstones"

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
  /** Where the issue was filed from (IM); omitted for board-created issues. */
  origin?: IssueOrigin
  parentId?: string
  blockedBy?: string[]
  dueDate?: number
  estimate?: number
  cycleId?: string
  /** Links into other systems, e.g. the row this issue was imported from. */
  externalRefs?: IssueExternalRef[]
}

/** The GitHub link as an `externalRefs` entry, so one lookup finds every provider. */
export function githubExternalRef(ref: IssueGithubRef): IssueExternalRef {
  return {
    provider: "github",
    externalId: `${ref.repoFullName}#${ref.number}`,
    url: ref.htmlUrl,
    label: `${ref.repoFullName}#${ref.number}`,
  }
}

/**
 * Write `externalRefs` together with its indexed mirror. One entry per
 * `provider:externalId`; a later entry for the same key replaces the earlier
 * one, so re-linking refreshes `syncedAt` instead of duplicating the link.
 */
function withExternalRefs(row: Issue, refs: readonly IssueExternalRef[]): Issue {
  const byKey = new Map<string, IssueExternalRef>()
  for (const ref of refs) byKey.set(externalKeyOf(ref), ref)
  const externalRefs = [...byKey.values()]
  return { ...row, externalRefs, externalKeys: externalRefs.map(externalKeyOf) }
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
      // The workspace and the container arrive as two independent inputs, so
      // nothing but this check stops them disagreeing. A row whose `projectId`
      // is not the container's workspace is invisible on both boards: the
      // console lists by workspace and the rail filters by container, and no
      // single workspace satisfies both. Agent tools take the container id
      // straight from a model, which is exactly how a stale id gets here.
      if (project.projectId !== input.projectId) {
        throw new Error(
          `Issue project ${input.issueProjectId} belongs to workspace ${project.projectId}, not ${input.projectId}`
        )
      }

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
        ...(input.origin ? { origin: input.origin } : {}),
        ...(input.parentId ? { parentId: input.parentId } : {}),
        blockedBy: [...new Set(input.blockedBy ?? [])],
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
        ...(input.estimate !== undefined ? { estimate: input.estimate } : {}),
        ...(input.cycleId ? { cycleId: input.cycleId } : {}),
        externalRefs: [],
        externalKeys: [],
        createdAt: now,
        updatedAt: now,
      }
      row = withAssignee(row, input.assignee ?? null)
      row = withExternalRefs(row, [
        ...(input.githubRef ? [githubExternalRef(input.githubRef)] : []),
        ...(input.externalRefs ?? []),
      ])
      if (row.parentId === row.id) delete row.parentId

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
  parentId?: string
  cycleId?: string
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
  if (query.parentId !== undefined) {
    rows = await db.issues.where("parentId").equals(query.parentId).toArray()
  } else if (query.cycleId !== undefined) {
    rows = await db.issues.where("cycleId").equals(query.cycleId).toArray()
  } else if (query.issueProjectId !== undefined) {
    rows = await db.issues.where("issueProjectId").equals(query.issueProjectId).toArray()
  } else if (query.projectId !== undefined) {
    rows = await db.issues.where("projectId").equals(query.projectId).toArray()
  } else {
    rows = await db.issues.toArray()
  }

  return rows
    .filter((row) => {
      if (query.projectId !== undefined && row.projectId !== query.projectId) return false
      if (query.issueProjectId !== undefined && row.issueProjectId !== query.issueProjectId) {
        return false
      }
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
    // Same invariant as `createIssue`, and the only place a move could break
    // it. Re-homing the issue into the target's workspace instead would drag
    // its identifier, its trail and its runs across a boundary the rest of the
    // app treats as absolute, so the move is refused rather than repaired.
    if (target.projectId !== existing.projectId) {
      throw new Error(
        `Issue project ${issueProjectId} belongs to workspace ${target.projectId}, not ${existing.projectId}`
      )
    }

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
    const previous = existing.githubRef
      ? [githubExternalRef(existing.githubRef)].map(externalKeyOf)
      : []
    const kept = (existing.externalRefs ?? []).filter(
      (candidate) => !previous.includes(externalKeyOf(candidate))
    )
    await db.issues.put(
      withExternalRefs({ ...existing, githubRef: ref, updatedAt: now }, [
        ...kept,
        githubExternalRef(ref),
      ])
    )
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
  await db.transaction(
    "rw",
    db.issues,
    db.issueEvents,
    db.issueRuns,
    db.syncTombstones,
    async () => {
      const eventIds = await deleteIssueEvents(id)
      const runIds = await deleteIssueRuns(id)
      const now = Date.now()
      // Relations point at the row by id. Children become top-level and the
      // issues this one blocked lose the blocker, silently: the deletion is
      // the event, and it is recorded on the row that no longer exists.
      await db.issues
        .where("parentId")
        .equals(id)
        .modify((row) => {
          delete row.parentId
          row.updatedAt = now
        })
      await db.issues
        .where("blockedBy")
        .equals(id)
        .modify((row) => {
          row.blockedBy = (row.blockedBy ?? []).filter((candidate) => candidate !== id)
          row.updatedAt = now
        })
      await db.issues.delete(id)
      // All three tables are companion-synced, and a pull only ever carries
      // rows that still exist, so without these the board on a paired phone
      // keeps an issue the host deleted, and its trail and runs outlive even
      // that as rows pointing at nothing.
      const at = now
      await recordTombstones("issues", [id], at)
      await recordTombstones("issueEvents", eventIds, at)
      await recordTombstones("issueRuns", runIds, at)
    }
  )
}

/**
 * Set or clear the parent. Refuses a cycle: an issue may not become its own
 * ancestor, because every "sub-issue progress" read walks the tree and an
 * ancestor loop would never terminate. Cross-workspace parents are refused
 * for the same reason `moveIssueToProject` refuses a cross-workspace target.
 */
export async function setIssueParent(
  id: string,
  parentId: string | null,
  by: IssueActor
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.issues, db.issueEvents, async () => {
    const existing = await db.issues.get(id)
    if (!existing) return
    const from = existing.parentId
    if ((parentId ?? undefined) === from) return
    if (parentId !== null) {
      if (parentId === id) throw new Error("An issue cannot be its own parent")
      const parent = await db.issues.get(parentId)
      if (!parent) throw new Error(`Unknown issue: ${parentId}`)
      if (parent.projectId !== existing.projectId) {
        throw new Error("Parent must be in the same workspace")
      }
      let cursor: Issue | undefined = parent
      const seen = new Set<string>([id])
      while (cursor?.parentId) {
        if (seen.has(cursor.parentId)) {
          throw new Error("An issue cannot be its own ancestor")
        }
        seen.add(cursor.parentId)
        cursor = await db.issues.get(cursor.parentId)
      }
    }
    const now = Date.now()
    const next: Issue = { ...existing, updatedAt: now }
    if (parentId === null) delete next.parentId
    else next.parentId = parentId
    await db.issues.put(next)
    await appendIssueEvent({
      issueId: id,
      payload: {
        kind: "parent_changed",
        ...(from ? { from } : {}),
        ...(parentId ? { to: parentId } : {}),
        by,
      },
    })
  })
}

export async function addIssueBlocker(
  id: string,
  blockerId: string,
  by: IssueActor
): Promise<void> {
  if (id === blockerId) throw new Error("An issue cannot block itself")
  const db = getDb()
  await db.transaction("rw", db.issues, db.issueEvents, async () => {
    const existing = await db.issues.get(id)
    if (!existing) return
    const current = existing.blockedBy ?? []
    if (current.includes(blockerId)) return
    const blocker = await db.issues.get(blockerId)
    if (!blocker) throw new Error(`Unknown issue: ${blockerId}`)
    if (blocker.projectId !== existing.projectId) {
      throw new Error("Blocker must be in the same workspace")
    }
    await db.issues.put({ ...existing, blockedBy: [...current, blockerId], updatedAt: Date.now() })
    await appendIssueEvent({ issueId: id, payload: { kind: "blocker_added", blockerId, by } })
  })
}

export async function removeIssueBlocker(
  id: string,
  blockerId: string,
  by: IssueActor
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.issues, db.issueEvents, async () => {
    const existing = await db.issues.get(id)
    const current = existing?.blockedBy ?? []
    if (!existing || !current.includes(blockerId)) return
    await db.issues.put({
      ...existing,
      blockedBy: current.filter((candidate) => candidate !== blockerId),
      updatedAt: Date.now(),
    })
    await appendIssueEvent({ issueId: id, payload: { kind: "blocker_removed", blockerId, by } })
  })
}

/** Set or clear the due date (epoch ms; callers pass a date, not a time). */
export async function setIssueDueDate(
  id: string,
  dueDate: number | null,
  by: IssueActor
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.issues, db.issueEvents, async () => {
    const existing = await db.issues.get(id)
    if (!existing) return
    const from = existing.dueDate
    if ((dueDate ?? undefined) === from) return
    const next: Issue = { ...existing, updatedAt: Date.now() }
    if (dueDate === null) delete next.dueDate
    else next.dueDate = dueDate
    await db.issues.put(next)
    await appendIssueEvent({
      issueId: id,
      payload: {
        kind: "due_date_changed",
        ...(from !== undefined ? { from } : {}),
        ...(dueDate !== null ? { to: dueDate } : {}),
        by,
      },
    })
  })
}

/** Set or clear the estimate. Negative values are refused, zero is legal. */
export async function setIssueEstimate(
  id: string,
  estimate: number | null,
  by: IssueActor
): Promise<void> {
  if (estimate !== null && (!Number.isFinite(estimate) || estimate < 0)) {
    throw new Error("Estimate must be a non-negative number")
  }
  const db = getDb()
  await db.transaction("rw", db.issues, db.issueEvents, async () => {
    const existing = await db.issues.get(id)
    if (!existing) return
    const from = existing.estimate
    if ((estimate ?? undefined) === from) return
    const next: Issue = { ...existing, updatedAt: Date.now() }
    if (estimate === null) delete next.estimate
    else next.estimate = estimate
    await db.issues.put(next)
    await appendIssueEvent({
      issueId: id,
      payload: {
        kind: "estimate_changed",
        ...(from !== undefined ? { from } : {}),
        ...(estimate !== null ? { to: estimate } : {}),
        by,
      },
    })
  })
}

/** Plan into a cycle, or take out of one. A cycle of another workspace is refused. */
export async function setIssueCycle(
  id: string,
  cycleId: string | null,
  by: IssueActor
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.issues, db.issueEvents, db.issueCycles, async () => {
    const existing = await db.issues.get(id)
    if (!existing) return
    const from = existing.cycleId
    if ((cycleId ?? undefined) === from) return
    if (cycleId !== null) {
      const cycle = await db.issueCycles.get(cycleId)
      if (!cycle) throw new Error(`Unknown cycle: ${cycleId}`)
      if (cycle.projectId !== existing.projectId) {
        throw new Error("Cycle must be in the same workspace")
      }
    }
    const next: Issue = { ...existing, updatedAt: Date.now() }
    if (cycleId === null) delete next.cycleId
    else next.cycleId = cycleId
    await db.issues.put(next)
    await appendIssueEvent({
      issueId: id,
      payload: {
        kind: "cycle_changed",
        ...(from ? { from } : {}),
        ...(cycleId ? { to: cycleId } : {}),
        by,
      },
    })
  })
}

/**
 * Attach an external reference. Re-linking the same `provider:externalId`
 * replaces the entry (refreshing `syncedAt`) and appends no event, so a sync
 * pass that touches a hundred issues does not write a hundred "linked" rows.
 */
export async function linkIssueExternal(
  id: string,
  ref: IssueExternalRef,
  by: IssueActor
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.issues, db.issueEvents, async () => {
    const existing = await db.issues.get(id)
    if (!existing) return
    const key = externalKeyOf(ref)
    const already = (existing.externalKeys ?? []).includes(key)
    await db.issues.put(
      withExternalRefs({ ...existing, updatedAt: Date.now() }, [
        ...(existing.externalRefs ?? []),
        ref,
      ])
    )
    if (!already) {
      await appendIssueEvent({ issueId: id, payload: { kind: "external_linked", ref, by } })
    }
  })
}

export async function unlinkIssueExternal(
  id: string,
  ref: Pick<IssueExternalRef, "provider" | "externalId">,
  by: IssueActor
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.issues, db.issueEvents, async () => {
    const existing = await db.issues.get(id)
    if (!existing) return
    const key = externalKeyOf(ref)
    const removed = (existing.externalRefs ?? []).find(
      (candidate) => externalKeyOf(candidate) === key
    )
    if (!removed) return
    const next = withExternalRefs(
      { ...existing, updatedAt: Date.now() },
      (existing.externalRefs ?? []).filter((candidate) => externalKeyOf(candidate) !== key)
    )
    // `githubRef` is the denormalised GitHub entry; dropping the ref drops it.
    if (removed.provider === "github") delete next.githubRef
    await db.issues.put(next)
    await appendIssueEvent({
      issueId: id,
      payload: { kind: "external_unlinked", ref: removed, by },
    })
  })
}

/** Update the sync bookkeeping on one ref without an event or an `updatedAt` bump. */
export async function touchIssueExternalRef(
  id: string,
  ref: Pick<IssueExternalRef, "provider" | "externalId">,
  patch: Pick<IssueExternalRef, "syncedAt" | "remoteUpdatedAt" | "meta">
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.issues, async () => {
    const existing = await db.issues.get(id)
    if (!existing) return
    const key = externalKeyOf(ref)
    const refs = (existing.externalRefs ?? []).map((candidate) =>
      externalKeyOf(candidate) === key ? { ...candidate, ...patch } : candidate
    )
    await db.issues.put(withExternalRefs(existing, refs))
  })
}

/** The local issue linked to `provider:externalId`, if any. */
export async function getIssueByExternalKey(
  provider: string,
  externalId: string
): Promise<Issue | undefined> {
  return getDb()
    .issues.where("externalKeys")
    .equals(externalKeyOf({ provider, externalId }))
    .first()
}

/** Every local issue carrying a ref from `provider`, keyed by `externalId`. */
export async function mapIssuesByExternalProvider(
  provider: string,
  projectId?: string
): Promise<Map<string, Issue>> {
  const db = getDb()
  const rows = await db.issues.where("externalKeys").startsWith(`${provider}:`).distinct().toArray()
  const out = new Map<string, Issue>()
  for (const row of rows) {
    if (projectId !== undefined && row.projectId !== projectId) continue
    for (const ref of row.externalRefs ?? []) {
      if (ref.provider === provider) out.set(ref.externalId, row)
    }
  }
  return out
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
