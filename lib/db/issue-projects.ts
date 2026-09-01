/**
 * Issue-project (delivery container) CRUD — Dexie table `issueProjects` (v170).
 *
 * NAMING: `IssueProject.projectId` is the owning WORKSPACE (the repo-wide
 * isolation column). `IssueProject.id` is what issues reference through
 * `Issue.issueProjectId`. See the invariant block in `types/issues/index.ts`.
 *
 * Mechanical module — no gating, no LLM. Structure follows `lib/db/memories.ts`
 * (module doc → id helper → `*Input`/`*Patch`/`*Query` next to the function
 * that consumes them → flat async functions, all via `getDb()`).
 *
 * Resources are reference-only: a `workspace-root` resource points at a
 * `WorkspaceRoot.id` already mounted on the owning workspace. This module
 * never mounts anything — doing so would create a second directory source of
 * truth and bypass `lib/workspace/trust-gate.ts`.
 */

import type {
  IssueProject,
  IssueProjectResource,
  IssueProjectStatus,
  IssuePriority,
  IssueActor,
} from "@/types/issues"
import { deriveProjectKey, isValidProjectKey } from "@/lib/issues/identifier"
import { getDb } from "./schema"
import { deleteIssueCounter } from "./issue-counters"
import { deleteIssueEventsForIssues } from "./issue-events"
import { deleteIssueRunsForIssues } from "./issue-runs"
import { recordTombstones } from "@/lib/sync/tombstones"

function newIssueProjectId(): string {
  return `iprj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export interface CreateIssueProjectInput {
  /** Owning workspace id. */
  projectId: string
  name: string
  /** Explicit key; derived from `name` when omitted. Always uppercased. */
  key?: string
  description?: string
  status?: IssueProjectStatus
  priority?: IssuePriority
  lead?: IssueActor
  startDate?: number
  targetDate?: number
  resources?: IssueProjectResource[]
  icon?: string
}

/** Every key currently in use. Keys are globally unique, not per-workspace. */
export async function listTakenProjectKeys(): Promise<Set<string>> {
  const rows = await getDb().issueProjects.toArray()
  return new Set(rows.map((row) => row.key))
}

export async function createIssueProject(input: CreateIssueProjectInput): Promise<IssueProject> {
  const db = getDb()
  const name = input.name.trim()
  if (!name) throw new Error("Project name is required")

  const taken = await listTakenProjectKeys()
  let key: string
  if (input.key) {
    key = input.key.trim().toUpperCase()
    if (!isValidProjectKey(key)) {
      throw new Error(`Invalid project key "${key}" — 2–5 characters, starting with a letter`)
    }
    if (taken.has(key)) throw new Error(`Project key "${key}" is already in use`)
  } else {
    key = deriveProjectKey(name, taken)
  }

  const now = Date.now()
  const row: IssueProject = {
    id: newIssueProjectId(),
    projectId: input.projectId,
    key,
    name,
    ...(input.description ? { description: input.description } : {}),
    status: input.status ?? "backlog",
    priority: input.priority ?? "none",
    ...(input.lead ? { lead: input.lead } : {}),
    ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
    ...(input.targetDate !== undefined ? { targetDate: input.targetDate } : {}),
    resources: input.resources ?? [],
    ...(input.icon ? { icon: input.icon } : {}),
    createdAt: now,
    updatedAt: now,
  }
  await db.issueProjects.add(row)
  return row
}

export async function getIssueProject(id: string): Promise<IssueProject | undefined> {
  return getDb().issueProjects.get(id)
}

export async function getIssueProjectByKey(key: string): Promise<IssueProject | undefined> {
  return getDb().issueProjects.where("key").equals(key.toUpperCase()).first()
}

export interface ListIssueProjectsQuery {
  /** Workspace scope. Omit to list across every workspace (settings/export). */
  projectId?: string
  statuses?: readonly IssueProjectStatus[]
}

export async function listIssueProjects(
  query: ListIssueProjectsQuery = {}
): Promise<IssueProject[]> {
  const db = getDb()
  const rows =
    query.projectId === undefined
      ? await db.issueProjects.toArray()
      : await db.issueProjects.where("projectId").equals(query.projectId).toArray()

  const filtered = query.statuses?.length
    ? rows.filter((row) => query.statuses!.includes(row.status))
    : rows
  return filtered.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
}

export interface IssueProjectUpdatePatch {
  name?: string
  description?: string
  status?: IssueProjectStatus
  priority?: IssuePriority
  lead?: IssueActor | null
  startDate?: number | null
  targetDate?: number | null
  icon?: string
}

/**
 * Patch a project. `key` is deliberately absent — it is immutable, because
 * changing it would orphan every identifier already printed into commits,
 * chat messages and PR bodies.
 */
export async function updateIssueProject(
  id: string,
  patch: IssueProjectUpdatePatch
): Promise<void> {
  const db = getDb()
  const existing = await db.issueProjects.get(id)
  if (!existing) return

  const next: IssueProject = { ...existing, updatedAt: Date.now() }
  if (patch.name !== undefined) next.name = patch.name.trim()
  if (patch.description !== undefined) next.description = patch.description
  if (patch.status !== undefined) next.status = patch.status
  if (patch.priority !== undefined) next.priority = patch.priority
  if (patch.icon !== undefined) next.icon = patch.icon
  if (patch.lead !== undefined) {
    if (patch.lead === null) delete next.lead
    else next.lead = patch.lead
  }
  if (patch.startDate !== undefined) {
    if (patch.startDate === null) delete next.startDate
    else next.startDate = patch.startDate
  }
  if (patch.targetDate !== undefined) {
    if (patch.targetDate === null) delete next.targetDate
    else next.targetDate = patch.targetDate
  }

  await db.issueProjects.put(next)
}

/** Add a resource reference. Idempotent — re-adding the same target no-ops. */
export async function addIssueProjectResource(
  id: string,
  resource: IssueProjectResource
): Promise<void> {
  const db = getDb()
  const existing = await db.issueProjects.get(id)
  if (!existing) return
  if (existing.resources.some((candidate) => sameResource(candidate, resource))) return
  await db.issueProjects.put({
    ...existing,
    resources: [...existing.resources, resource],
    updatedAt: Date.now(),
  })
}

export async function removeIssueProjectResource(
  id: string,
  resource: IssueProjectResource
): Promise<void> {
  const db = getDb()
  const existing = await db.issueProjects.get(id)
  if (!existing) return
  await db.issueProjects.put({
    ...existing,
    resources: existing.resources.filter((candidate) => !sameResource(candidate, resource)),
    updatedAt: Date.now(),
  })
}

function sameResource(a: IssueProjectResource, b: IssueProjectResource): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === "github-repo" && b.kind === "github-repo") {
    return a.repoFullName === b.repoFullName
  }
  if (a.kind === "workspace-root" && b.kind === "workspace-root") {
    return a.rootId === b.rootId
  }
  return false
}

/**
 * Delete a project and everything under it: its issues, their events, their
 * runs, and its identifier counter. One transaction, so a crash can't strand orphans.
 *
 * The counter goes too — the project's key is released back to the pool, and
 * a future project reusing that key starts numbering from 1 again.
 */
export async function deleteIssueProject(id: string): Promise<void> {
  const db = getDb()
  // Table array rather than positional args: Dexie's `transaction` overloads
  // stop at five tables, and the tombstone store is the sixth.
  await db.transaction(
    "rw",
    [
      db.issueProjects,
      db.issues,
      db.issueEvents,
      db.issueRuns,
      db.issueCounters,
      db.syncTombstones,
    ],
    async () => {
      const issues = await db.issues.where("issueProjectId").equals(id).toArray()
      const issueIds = issues.map((issue) => issue.id)
      const eventIds = await deleteIssueEventsForIssues(issueIds)
      const runIds = await deleteIssueRunsForIssues(issueIds)
      await db.issues.bulkDelete(issueIds)
      await deleteIssueCounter(id)
      await db.issueProjects.delete(id)
      // Every table this cascade touches is companion-synced, so each level
      // needs its own tombstone. Recording only the container would leave a
      // paired phone rendering its issues under something it no longer has,
      // and their trails and runs under issues that are themselves gone.
      const at = Date.now()
      await recordTombstones("issueProjects", [id], at)
      await recordTombstones("issues", issueIds, at)
      await recordTombstones("issueEvents", eventIds, at)
      await recordTombstones("issueRuns", runIds, at)
    }
  )
}
