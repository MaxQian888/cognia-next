// Central scope helper for the Workspace (Project) isolation model — the single
// chokepoint every scoped Dexie read/write routes through. Concentrating "resolve
// the active projectId + filter by it" here (rather than scattering
// `getActiveProject()` across call sites) is what lets a future Profile layer
// wrap isolation one level out (DB-name prefix / keyring namespace) with zero
// changes to the per-table accessors. See `docs/.../adr` Subsystem Map.

import type { Collection, Table } from "dexie"
import type { Project } from "@/types"
import { getDb } from "./schema"
import { getSettings, saveSettings } from "./settings"
import { buildDefaultProject, DEFAULT_PROJECT_ID } from "./project-defaults"
import { purgeProjectBuckets } from "@/lib/project/project-bucket-purge"

export { DEFAULT_PROJECT_ID } from "./project-defaults"

/**
 * Ensure a usable workspace exists and return it. Called when no active project
 * is set: adopts the Default workspace (creating + activating it on first run).
 * Idempotent — a second call returns the same row without re-creating it.
 */
export async function ensureDefaultProject(): Promise<Project> {
  const db = getDb()
  const existing = await db.projects.get(DEFAULT_PROJECT_ID)
  if (existing) {
    const active = (await getSettings()).activeProjectId
    if (!active) await saveSettings({ activeProjectId: existing.id })
    return existing
  }
  const def = buildDefaultProject()
  await db.projects.put(def)
  await saveSettings({ activeProjectId: def.id })
  return def
}

/**
 * Resolve the workspace id to scope a read/write to. **Never returns null** —
 * this is the invariant the whole isolation model leans on. Precedence:
 * explicit arg → persisted `AppSettings.activeProjectId` → auto-created Default.
 *
 * Pass an explicit id from contexts that already know the target project (e.g.
 * a connector inbound that resolves the conversation's owning workspace) so the
 * write isn't mis-attributed to whatever happens to be active in the UI.
 */
export async function resolveScopeProjectId(explicit?: string | null): Promise<string> {
  if (explicit) return explicit
  const active = (await getSettings()).activeProjectId
  if (active) return active
  return (await ensureDefaultProject()).id
}

/**
 * Resolve the workspace a session-child row belongs to: explicit arg →
 * the session's own `projectId` → active project → Default. Used by goal /
 * plan / loop / trace writers so a child row always inherits its session's
 * workspace, never a stale UI-active one.
 */
export async function resolveSessionProjectId(
  sessionId: string,
  explicit?: string | null
): Promise<string> {
  if (explicit) return explicit
  const session = await getDb().sessions.get(sessionId)
  return resolveScopeProjectId(session?.projectId ?? null)
}

/**
 * Filter a table to one workspace. Thin wrapper so call sites read as
 * `scopedWhere(db.sessions, pid)` instead of repeating the index string — and
 * so the Profile layer can later intercept here.
 */
export function scopedWhere<T, K>(table: Table<T, K>, projectId: string): Collection<T, K> {
  return table.where("projectId").equals(projectId)
}

/**
 * Standalone tables deleted directly by their `projectId` column. (Event/child
 * tables are dropped by parent id instead — see `CHILD_TABLES` — so an event
 * append never has to pay a parent lookup just to stamp `projectId`.)
 */
const PROJECT_SCOPED_TABLES = [
  "sessions",
  "messages",
  "chatGoals",
  "agentPlans",
  "loops",
  "canvasDocuments",
  "workflowRuns",
  "outboundQueue",
  "connectorDrafts",
  "connectorAudit",
  "conversationOverrides",
  // v100 — project-scoped RAG chunks (workspace knowledge base). Dropping the
  // local rows here handles the Dexie side; the remote vector collection is
  // dropped separately in `deleteProjectCascade` (best-effort, see below).
  "projectChunks",
  // v145 — durable AgentTeam runtime and immutable local environment profiles.
  "agentTeamRuns",
  "projectEnvironments",
  "projectEnvironmentVersions",
] as const

/** Child/event tables dropped by parent id (parent collected via its projectId). */
const CHILD_TABLES: Array<{ table: string; parentTable: string; fk: string }> = [
  { table: "chatGoalEvents", parentTable: "chatGoals", fk: "goalId" },
  { table: "agentPlanEvents", parentTable: "agentPlans", fk: "planId" },
  { table: "loopEvents", parentTable: "loops", fk: "loopId" },
  { table: "canvasVersions", parentTable: "canvasDocuments", fk: "documentId" },
  { table: "canvasComments", parentTable: "canvasDocuments", fk: "documentId" },
  { table: "canvasSessions", parentTable: "canvasDocuments", fk: "documentId" },
  { table: "workflowRunEvents", parentTable: "workflowRuns", fk: "runId" },
  { table: "agentTeamChildRuns", parentTable: "agentTeamRuns", fk: "runId" },
  { table: "agentTeamTrajectory", parentTable: "agentTeamRuns", fk: "runId" },
  { table: "agentTeamCheckpoints", parentTable: "agentTeamRuns", fk: "runId" },
  { table: "agentTeamDecisions", parentTable: "agentTeamRuns", fk: "runId" },
  { table: "agentTeamSteeringReceipts", parentTable: "agentTeamRuns", fk: "runId" },
  { table: "agentTeamEvidence", parentTable: "agentTeamRuns", fk: "runId" },
  { table: "agentTeamDeliveryGraphs", parentTable: "agentTeamRuns", fk: "runId" },
  { table: "agentTeamDeliveryNodes", parentTable: "agentTeamRuns", fk: "runId" },
  { table: "agentTeamRetrospectives", parentTable: "agentTeamRuns", fk: "runId" },
]

/**
 * Session-child tables keyed by `sessionId` (no own `projectId` column). When a
 * workspace is deleted we drop these by the project's session ids so no orphan
 * usage/draft/state rows survive.
 */
const SESSION_CHILD_TABLES = [
  "sessionUsage",
  "chatDrafts",
  "chatInputHistory",
  "sessionState",
  // Staged remote attachments for a session that is going away. The bytes are
  // the whole point of the row, so leaving them behind would keep a deleted
  // workspace's files on disk with nothing left that can reference them.
  "sessionAttachmentUploads",
  // agentTraces carries `sessionId` — cascade by session so the high-volume
  // trace flush never pays a per-span lookup just to stamp `projectId`.
  "agentTraces",
] as const

/**
 * Cascade-delete every Workspace-scoped row for a project, eliminating orphans
 * that the old `Project.sessionIds[]` reverse-reference model left behind.
 * Covers `projectId`-indexed tables, their event/child tables (by parent id),
 * session-child tables (by sessionId), plus a best-effort purge of the
 * localStorage-backed artifact and agent-team buckets (dynamic import keeps
 * `lib/db` free of a store dependency).
 */
export async function deleteProjectCascade(projectId: string): Promise<void> {
  const db = getDb()
  const projectSessions = await scopedWhere(db.sessions, projectId).toArray()
  const sessionIds = projectSessions.map((session) => session.id)
  const overrideConversationKeys = (await scopedWhere(
    db.conversationOverrides,
    projectId
  ).primaryKeys()) as string[]
  const inboundConversationKeys = Array.from(
    new Set([
      ...overrideConversationKeys,
      ...projectSessions.flatMap((session) =>
        session.platformBinding?.conversationKey ? [session.platformBinding.conversationKey] : []
      ),
    ])
  )

  // Collect parent ids for the project so child/event tables can be dropped by
  // foreign key (covers child rows that never had a `projectId` stamped).
  const parentIds = new Map<string, string[]>()
  for (const { parentTable } of CHILD_TABLES) {
    if (parentIds.has(parentTable)) continue
    parentIds.set(
      parentTable,
      (await db.table(parentTable).where("projectId").equals(projectId).primaryKeys()) as string[]
    )
  }

  const tableNames = new Set<string>([
    ...PROJECT_SCOPED_TABLES,
    ...CHILD_TABLES.map((c) => c.table),
    ...SESSION_CHILD_TABLES,
  ])
  const tables = [...tableNames, "connectorInboundJobs"].map((t) => db.table(t))

  await db.transaction("rw", tables, async () => {
    for (const { table, parentTable, fk } of CHILD_TABLES) {
      const ids = parentIds.get(parentTable) ?? []
      if (ids.length > 0) await db.table(table).where(fk).anyOf(ids).delete()
    }
    for (const t of PROJECT_SCOPED_TABLES) {
      await db.table(t).where("projectId").equals(projectId).delete()
    }
    if (sessionIds.length > 0) {
      for (const t of SESSION_CHILD_TABLES) {
        await db.table(t).where("sessionId").anyOf(sessionIds).delete()
      }
    }
    if (inboundConversationKeys.length > 0) {
      await db.connectorInboundJobs.where("conversationKey").anyOf(inboundConversationKeys).delete()
    }
  })

  // Content-addressed runtime objects have no projectId by design because a
  // digest may be referenced by more than one run. Collect live references
  // after the cascade and remove only unreferenced objects.
  const [trajectory, evidence, retrospectives] = await Promise.all([
    db.agentTeamTrajectory.toArray(),
    db.agentTeamEvidence.toArray(),
    db.agentTeamRetrospectives.toArray(),
  ])
  const liveContentHashes = new Set<string>([
    ...trajectory.flatMap((row) => (row.contentHash ? [row.contentHash] : [])),
    ...evidence.flatMap((row) => (row.contentHash ? [row.contentHash] : [])),
    ...retrospectives.flatMap((row) => (row.contentHash ? [row.contentHash] : [])),
  ])
  const contentHashes = (await db.agentTeamContentObjects.toCollection().primaryKeys()) as string[]
  const orphanedHashes = contentHashes.filter((hash) => !liveContentHashes.has(hash))
  if (orphanedHashes.length > 0) await db.agentTeamContentObjects.bulkDelete(orphanedHashes)

  purgeProjectBuckets(projectId)
  await purgeProjectVectorCollection(projectId)
}

/**
 * Best-effort drop of the workspace's remote vector collection
 * (`cognia_project_{projectId}`). The Dexie `projectChunks` rows are already
 * gone (dropped in the cascade transaction above); this removes the vectors
 * from the configured backend so a deleted workspace doesn't leave the user's
 * (redacted) content resident in a third-party store — and so a re-created
 * project reusing the id can't hit stale vectors.
 *
 * Never throws: web / offline / an unreachable backend must not block project
 * deletion. When no vector backend is configured, `tryBuildProjectKnowledgeDeps`
 * returns `undefined` and this is a no-op. Dynamic import keeps `lib/db` free of
 * a static dependency on the project-knowledge runtime.
 */
async function purgeProjectVectorCollection(projectId: string): Promise<void> {
  try {
    const { tryBuildProjectKnowledgeDeps } =
      await import("@/lib/project-knowledge/runtime/build-deps")
    const { projectVectorCollectionName } = await import("@/lib/project-knowledge/ingest/persist")
    const deps = await tryBuildProjectKnowledgeDeps()
    if (!deps?.store?.deleteCollection) return
    await deps.store.deleteCollection(projectVectorCollectionName(projectId))
  } catch {
    // Non-fatal — the local rows are already dropped; a remote purge failure
    // must never block workspace deletion.
  }
}
