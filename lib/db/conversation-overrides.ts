/**
 * CRUD layer for the `conversationOverrides` Dexie table (schema v18).
 *
 * Per-conversation settings that override adapter-level defaults.
 * Keyed by `conversationKey` (unique constraint `&conversationKey`).
 */

import type { ConversationOverrideRow } from "./connector-types"
import type { AssignmentEventKind } from "./crm-types"
import { getDb } from "./schema"
import { appendAssignmentEvent } from "./conversation-assignment-events"
import { resolveSessionProjectId } from "./project-scope"

function newId(): string {
  return "cov_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export type ConversationStatus = NonNullable<ConversationOverrideRow["status"]>
export type ConversationAssignee = NonNullable<ConversationOverrideRow["assignee"]>

/** The effective lifecycle status for a (possibly absent) override row. */
export function effectiveStatus(row: ConversationOverrideRow | undefined): ConversationStatus {
  return row?.status ?? "open"
}

/**
 * Get the override row for a conversation, creating it when missing. A new row
 * needs the `sessionId` link (the schema requires it); callers that only have
 * the conversationKey must pass `sessionId` so a first-customization can
 * persist. Throws if the row is absent and no `sessionId` is supplied.
 */
async function ensureRow(
  conversationKey: string,
  sessionId?: string
): Promise<ConversationOverrideRow> {
  const existing = await readForResolution(conversationKey)
  if (existing) return existing
  if (!sessionId) {
    throw new Error(
      `conversationOverrides: no row for ${conversationKey} and no sessionId to create one`
    )
  }
  return upsertByConversationKey({ conversationKey, sessionId })
}

export type ConversationOverrideInput = Omit<
  ConversationOverrideRow,
  "id" | "createdAt" | "updatedAt"
>

/**
 * Create or update the override row for a conversation key. Bumps `updatedAt`.
 */
export async function upsertByConversationKey(
  input: ConversationOverrideInput
): Promise<ConversationOverrideRow> {
  const db = getDb()
  const now = Date.now()
  const existing = await db.conversationOverrides
    .where("conversationKey")
    .equals(input.conversationKey)
    .first()

  if (existing) {
    const updated: ConversationOverrideRow = {
      ...existing,
      ...input,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: now,
    }
    await db.conversationOverrides.put(updated)
    return updated
  }

  const row: ConversationOverrideRow = {
    id: newId(),
    ...input,
    // Workspace isolation (Dexie v86): per-conversation routing belongs to the
    // session's workspace. Connector CONFIG (adapter instances/credentials)
    // stays profile-shared — only this routing row is per-project.
    projectId: input.projectId ?? (await resolveSessionProjectId(input.sessionId)),
    createdAt: now,
    updatedAt: now,
  }
  await db.conversationOverrides.add(row)
  return row
}

/** Return the override row for a conversation key, or undefined. */
export async function readForResolution(
  conversationKey: string
): Promise<ConversationOverrideRow | undefined> {
  return getDb().conversationOverrides.where("conversationKey").equals(conversationKey).first()
}

/**
 * Apply a partial patch to a conversation's override row, creating the row
 * first when it doesn't exist yet (requires `sessionId` in that case). Bumps
 * `updatedAt`. Returns the resulting row.
 *
 * The control-plane in-chat commands (`/model`, `/mode`, `/reasoning`,
 * `/character`, `/team`, `/mode yolo|prompt`) and the proactive-push opt-in
 * all funnel through here so a single primitive owns the "ensure + merge +
 * touch" semantics. Unlike `upsertByConversationKey` (which requires the full
 * non-derived row shape), this accepts any subset of mutable fields.
 */
export async function patchConversationOverride(
  conversationKey: string,
  patch: Partial<Omit<ConversationOverrideRow, "id" | "conversationKey" | "createdAt">>,
  sessionId?: string
): Promise<ConversationOverrideRow> {
  const db = getDb()
  const row = await ensureRow(conversationKey, sessionId)
  const updated: ConversationOverrideRow = { ...row, ...patch, updatedAt: Date.now() }
  await db.conversationOverrides.put(updated)
  return updated
}

/** Set or clear the `pinned` flag. */
export async function setPinned(id: string, pinned: boolean): Promise<void> {
  await getDb().conversationOverrides.update(id, { pinned, updatedAt: Date.now() })
}

/** Set or clear the `archived` flag. */
export async function setArchived(id: string, archived: boolean): Promise<void> {
  await getDb().conversationOverrides.update(id, { archived, updatedAt: Date.now() })
}

// ---------------------------------------------------------------------------
// CRM maturation (schema v83) — lifecycle status, assignment, labels, SLA.
// All keyed by conversationKey (auto-create the row); status / assignee / label
// transitions append to the conversationAssignmentEvents trail.
// ---------------------------------------------------------------------------

export interface SetStatusOptions {
  /** Needed only when the override row doesn't exist yet. */
  sessionId?: string
  /** For status === "snoozed": epoch ms to auto-wake. */
  snoozeUntil?: number
}

/** Set the lifecycle status; emits a `status.*` trail entry on an actual change. */
export async function setStatus(
  conversationKey: string,
  status: ConversationStatus,
  opts: SetStatusOptions = {}
): Promise<void> {
  const db = getDb()
  const row = await ensureRow(conversationKey, opts.sessionId)
  const fromStatus = effectiveStatus(row)
  await db.conversationOverrides.update(row.id, {
    status,
    snoozeUntil: status === "snoozed" ? opts.snoozeUntil : undefined,
    updatedAt: Date.now(),
  })
  if (fromStatus !== status) {
    await appendAssignmentEvent({
      conversationKey,
      kind: `status.${status}` as AssignmentEventKind,
      fields: { fromStatus, toStatus: status },
    })
  }
}

/**
 * Flip every "snoozed" conversation whose `snoozeUntil` has elapsed back to
 * "open" (emitting a trail entry). Returns the count woken. Called by the
 * outbound-runner tick so it works headless.
 */
export async function wakeSnoozedConversations(now: number = Date.now()): Promise<number> {
  const db = getDb()
  const snoozed = await db.conversationOverrides.where("status").equals("snoozed").toArray()
  let woken = 0
  for (const row of snoozed) {
    if (row.snoozeUntil !== undefined && row.snoozeUntil <= now) {
      await db.conversationOverrides.update(row.id, {
        status: "open",
        snoozeUntil: undefined,
        updatedAt: now,
      })
      await appendAssignmentEvent({
        conversationKey: row.conversationKey,
        kind: "status.open",
        at: now,
        fields: { reason: "snooze-elapsed" },
      })
      woken++
    }
  }
  return woken
}

export interface SetAssigneeOptions {
  sessionId?: string
  /** Free-form provenance (e.g. "manual", "auto-route") recorded on the trail. */
  via?: string
}

/** Set or clear the assignee; emits assigned / reassigned / unassigned. */
export async function setAssignee(
  conversationKey: string,
  assignee: ConversationAssignee | null,
  opts: SetAssigneeOptions = {}
): Promise<void> {
  const db = getDb()
  const row = await ensureRow(conversationKey, opts.sessionId)
  const had = row.assignee
  await db.conversationOverrides.update(row.id, {
    assignee: assignee ?? undefined,
    assigneeKind: assignee?.kind,
    updatedAt: Date.now(),
  })
  const kind: AssignmentEventKind = !assignee ? "unassigned" : had ? "reassigned" : "assigned"
  await appendAssignmentEvent({
    conversationKey,
    kind,
    fields: { from: had ?? null, to: assignee ?? null, via: opts.via },
  })
}

/** Add a label to a conversation (idempotent); emits `label.added`. */
export async function addLabel(
  conversationKey: string,
  labelId: string,
  sessionId?: string
): Promise<void> {
  const db = getDb()
  const row = await ensureRow(conversationKey, sessionId)
  const current = row.labelIds ?? []
  if (current.includes(labelId)) return
  await db.conversationOverrides.update(row.id, {
    labelIds: [...current, labelId],
    updatedAt: Date.now(),
  })
  await appendAssignmentEvent({ conversationKey, kind: "label.added", fields: { labelId } })
}

/** Remove a label from a conversation (idempotent); emits `label.removed`. */
export async function removeLabel(
  conversationKey: string,
  labelId: string,
  sessionId?: string
): Promise<void> {
  const db = getDb()
  const row = await ensureRow(conversationKey, sessionId)
  const current = row.labelIds ?? []
  if (!current.includes(labelId)) return
  await db.conversationOverrides.update(row.id, {
    labelIds: current.filter((l) => l !== labelId),
    updatedAt: Date.now(),
  })
  await appendAssignmentEvent({ conversationKey, kind: "label.removed", fields: { labelId } })
}

/** Set SLA due timestamps (no trail entry — SLA is derived, not an action). */
export async function setSlaDue(
  conversationKey: string,
  due: { firstResponseDueAt?: number; nextResponseDueAt?: number },
  sessionId?: string
): Promise<void> {
  const db = getDb()
  const row = await ensureRow(conversationKey, sessionId)
  const patch: Partial<ConversationOverrideRow> = { updatedAt: Date.now() }
  if (due.firstResponseDueAt !== undefined) patch.firstResponseDueAt = due.firstResponseDueAt
  if (due.nextResponseDueAt !== undefined) patch.nextResponseDueAt = due.nextResponseDueAt
  await db.conversationOverrides.update(row.id, patch)
}

/**
 * Clear the next-response SLA timer when an outbound reply is sent, stamping
 * `firstRespondedAt` once. No-op when the conversation has no override row.
 */
export async function markResponded(
  conversationKey: string,
  now: number = Date.now()
): Promise<void> {
  const row = await readForResolution(conversationKey)
  if (!row) return
  const patch: Partial<ConversationOverrideRow> = { nextResponseDueAt: undefined, updatedAt: now }
  if (row.firstRespondedAt === undefined) patch.firstRespondedAt = now
  await getDb().conversationOverrides.update(row.id, patch)
}
