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
    folderId: draft.folderId ?? ROOT_FOLDER_ID,
    createdAt: now,
    updatedAt: now,
    nodes: draft.nodes ?? [],
    edges: draft.edges ?? [],
    settings: draft.settings ?? cloneSettings(DEFAULT_WORKFLOW_SETTINGS),
    credentials: draft.credentials,
    viewport: draft.viewport ?? { x: 0, y: 0, zoom: 1 },
  }
  await getDb().workflows.put(workflow)
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
  await getDb().workflows.update(id, { ...patch, updatedAt: nowMs() })
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
  await getDb().workflows.put({ ...workflow, schemaVersion: 2, updatedAt: nowMs() })
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
 * Helper for `replaceWorkflow` callers: deep-clones a settings object so the
 * caller can mutate without touching the constant.
 */
function cloneSettings(s: WorkflowSettings): WorkflowSettings {
  return {
    errorPolicy: s.errorPolicy,
    timeoutMs: s.timeoutMs,
    concurrency: s.concurrency,
    retryDefaults: { ...s.retryDefaults },
    timezone: s.timezone,
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
