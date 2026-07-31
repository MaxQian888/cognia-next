// v86 upgrade backfill for the Workspace (Project) isolation model. Stamps a
// `projectId` onto every pre-isolation runtime row.
//
// Faithfulness: before isolation a session's true owner was recorded only by
// the reverse reference `Project.sessionIds[]`. We rebuild a session→project
// map from those arrays so a multi-project user's existing data lands in the
// right workspace; rows we cannot attribute (canvas/workflow runs/outbound
// queue/audit, or sessions referenced by no project) fall back to the active
// project — or to an auto-created Default workspace when none is active.
//
// Extracted from the inline `schema.ts` upgrade so the (error-prone) backfill
// is unit-testable in isolation. Operates purely on the passed Dexie
// transaction; never calls `getDb()`.

import type { Transaction } from "dexie"
import type { Project } from "@/types"
import { buildDefaultProject } from "./project-defaults"

const SETTINGS_SINGLETON_ID = "singleton"

/** Tables whose row carries a `sessionId` — attributed via the reverse map. */
const SESSION_LINKED_TABLES = [
  "chatGoals",
  "agentPlans",
  "loops",
  "agentTraces",
  "connectorDrafts",
  "conversationOverrides",
] as const

/** Child/event tables keyed by a parent id, attributed from the parent's project. */
const CHILD_TABLES: Array<{ table: string; parentTable: string; fk: string }> = [
  { table: "chatGoalEvents", parentTable: "chatGoals", fk: "goalId" },
  { table: "agentPlanEvents", parentTable: "agentPlans", fk: "planId" },
  { table: "loopEvents", parentTable: "loops", fk: "loopId" },
  { table: "canvasVersions", parentTable: "canvasDocuments", fk: "documentId" },
  { table: "canvasComments", parentTable: "canvasDocuments", fk: "documentId" },
  { table: "canvasSessions", parentTable: "canvasDocuments", fk: "documentId" },
  { table: "workflowRunEvents", parentTable: "workflowRuns", fk: "runId" },
]

/** Tables with no session/parent linkage — attributed to the fallback project. */
const FALLBACK_ONLY_TABLES = [
  "canvasDocuments",
  "workflowRuns",
  "outboundQueue",
  "connectorAudit",
] as const

/** Stamp every undefined-`projectId` row in a table via `derive(row)`. */
async function stampTable(
  tx: Transaction,
  table: string,
  derive: (row: Record<string, unknown>) => string
): Promise<void> {
  await tx
    .table(table)
    .toCollection()
    .modify((row: Record<string, unknown>) => {
      if (row.projectId === undefined) row.projectId = derive(row)
    })
}

/** Build a `id → projectId` map from a table that already carries `projectId`. */
async function projectIdByKey(
  tx: Transaction,
  table: string,
  key: string
): Promise<Map<string, string>> {
  const rows = (await tx.table(table).toArray()) as Array<Record<string, unknown>>
  const map = new Map<string, string>()
  for (const row of rows) {
    const k = row[key]
    const pid = row.projectId
    if (typeof k === "string" && typeof pid === "string") map.set(k, pid)
  }
  return map
}

/**
 * Resolve the fallback workspace id, creating + activating a Default workspace
 * when none is active. Returns both the id and the full project list (including
 * a freshly-created Default) so the caller can build the reverse map.
 */
async function resolveFallback(
  tx: Transaction
): Promise<{ fallbackId: string; projects: Project[] }> {
  const projectsTable = tx.table("projects")
  const settingsTable = tx.table("settings")
  const projects = (await projectsTable.toArray()) as Project[]
  const settings = (await settingsTable.get(SETTINGS_SINGLETON_ID)) as
    (Record<string, unknown> & { activeProjectId?: string }) | undefined
  const activeId = settings?.activeProjectId

  if (activeId && projects.some((p) => p.id === activeId)) {
    return { fallbackId: activeId, projects }
  }
  // No active pointer, or it references a row that no longer exists
  // (corrupt/cleared) — create + activate a Default workspace to land on.
  const def = buildDefaultProject()
  await projectsTable.put(def)
  if (settings) {
    await settingsTable.put({ ...settings, activeProjectId: def.id })
  } else {
    await settingsTable.put({ id: SETTINGS_SINGLETON_ID, activeProjectId: def.id })
  }
  return { fallbackId: def.id, projects: [...projects, def] }
}

/**
 * Backfill `projectId` across all Workspace-scoped tables. Idempotent: only
 * rows with `projectId === undefined` are touched, so re-running (or running
 * over a DB that already has the column) is a no-op.
 */
export async function backfillProjectScopeV86(tx: Transaction): Promise<void> {
  const { fallbackId, projects } = await resolveFallback(tx)

  // Reverse map: sessionId → owning projectId (from the legacy sessionIds[]).
  const sessionToProject = new Map<string, string>()
  for (const p of projects) {
    for (const sid of p.sessionIds ?? []) {
      if (typeof sid === "string") sessionToProject.set(sid, p.id)
    }
  }
  const bySession = (sid: unknown): string =>
    (typeof sid === "string" && sessionToProject.get(sid)) || fallbackId

  // 1. Sessions — keyed by their own id in the reverse map.
  await stampTable(tx, "sessions", (s) => sessionToProject.get(s.id as string) ?? fallbackId)

  // 2. Messages + session-linked tables — attributed via sessionId.
  await stampTable(tx, "messages", (m) => bySession(m.sessionId))
  for (const table of SESSION_LINKED_TABLES) {
    await stampTable(tx, table, (r) => bySession(r.sessionId))
  }

  // 3. Fallback-only tables (no linkage) — stamp first so child tables that
  //    derive from `canvasDocuments` / `workflowRuns` see the parent's project.
  for (const table of FALLBACK_ONLY_TABLES) {
    await stampTable(tx, table, () => fallbackId)
  }

  // 4. Child/event tables — inherit the parent's project (parents now stamped).
  for (const { table, parentTable, fk } of CHILD_TABLES) {
    const parentMap = await projectIdByKey(tx, parentTable, "id")
    await stampTable(tx, table, (r) => parentMap.get(r[fk] as string) ?? fallbackId)
  }
}
