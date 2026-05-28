/**
 * CRUD layer for the `workflowFanoutSubscriptions` Dexie table (v56).
 *
 * Each row is a static "every run of workflow X mirrors progress into
 * channel (adapterId, conversationKey)" rule. The progress-runner reads
 * the live rows for a workflowId at watcher creation; the Settings UI +
 * the `wf_subscribe_workflow_fanout` Claude tool both write here.
 *
 * One row per `(workflowId, adapterId, conversationKey)` triple — Dexie
 * doesn't support multi-column unique constraints, so `create*` writes
 * upsert by the deterministic id `wfsub:<workflowId>:<adapterId>:<conversationKey>`.
 * That keeps a re-subscribe call idempotent (the UI's "Add" button or a
 * second tool invocation just refreshes `enabled`/`updatedAt` rather
 * than duplicating).
 */

import type { WorkflowFanoutSubscriptionRow } from "./connector-types"
import { getDb } from "./schema"

export interface CreateFanoutSubscriptionInput {
  workflowId: string
  adapterId: string
  conversationKey: string
  /** Defaults to `true` so newly added subscriptions are live. */
  enabled?: boolean
  /** Audit-only provenance tag. */
  createdBy: WorkflowFanoutSubscriptionRow["createdBy"]
}

/**
 * Deterministic primary key — the (workflowId, adapterId,
 * conversationKey) triple. Lets `create` be idempotent and a separate
 * "find by triple" helper avoid scanning.
 */
function subscriptionId(input: {
  workflowId: string
  adapterId: string
  conversationKey: string
}): string {
  return `wfsub:${input.workflowId}:${input.adapterId}:${input.conversationKey}`
}

/**
 * Create or refresh a fan-out subscription. Idempotent on the
 * `(workflowId, adapterId, conversationKey)` triple — a second call
 * with the same triple just updates `updatedAt` + `enabled`/`createdBy`.
 * Returns the persisted row.
 */
export async function createFanoutSubscription(
  input: CreateFanoutSubscriptionInput
): Promise<WorkflowFanoutSubscriptionRow> {
  const now = Date.now()
  const id = subscriptionId(input)
  const existing = await getDb().workflowFanoutSubscriptions.get(id)
  const row: WorkflowFanoutSubscriptionRow = {
    id,
    workflowId: input.workflowId,
    adapterId: input.adapterId,
    conversationKey: input.conversationKey,
    enabled: input.enabled ?? true,
    createdBy: existing?.createdBy ?? input.createdBy,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await getDb().workflowFanoutSubscriptions.put(row)
  return row
}

/**
 * List every subscription for a workflow. Defaults to live rows only
 * (`enabled === true`) since the progress-runner only needs live ones;
 * the Settings UI passes `{ includeDisabled: true }` to surface the
 * complete list.
 */
export async function listForWorkflow(
  workflowId: string,
  opts: { includeDisabled?: boolean } = {}
): Promise<WorkflowFanoutSubscriptionRow[]> {
  if (opts.includeDisabled) {
    return getDb().workflowFanoutSubscriptions.where("workflowId").equals(workflowId).toArray()
  }
  return (
    getDb()
      .workflowFanoutSubscriptions.where("[workflowId+enabled]")
      .equals([workflowId, 1])
      .toArray()
      // Dexie's boolean indexing is per-browser unreliable — fall back to a
      // value-filter so an IDB that coerces `true` → 1 vs `true` doesn't
      // silently drop rows. The double pass is cheap because the row count
      // per workflow stays small (operator-configured).
      .then(async (rows) =>
        rows.length > 0
          ? rows
          : (
              await getDb()
                .workflowFanoutSubscriptions.where("workflowId")
                .equals(workflowId)
                .toArray()
            ).filter((r) => r.enabled)
      )
  )
}

/** Toggle enabled without dropping the row. */
export async function setSubscriptionEnabled(id: string, enabled: boolean): Promise<void> {
  await getDb().workflowFanoutSubscriptions.update(id, {
    enabled,
    updatedAt: Date.now(),
  })
}

/** Hard delete. */
export async function deleteFanoutSubscription(id: string): Promise<void> {
  await getDb().workflowFanoutSubscriptions.delete(id)
}

/**
 * List every subscription that mirrors INTO a given channel. Powers the
 * Settings → Connections → "what does this channel receive?" reverse view.
 */
export async function listForChannel(
  adapterId: string,
  conversationKey: string
): Promise<WorkflowFanoutSubscriptionRow[]> {
  const rows = await getDb()
    .workflowFanoutSubscriptions.where("adapterId")
    .equals(adapterId)
    .toArray()
  return rows.filter((r) => r.conversationKey === conversationKey)
}

/**
 * Drop every subscription for a workflow. Called from the workflow
 * delete path so orphan rows don't accumulate in Dexie after a workflow
 * is removed. Returns the number of rows deleted so the caller can
 * decide whether to surface a toast.
 *
 * Safe to call even when the workflow still exists (it then becomes a
 * "remove all mirrors for this workflow" operation — useful when the
 * operator wants to reset).
 */
export async function deleteSubscriptionsForWorkflow(workflowId: string): Promise<number> {
  const ids = await getDb()
    .workflowFanoutSubscriptions.where("workflowId")
    .equals(workflowId)
    .primaryKeys()
  if (ids.length === 0) return 0
  await getDb().workflowFanoutSubscriptions.bulkDelete(ids as string[])
  return ids.length
}

/** Pure helper exposed for tests that need to seed deterministic ids. */
export const __subscriptionIdForTesting = subscriptionId
