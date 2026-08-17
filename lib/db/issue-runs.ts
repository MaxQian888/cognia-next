/**
 * Issue runs — Dexie table `issueRuns` (schema v172, ADR-0130).
 *
 * One row per dispatch of a local issue to an execution engine — an AgentTask,
 * an AgentTeam run, or the GitHub issue loop. The ISSUE side owns this
 * binding: engines are never widened with an `issueId` column, so binding a
 * new engine is one adapter in `lib/issues/run/` and zero schema bumps on the
 * engine's tables.
 *
 * Written by `lib/issues/run/` adapters (`createIssueRun`) and settled by the
 * same adapters when the engine reports a terminal state (`settleIssueRun`).
 * The row is what feeds:
 *   - the "N agents working" pills (`listActiveIssueRunIssueIds`),
 *   - the runtime-owned guard in `lib/issues/state-machine.ts` (`hasActiveIssueRun`),
 *   - the agent-task / agent-team federated sources' "from KEY-1" badge
 *     (`getIssueRunByTarget`),
 *   - the issue detail panel's run history (`listIssueRuns`).
 *
 * Mechanical module — no gating, no i18n. Every terminal transition also
 * appends the matching `run_*` / `artifact_linked` events to the issue's
 * activity trail in the same transaction, so the timeline can never disagree
 * with the row. Cascade-delete is the CRUD layer's job (`deleteIssueRuns`),
 * never a Dexie hook.
 */

import type {
  IssueActor,
  IssueRun,
  IssueRunArtifact,
  IssueRunKind,
  IssueRunStatus,
} from "@/types/issues"
import { isActiveIssueRunStatus } from "@/types/issues"
import { getDb } from "./schema"
import { appendIssueEvent } from "./issue-events"

function newIssueRunId(): string {
  return `irun_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export interface CreateIssueRunInput {
  issueId: string
  /** Owning workspace id, mirrored from the issue. */
  projectId: string
  adapterId: string
  kind: IssueRunKind
  targetId: string
  targetRef?: Record<string, string>
  by: IssueActor
  /** Defaults to `running`; pass `queued` when the engine has not picked it up yet. */
  status?: Extract<IssueRunStatus, "queued" | "running">
  /** Test injection. */
  now?: number
}

/**
 * Record a dispatch and append `run_started` to the issue's trail in one
 * transaction. The engine-side work item must already exist — `targetId` is
 * required — so a crash between "engine accepted" and "row written" leaves an
 * orphan engine item rather than a run row pointing at nothing.
 */
export async function createIssueRun(input: CreateIssueRunInput): Promise<IssueRun> {
  const db = getDb()
  const now = input.now ?? Date.now()
  const row: IssueRun = {
    id: newIssueRunId(),
    issueId: input.issueId,
    projectId: input.projectId,
    adapterId: input.adapterId,
    kind: input.kind,
    targetId: input.targetId,
    ...(input.targetRef ? { targetRef: input.targetRef } : {}),
    status: input.status ?? "running",
    by: input.by,
    startedAt: now,
    updatedAt: now,
    artifacts: [],
  }
  await db.transaction("rw", db.issueRuns, db.issueEvents, async () => {
    await db.issueRuns.add(row)
    await appendIssueEvent({
      issueId: input.issueId,
      payload: { kind: "run_started", runId: row.id, adapterId: input.adapterId, by: input.by },
    })
  })
  return row
}

export async function getIssueRun(id: string): Promise<IssueRun | undefined> {
  return getDb().issueRuns.get(id)
}

export interface ListIssueRunsQuery {
  issueId?: string
  projectId?: string
  status?: IssueRunStatus
  /** Only `queued` / `running` rows. Ignored when `status` is given. */
  activeOnly?: boolean
}

/** Newest first. At least one of `issueId` / `projectId` should be given. */
export async function listIssueRuns(query: ListIssueRunsQuery = {}): Promise<IssueRun[]> {
  const db = getDb()
  let rows: IssueRun[]
  if (query.issueId !== undefined && query.status !== undefined) {
    rows = await db.issueRuns
      .where("[issueId+status]")
      .equals([query.issueId, query.status])
      .toArray()
  } else if (query.issueId !== undefined) {
    rows = await db.issueRuns.where("issueId").equals(query.issueId).toArray()
  } else if (query.projectId !== undefined && query.status !== undefined) {
    rows = await db.issueRuns
      .where("[projectId+status]")
      .equals([query.projectId, query.status])
      .toArray()
  } else if (query.projectId !== undefined) {
    rows = await db.issueRuns.where("projectId").equals(query.projectId).toArray()
  } else if (query.status !== undefined) {
    rows = await db.issueRuns.where("status").equals(query.status).toArray()
  } else {
    rows = await db.issueRuns.toArray()
  }
  if (query.status === undefined && query.activeOnly) {
    rows = rows.filter((row) => isActiveIssueRunStatus(row.status))
  }
  return rows.sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? -1 : 1))
}

/** True while any `queued` / `running` run exists for the issue. */
export async function hasActiveIssueRun(issueId: string): Promise<boolean> {
  const db = getDb()
  const queued = await db.issueRuns.where("[issueId+status]").equals([issueId, "queued"]).count()
  if (queued > 0) return true
  const running = await db.issueRuns.where("[issueId+status]").equals([issueId, "running"]).count()
  return running > 0
}

/**
 * Ids of every issue in the workspace with an active run. Feeds
 * `issueRunHint` on the board and the workspace overview tile.
 */
export async function listActiveIssueRunIssueIds(projectId: string): Promise<Set<string>> {
  const db = getDb()
  const rows = await db.issueRuns
    .where("[projectId+status]")
    .anyOf([
      [projectId, "queued"],
      [projectId, "running"],
    ])
    .toArray()
  return new Set(rows.map((row) => row.issueId))
}

/**
 * The most recent run whose engine-native id is `targetId`. Lets a federated
 * source badge an engine row with the issue it was dispatched from.
 */
export async function getIssueRunByTarget(
  kind: IssueRunKind,
  targetId: string
): Promise<IssueRun | undefined> {
  const rows = await getDb().issueRuns.where("targetId").equals(targetId).toArray()
  const matching = rows.filter((row) => row.kind === kind)
  if (matching.length === 0) return undefined
  return matching.sort((a, b) => b.startedAt - a.startedAt)[0]
}

/**
 * Index of `targetId → run` for every run of `kind` in the workspace, so a
 * federated source can annotate a whole board in one query.
 */
export async function mapIssueRunsByTarget(
  projectId: string,
  kind: IssueRunKind
): Promise<Map<string, IssueRun>> {
  const rows = await getDb().issueRuns.where("projectId").equals(projectId).toArray()
  const map = new Map<string, IssueRun>()
  for (const row of rows.filter((candidate) => candidate.kind === kind)) {
    const previous = map.get(row.targetId)
    if (!previous || row.startedAt > previous.startedAt) map.set(row.targetId, row)
  }
  return map
}

/** Mark a `queued` run as picked up by the engine. No-op for any other state. */
export async function markIssueRunRunning(id: string, now = Date.now()): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.issueRuns, async () => {
    const existing = await db.issueRuns.get(id)
    if (!existing || existing.status !== "queued") return
    await db.issueRuns.put({ ...existing, status: "running", updatedAt: now })
  })
}

/**
 * Attach an artifact (PR, branch, worktree, session) to a run and append
 * `artifact_linked` to the issue's trail. Idempotent per `href`.
 */
export async function linkIssueRunArtifact(
  id: string,
  artifact: IssueRunArtifact,
  now = Date.now()
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.issueRuns, db.issueEvents, async () => {
    const existing = await db.issueRuns.get(id)
    if (!existing) return
    if (existing.artifacts.some((candidate) => candidate.href === artifact.href)) return
    await db.issueRuns.put({
      ...existing,
      artifacts: [...existing.artifacts, artifact],
      updatedAt: now,
    })
    await appendIssueEvent({
      issueId: existing.issueId,
      payload: { kind: "artifact_linked", label: artifact.label, href: artifact.href, runId: id },
    })
  })
}

export type SettleIssueRunInput =
  | { status: "succeeded"; summary?: string; artifacts?: IssueRunArtifact[] }
  | { status: "failed"; error: string; artifacts?: IssueRunArtifact[] }
  | { status: "cancelled"; error?: string }

/**
 * Move a run to a terminal state and append the matching trail event. Returns
 * the settled row, or `undefined` when the run does not exist or was already
 * terminal (settling is one-shot; the first terminal write wins).
 */
export async function settleIssueRun(
  id: string,
  input: SettleIssueRunInput,
  now = Date.now()
): Promise<IssueRun | undefined> {
  const db = getDb()
  return db.transaction("rw", db.issueRuns, db.issueEvents, async () => {
    const existing = await db.issueRuns.get(id)
    if (!existing || !isActiveIssueRunStatus(existing.status)) return undefined

    const extraArtifacts = "artifacts" in input ? (input.artifacts ?? []) : []
    const artifacts = [...existing.artifacts]
    for (const artifact of extraArtifacts) {
      if (artifacts.some((candidate) => candidate.href === artifact.href)) continue
      artifacts.push(artifact)
      await appendIssueEvent({
        issueId: existing.issueId,
        payload: { kind: "artifact_linked", label: artifact.label, href: artifact.href, runId: id },
      })
    }

    const next: IssueRun = {
      ...existing,
      status: input.status,
      updatedAt: now,
      endedAt: now,
      artifacts,
    }
    delete next.summary
    delete next.error
    if (input.status === "succeeded") {
      if (input.summary) next.summary = input.summary
      await appendIssueEvent({
        issueId: existing.issueId,
        payload: {
          kind: "run_succeeded",
          runId: id,
          adapterId: existing.adapterId,
          ...(input.summary ? { summary: input.summary } : {}),
        },
      })
    } else {
      const error = input.error ?? "cancelled"
      next.error = error
      await appendIssueEvent({
        issueId: existing.issueId,
        payload: { kind: "run_failed", runId: id, adapterId: existing.adapterId, error },
      })
    }
    await db.issueRuns.put(next)
    return next
  })
}

/** Cascade target for `deleteIssue`. */
export async function deleteIssueRuns(issueId: string): Promise<void> {
  await getDb().issueRuns.where("issueId").equals(issueId).delete()
}

/** Cascade target for deleting a whole issue-project. */
export async function deleteIssueRunsForIssues(issueIds: readonly string[]): Promise<void> {
  if (issueIds.length === 0) return
  await getDb()
    .issueRuns.where("issueId")
    .anyOf([...issueIds])
    .delete()
}
