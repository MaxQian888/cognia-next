/**
 * Visual workflow CRUD — mirrors `lib/db/characters.ts` shape so callers find
 * the same `list / get / create / update / delete / duplicate / seed` API.
 *
 * The runtime tables (`workflowRuns`, `workflowRunEvents`, `workflowTriggers`)
 * have their own modules to keep this file focused on definitions.
 */

import type {
  VisualWorkflow,
  WorkflowRow,
  WorkflowRunRow,
  WorkflowSettings,
  WorkflowEdge,
  WorkflowNode,
} from "@/types/workflow/visual"
import { DEFAULT_WORKFLOW_SETTINGS } from "@/types/workflow/visual"
import { ROOT_FOLDER_ID } from "@/types/workflow/folder"
import { getDb } from "./schema"
import { recordTombstones } from "@/lib/sync/tombstones"
import { migrateWorkflow } from "@/lib/workflow/definition/migrate"

function newWorkflowId(): string {
  return "wf_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

function nowMs(): number {
  return Date.now()
}

/**
 * Project a committed workflow row into the trigger runtime. Persistence is
 * authoritative: a temporarily unavailable runtime must not roll back the
 * Dexie write, and startup reconciliation will retry the projection.
 */
async function projectPersistedWorkflowTriggers(workflow: VisualWorkflow): Promise<void> {
  try {
    const { syncWorkflowTriggers } = await import("@/lib/workflow/runtime/webhook-bridge")
    await syncWorkflowTriggers(workflow)
  } catch (error) {
    console.warn(`Workflow ${workflow.id} trigger projection failed:`, error)
  }
}

export async function listWorkflows(): Promise<WorkflowRow[]> {
  const rows = await getDb().workflows.orderBy("name").toArray()
  return rows.map(migrateWorkflow)
}

export async function listWorkflowsByUpdated(): Promise<WorkflowRow[]> {
  const rows = await getDb().workflows.orderBy("updatedAt").reverse().toArray()
  return rows.map(migrateWorkflow)
}

export async function listTemplateWorkflows(): Promise<WorkflowRow[]> {
  // IndexedDB doesn't index booleans reliably across browsers — the boolean
  // is in the schema's index list so Dexie tracks the keyPath, but we filter
  // in memory here. Same pattern as `lib/db/prompt-presets.ts` for `isBuiltIn`.
  const rows = await listWorkflowsByUpdated()
  return rows.filter((w) => w.isTemplate)
}

export async function getWorkflow(id: string): Promise<WorkflowRow | undefined> {
  const row = await getDb().workflows.get(id)
  return row ? migrateWorkflow(row) : undefined
}

export type WorkflowDraft = Pick<VisualWorkflow, "name"> &
  Partial<
    Pick<
      VisualWorkflow,
      | "description"
      | "icon"
      | "tags"
      | "nodes"
      | "edges"
      | "settings"
      | "credentials"
      | "viewport"
      | "isTemplate"
      | "folderId"
      | "complexity"
      | "variables"
      | "pinData"
      | "staticData"
      | "interface"
      | "published"
    >
  >

export async function createWorkflow(draft: WorkflowDraft): Promise<WorkflowRow> {
  const now = nowMs()
  const workflow: VisualWorkflow = {
    id: newWorkflowId(),
    schemaVersion: 2,
    name: draft.name.trim() || "Untitled workflow",
    description: draft.description,
    icon: draft.icon,
    tags: draft.tags ?? [],
    isTemplate: draft.isTemplate ?? false,
    isBuiltIn: false,
    complexity: draft.complexity,
    folderId: draft.folderId ?? ROOT_FOLDER_ID,
    createdAt: now,
    updatedAt: now,
    nodes: draft.nodes ?? [],
    edges: draft.edges ?? [],
    // ADR-0070 Phase 3: newly-authored workflows default to risk-gated. A
    // complete imported/template draft may explicitly carry true OR false;
    // preserve that authored posture instead of silently turning gating on.
    settings: {
      ...cloneSettings(draft.settings ?? DEFAULT_WORKFLOW_SETTINGS),
      riskGating: draft.settings?.riskGating ?? true,
    },
    credentials: draft.credentials,
    variables: draft.variables,
    pinData: draft.pinData,
    staticData: draft.staticData,
    viewport: draft.viewport ?? { x: 0, y: 0, zoom: 1 },
    interface: draft.interface,
    published: draft.published,
  }
  await getDb().workflows.put(workflow)
  await projectPersistedWorkflowTriggers(workflow)
  return workflow
}

export type WorkflowPatch = Partial<
  Omit<VisualWorkflow, "id" | "createdAt" | "isBuiltIn" | "schemaVersion">
>

/**
 * Applies a patch to an existing workflow. The `updatedAt` field is bumped
 * automatically; callers must not pass it manually (otherwise concurrent
 * editors with stale clocks could rewind it).
 */
export async function updateWorkflow(id: string, patch: WorkflowPatch): Promise<void> {
  const updated = await getDb().workflows.update(id, { ...patch, updatedAt: nowMs() })
  if (updated === 0) return
  const workflow = await getDb().workflows.get(id)
  if (workflow) await projectPersistedWorkflowTriggers(migrateWorkflow(workflow))
}

/**
 * Replaces the full workflow row. Used by the editor's "Save" action where the
 * whole graph round-trips. Refuses to write if the id doesn't already exist
 * (use `createWorkflow` for new rows). Bumps `updatedAt`.
 */
export async function replaceWorkflow(workflow: VisualWorkflow): Promise<void> {
  const existing = await getDb().workflows.get(workflow.id)
  if (!existing) {
    throw new Error(`Workflow ${workflow.id} not found`)
  }
  const replacement: VisualWorkflow = { ...workflow, schemaVersion: 2, updatedAt: nowMs() }
  await getDb().workflows.put(replacement)
  await projectPersistedWorkflowTriggers(replacement)
}

/** Query options for {@link listWorkflowRuns}. */
export interface WorkflowRunQuery {
  /** Restrict to a single workflow's runs. Omit for all runs. */
  workflowId?: string
  /** Page size (default 50). */
  limit?: number
  /** Rows to skip from the newest-first ordering (default 0). */
  offset?: number
}

/**
 * Paginated, newest-first listing of workflow runs. Extracted from the inline
 * query in `components/workflow/library/recent-runs-feed.tsx` so the Companion
 * API `workflow_run_list` RPC can reuse the same read.
 */
export async function listWorkflowRuns(query: WorkflowRunQuery = {}): Promise<WorkflowRunRow[]> {
  const { workflowId, limit = 50, offset = 0 } = query
  const db = getDb()
  if (workflowId) {
    // `sortBy` materializes then sorts in memory — fine for one workflow's runs.
    const rows = await db.workflowRuns.where("workflowId").equals(workflowId).sortBy("startedAt")
    rows.reverse()
    return rows.slice(offset, offset + limit)
  }
  return db.workflowRuns.orderBy("startedAt").reverse().offset(offset).limit(limit).toArray()
}

export async function deleteWorkflow(id: string): Promise<void> {
  const existing = await getDb().workflows.get(id)
  if (existing?.isBuiltIn) {
    throw new Error("Built-in workflows cannot be deleted. Duplicate first.")
  }
  if (existing) {
    const { unsyncWorkflowTriggers } = await import("@/lib/workflow/runtime/webhook-bridge")
    await unsyncWorkflowTriggers(existing)
  }
  await getDb().workflows.delete(id)
  // Mirror the deletion to paired phones via the companion sync (v61).
  await recordTombstones("workflows", [id])
  // Cascade-drop orphan fan-out subscriptions so they don't accumulate
  // in Dexie pointing at a workflow that no longer exists. Best-effort —
  // a failure here must not block the workflow delete. Lazy import keeps
  // `lib/db/workflows.ts` free of a module-init dependency on the
  // fan-out CRUD.
  try {
    const { deleteSubscriptionsForWorkflow } = await import("./workflow-fanout-subscriptions")
    await deleteSubscriptionsForWorkflow(id)
  } catch {
    // Swallow — orphan rows are harmless at runtime (the
    // progress-runner only queries by live workflows that have IM-
    // triggered runs).
  }
  // Cascade-drop the run history + per-step event log so deleting a workflow
  // doesn't leave its `workflowRuns` / `workflowRunEvents` rows orphaned
  // forever (they were previously never cleaned up). Best-effort — a failure
  // here must not block the workflow delete.
  try {
    await deleteAllRunsForWorkflow(id)
  } catch {
    // Swallow — orphan run/event rows are inert (every reader scopes by a
    // live workflow id), so a cleanup failure is non-fatal.
  }
}

/**
 * Clone a workflow (built-in or otherwise) into a new editable copy. The copy
 * is never marked built-in regardless of the source, and node ids are
 * preserved (callers wishing to reset ids can call `regenerateNodeIds`).
 */
export async function duplicateWorkflow(id: string): Promise<WorkflowRow> {
  const source = await getDb().workflows.get(id)
  if (!source) throw new Error(`Workflow ${id} not found`)
  const now = nowMs()
  const copy: VisualWorkflow = {
    ...source,
    id: newWorkflowId(),
    name: `${source.name} (copy)`,
    isBuiltIn: false,
    isTemplate: false,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().workflows.put(copy)
  await projectPersistedWorkflowTriggers(copy)
  return copy
}

/**
 * Returns workflows the library page should show as "yours" (excludes
 * templates and built-ins). Callers that want every workflow should use
 * `listWorkflows()` directly.
 */
export async function listUserWorkflows(): Promise<WorkflowRow[]> {
  const all = await listWorkflowsByUpdated()
  return all.filter((w) => !w.isTemplate && !w.isBuiltIn)
}

/**
 * Bulk seed built-in templates. Idempotent — uses stable ids so reseeding
 * never duplicates rows. Built-in rows are protected from `deleteWorkflow`.
 *
 * The actual template content is owned by `lib/workflow/definition/seed.ts`,
 * which is the single source of truth for the bundled gallery. This function
 * is the database-write half of that module.
 */
export async function seedBuiltInWorkflows(builtIns: VisualWorkflow[]): Promise<void> {
  if (builtIns.length === 0) return
  const db = getDb()
  // Carry forward isBuiltIn=true so the protection in deleteWorkflow stays.
  const stamped = builtIns.map((w) => ({
    ...w,
    isBuiltIn: true,
  }))
  await db.workflows.bulkPut(stamped)
}

/**
 * Clone nested settings values so a new workflow never aliases the shared
 * default object.
 */
function cloneSettings(s: WorkflowSettings): WorkflowSettings {
  return {
    ...s,
    retryDefaults: { ...s.retryDefaults },
    onFailure: s.onFailure ? { ...s.onFailure } : undefined,
  }
}

/**
 * Returns a fresh copy of the workflow with new node ids assigned. Used by
 * the editor's "Duplicate workflow" path when the caller wants a graph that
 * can coexist with the original on the same canvas (rare; most duplicates
 * keep ids).
 */
export function regenerateNodeIds(w: VisualWorkflow): VisualWorkflow {
  const idMap = new Map<string, string>()
  const fresh = (): string => "n_" + Math.random().toString(36).slice(2, 10)
  const nodes: WorkflowNode[] = w.nodes.map((n) => {
    const next = fresh()
    idMap.set(n.id, next)
    return { ...n, id: next }
  })
  const edges: WorkflowEdge[] = w.edges.map((e) => ({
    ...e,
    source: idMap.get(e.source) ?? e.source,
    target: idMap.get(e.target) ?? e.target,
  }))
  return { ...w, nodes, edges }
}

// ── Library organization (ADR-0011 library upgrade) ──────────────────────────

/** Workflows directly in a folder. Unsorted — the library store applies the
 * user's chosen sort so the DB read stays index-only. */
export async function listWorkflowsInFolder(folderId: string): Promise<WorkflowRow[]> {
  return getDb().workflows.where("folderId").equals(folderId).toArray()
}

/** Move a single workflow into a folder (root = `ROOT_FOLDER_ID`). */
export async function moveWorkflowToFolder(id: string, folderId: string): Promise<void> {
  await updateWorkflow(id, { folderId: folderId || ROOT_FOLDER_ID })
}

/** Batch-move workflows into one folder. Single transaction so the library's
 * `useLiveQuery` re-renders once, not per row. */
export async function moveWorkflowsToFolder(ids: string[], folderId: string): Promise<void> {
  if (ids.length === 0) return
  const db = getDb()
  const target = folderId || ROOT_FOLDER_ID
  await db.transaction("rw", db.workflows, async () => {
    const now = nowMs()
    for (const id of ids) {
      await db.workflows.update(id, { folderId: target, updatedAt: now })
    }
  })
}

/** Add a tag to every workflow in `ids` (idempotent per row). Read-modify-
 * write in one transaction; bumps `updatedAt`. */
export async function addTagToWorkflows(ids: string[], tag: string): Promise<void> {
  const clean = tag.trim()
  if (ids.length === 0 || !clean) return
  const db = getDb()
  await db.transaction("rw", db.workflows, async () => {
    const now = nowMs()
    for (const id of ids) {
      const row = await db.workflows.get(id)
      if (!row) continue
      const tags = row.tags ?? []
      if (tags.includes(clean)) continue
      await db.workflows.update(id, { tags: [...tags, clean], updatedAt: now })
    }
  })
}

// Per-workflow run counts feed the "most runs" library sort. The count query
// hits the `workflowId` index on `workflowRuns`, but firing one count per card
// on every keystroke is wasteful, so results are memoized for a short window.
// Only the runCount sort path calls this; the other four sorts never pay for it.
const RUN_COUNT_TTL_MS = 30_000
let runCountCache: { at: number; counts: Map<string, number> } | null = null

export async function getRunCounts(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map()
  const now = nowMs()
  if (runCountCache && now - runCountCache.at < RUN_COUNT_TTL_MS) {
    return runCountCache.counts
  }
  const db = getDb()
  const counts = new Map<string, number>()
  await Promise.all(
    ids.map(async (id) => {
      counts.set(id, await db.workflowRuns.where("workflowId").equals(id).count())
    })
  )
  runCountCache = { at: now, counts }
  return counts
}

/** Test seam — drop the run-count memo so a fresh count is fetched. */
export function __resetRunCountCacheForTesting(): void {
  runCountCache = null
}

/**
 * Ids of workflows whose runs include a failure at or after `sinceMs`. Powers
 * the library's "recently failed" status filter. One query against the
 * `status` index, filtered to the time window in memory.
 */
export async function getRecentlyFailedWorkflowIds(sinceMs: number): Promise<Set<string>> {
  const db = getDb()
  const rows = await db.workflowRuns.where("status").equals("failed").toArray()
  const out = new Set<string>()
  for (const r of rows) {
    if (r.startedAt >= sinceMs) out.add(r.workflowId)
  }
  return out
}

/**
 * Dead-letter queue (A3): terminally-failed runs the user hasn't yet
 * acknowledged. Queries the existing `status` index (no schema change) and
 * filters out acknowledged rows in memory. Optionally scoped to one workflow.
 * Newest first.
 */
export async function listDeadLetters(workflowId?: string): Promise<WorkflowRunRow[]> {
  const db = getDb()
  const rows = await db.workflowRuns.where("status").equals("failed").toArray()
  return rows
    .filter((r) => r.acknowledgedAt === undefined && (!workflowId || r.workflowId === workflowId))
    .sort((a, b) => b.startedAt - a.startedAt)
}

/** Dismiss a failed run from the dead-letter list (stamps `acknowledgedAt`). */
export async function acknowledgeRun(runId: string): Promise<void> {
  await getDb().workflowRuns.update(runId, { acknowledgedAt: nowMs() })
}

/** Fetch a single run row by id (for the TUI run-replay/inspect path). */
export async function getWorkflowRun(id: string): Promise<WorkflowRunRow | undefined> {
  return getDb().workflowRuns.get(id)
}

/**
 * Record that a failed run was replayed: links the new run id and bumps the
 * replay counter so the panel can show "replayed ×N". Does not acknowledge —
 * the user may want to keep watching until the replay succeeds.
 */
export async function markReplayed(runId: string, replayRunId: string): Promise<void> {
  const db = getDb()
  const row = await db.workflowRuns.get(runId)
  if (!row) return
  await db.workflowRuns.update(runId, {
    replayedByRunId: replayRunId,
    replayCount: (row.replayCount ?? 0) + 1,
  })
}

/**
 * Delete a single run plus its per-step event log. Empty/unknown ids are a
 * silent no-op (matches `acknowledgeRun`'s tolerant style). The run + event
 * deletes run in one transaction so a crash can't leave dangling events.
 */
export async function deleteWorkflowRun(runId: string): Promise<void> {
  if (!runId) return
  const db = getDb()
  await db.transaction("rw", db.workflowRuns, db.workflowRunEvents, async () => {
    await db.workflowRunEvents.where("runId").equals(runId).delete()
    await db.workflowRuns.delete(runId)
  })
}

/** Bulk variant of {@link deleteWorkflowRun}. Skips empty ids. */
export async function deleteWorkflowRuns(runIds: string[]): Promise<void> {
  const ids = runIds.filter(Boolean)
  if (ids.length === 0) return
  const db = getDb()
  await db.transaction("rw", db.workflowRuns, db.workflowRunEvents, async () => {
    await db.workflowRunEvents.where("runId").anyOf(ids).delete()
    await db.workflowRuns.bulkDelete(ids)
  })
}

/**
 * Clear all runs (and their events) for one workflow. Returns how many run
 * rows were removed. Empty/unknown workflow ids resolve to 0.
 */
export async function deleteAllRunsForWorkflow(workflowId: string): Promise<number> {
  if (!workflowId) return 0
  const db = getDb()
  return db.transaction("rw", db.workflowRuns, db.workflowRunEvents, async () => {
    const runIds = (await db.workflowRuns
      .where("workflowId")
      .equals(workflowId)
      .primaryKeys()) as string[]
    if (runIds.length === 0) return 0
    await db.workflowRunEvents.where("runId").anyOf(runIds).delete()
    await db.workflowRuns.bulkDelete(runIds)
    return runIds.length
  })
}

/**
 * Clone a workflow into a reusable template copy (`isTemplate: true`). Reuses
 * {@link createWorkflow}, which mints a fresh workflow id; node ids are scoped
 * per-workflow so they need no regeneration. Throws if the source is missing.
 */
export async function saveWorkflowAsTemplate(id: string): Promise<WorkflowRow> {
  const source = await getDb().workflows.get(id)
  if (!source) throw new Error(`Workflow ${id} not found`)
  return createWorkflow({
    ...source,
    name: `${source.name} (template)`,
    isTemplate: true,
    // Publication is identity-bearing state tied to the source workflow id
    // and stable tool name. The reusable interface is copied; the template
    // must be explicitly published after instantiation.
    published: undefined,
  })
}

/**
 * Map each workflow id → the status of its most-recent run (by `startedAt`).
 * Ids with no runs are omitted. Powers the library card "last run" badge. Uses
 * the `[workflowId+startedAt]` compound index to read just the newest row.
 */
export async function getLastRunStatuses(
  ids: string[]
): Promise<Map<string, WorkflowRunRow["status"]>> {
  const out = new Map<string, WorkflowRunRow["status"]>()
  if (ids.length === 0) return out
  const db = getDb()
  await Promise.all(
    ids.map(async (id) => {
      const latest = await db.workflowRuns
        .where("[workflowId+startedAt]")
        .between([id, 0], [id, Number.MAX_SAFE_INTEGER])
        .last()
      if (latest) out.set(id, latest.status)
    })
  )
  return out
}
