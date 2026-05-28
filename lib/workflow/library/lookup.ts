/**
 * Backend-only workflow name → id resolution.
 *
 * Distinct from `stores/workflow/workflow-library-store.ts` — that store is
 * UI state for the library page (view mode, filters, multi-select). This
 * module is a pure Dexie lookup callable from plugin tool executors,
 * background runners, and the IM connector bus where no React store
 * exists. Resolution rules:
 *
 *   1. Case-insensitive exact match on `name` — unique hit wins.
 *   2. If 0 exact hits, fall back to case-insensitive substring match —
 *      unique hit wins, multi-hit returns the candidate list.
 *   3. If still 0 hits, return `notFound`.
 *
 * The "5 candidate cap" stops the agent from drowning the user in
 * suggestions when the query is too vague (e.g., "workflow"). The agent
 * is expected to surface the candidates and re-prompt.
 */

import { listWorkflows } from "@/lib/db/workflows"
import type { WorkflowRow } from "@/types/workflow/visual"

export interface WorkflowSummary {
  id: string
  name: string
  description?: string
}

export type FindWorkflowByNameResult =
  | { ok: true; workflowId: string; name: string }
  | { ok: false; reason: "ambiguous"; candidates: WorkflowSummary[] }
  | { ok: false; reason: "not-found" }

const MAX_CANDIDATES = 5

function toSummary(row: WorkflowRow): WorkflowSummary {
  return { id: row.id, name: row.name, description: row.description }
}

/**
 * Resolve a workflow by its display name. Pure function over the Dexie
 * workflows table — every call re-reads, so callers wanting cached results
 * should layer their own memoisation. The lookup deliberately does not
 * filter out `isTemplate` rows: an operator running a template directly
 * from IM is a legitimate flow.
 */
export async function findWorkflowByName(name: string): Promise<FindWorkflowByNameResult> {
  const query = name.trim().toLowerCase()
  if (query.length === 0) return { ok: false, reason: "not-found" }

  const rows = await listWorkflows()

  const exact = rows.filter((r) => r.name.trim().toLowerCase() === query)
  if (exact.length === 1) return { ok: true, workflowId: exact[0].id, name: exact[0].name }
  if (exact.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      candidates: exact.slice(0, MAX_CANDIDATES).map(toSummary),
    }
  }

  const substring = rows.filter((r) => r.name.toLowerCase().includes(query))
  if (substring.length === 1) {
    return { ok: true, workflowId: substring[0].id, name: substring[0].name }
  }
  if (substring.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      candidates: substring.slice(0, MAX_CANDIDATES).map(toSummary),
    }
  }

  return { ok: false, reason: "not-found" }
}

/**
 * Return a stable summary list for the agent's "list workflows" tool.
 * Sorted alphabetically so the agent's textual rendering is deterministic
 * across calls. Truncates to `limit` (defaults 50) to keep the tool
 * response under the typical 16 KB structured-output cap.
 */
export async function listWorkflowSummaries(limit = 50): Promise<WorkflowSummary[]> {
  const rows = await listWorkflows()
  return rows.slice(0, limit).map(toSummary)
}
