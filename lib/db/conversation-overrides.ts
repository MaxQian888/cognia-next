/**
 * CRUD layer for the `conversationOverrides` Dexie table (schema v18).
 *
 * Per-conversation settings that override adapter-level defaults.
 * Keyed by `conversationKey` (unique constraint `&conversationKey`).
 */

import type { ConversationOverrideRow } from "./connector-types"
import type { AssignmentEventKind } from "./crm-types"
import type { ConnectorMode } from "@/types/connectors/policy"
import { parseConversationKey } from "@/types/connectors/event"
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

export type ConversationConfigSection = "behavior" | "responder" | "permissions" | "delivery"

export type ConversationConfigSource =
  | "inbox"
  | "inbox.override.editor"
  | "mobile"
  | "command"
  /** In-chat control command (`/mode`, `/character`, `/team`, …) — `command.<name>`. */
  | `command.${string}`
  /** `setAssignee` synced routing / mode from an assignment (slice 1A). */
  | "assignment"
  /** The SLA escalation sweep applied a `switchMode` step (slice 1B). */
  | "sla-escalation"

/**
 * Persist one conversation configuration section and its audit entry in the
 * same transaction. Operational fields (pin/archive/assignment/read state)
 * intentionally continue through their dedicated CRUD paths.
 */
export async function updateConversationConfigSection(input: {
  adapterId: string
  conversationKey: string
  sessionId?: string
  section: ConversationConfigSection
  patch: Partial<Omit<ConversationOverrideRow, "id" | "conversationKey" | "createdAt">>
  source?: ConversationConfigSource
}): Promise<ConversationOverrideRow> {
  const db = getDb()
  const existing = await readForResolution(input.conversationKey)
  if (!existing && !input.sessionId) {
    throw new Error(
      `conversationOverrides: no row for ${input.conversationKey} and no sessionId to create one`
    )
  }
  const projectId =
    existing?.projectId ?? (await resolveSessionProjectId(input.sessionId as string))
  const now = Date.now()
  const changedKeys = Object.keys(input.patch).sort()
  if (changedKeys.length === 0 && existing) return existing

  return db.transaction("rw", db.conversationOverrides, db.connectorAudit, async () => {
    const latest =
      (await db.conversationOverrides
        .where("conversationKey")
        .equals(input.conversationKey)
        .first()) ?? existing
    const row: ConversationOverrideRow = latest
      ? { ...latest, ...input.patch, updatedAt: now }
      : {
          id: newId(),
          conversationKey: input.conversationKey,
          sessionId: input.sessionId as string,
          projectId,
          ...input.patch,
          createdAt: now,
          updatedAt: now,
        }
    await db.conversationOverrides.put(row)
    await db.connectorAudit.add({
      id: crypto.randomUUID(),
      adapterId: input.adapterId,
      projectId: row.projectId,
      conversationKey: input.conversationKey,
      kind: "override.config_changed",
      at: now,
      fields: {
        scope: "conversation",
        section: input.section,
        changedKeys,
        source: input.source ?? "inbox",
      },
    })
    return row
  })
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
    // Resolving closes the SLA breach window: the escalation chain restarts
    // from step 0 if the conversation later reopens and goes overdue again.
    ...(status === "resolved" ? { escalatedStep: undefined, escalatedAt: undefined } : {}),
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
  /** Free-form provenance (e.g. "manual", "auto-route", "sla-escalation") recorded on the trail. */
  via?: string
  /**
   * Bus-level adapter id for the `override.config_changed` audit row. Falls
   * back to `parseConversationKey(conversationKey).adapterId`; when neither
   * resolves the routing sync still happens but no audit row is written.
   */
  adapterId?: string
}

/**
 * How `setAssignee` synced routing for one assignment transition — recorded
 * on the assignment-trail event as `fields.routing` (slice 1A) so the inbox
 * activity log can say "routing synced" next to Assigned / Unassigned.
 */
export interface AssignmentRoutingSync {
  kind: "character" | "team" | "manual-mode" | "restored"
  characterId?: string
  teamId?: string
  mode?: ConnectorMode | null
}

type AssignmentRoutingSnapshot = NonNullable<ConversationOverrideRow["assignmentPreviousRouting"]>

const ROUTING_SNAPSHOT_KEYS = [
  "characterId",
  "characterDisabled",
  "teamId",
  "teamDisabled",
  "workflowDisabled",
] as const satisfies readonly (keyof AssignmentRoutingSnapshot)[]

/**
 * Patch fragment that drops the assignment ↔ routing marker (slice 1A).
 * Spread into an explicit routing edit (`/character`, `/team`, `/mode`, the
 * override form) so a later unassign no longer restores the pre-assignment
 * routing the operator has since overridden by hand.
 */
export const ASSIGNMENT_ROUTING_MARKER_CLEAR: Pick<
  ConversationOverrideRow,
  "routingSource" | "assignmentPreviousMode" | "assignmentPreviousRouting"
> = {
  routingSource: undefined,
  assignmentPreviousMode: undefined,
  assignmentPreviousRouting: undefined,
}

/**
 * Clear the assignment ↔ routing marker on a conversation (no-op without a
 * row). The assignee itself is untouched — the operator keeps the assignment
 * but has taken over routing explicitly, so unassign will only clear the
 * assignee from now on.
 */
export async function clearAssignmentRoutingMarker(conversationKey: string): Promise<void> {
  const row = await readForResolution(conversationKey)
  if (!row) return
  if (
    row.routingSource === undefined &&
    row.assignmentPreviousMode === undefined &&
    row.assignmentPreviousRouting === undefined
  ) {
    return
  }
  await getDb().conversationOverrides.update(row.id, {
    ...ASSIGNMENT_ROUTING_MARKER_CLEAR,
    updatedAt: Date.now(),
  })
}

function snapshotRouting(row: ConversationOverrideRow): AssignmentRoutingSnapshot {
  const snap: AssignmentRoutingSnapshot = {}
  for (const key of ROUTING_SNAPSHOT_KEYS) {
    if (row[key] !== undefined) (snap as Record<string, unknown>)[key] = row[key]
  }
  return snap
}

function resolveAuditAdapterId(conversationKey: string, explicit?: string): string | undefined {
  if (explicit) return explicit
  try {
    return parseConversationKey(conversationKey).adapterId
  } catch {
    return undefined
  }
}

/**
 * Set or clear the assignee; emits assigned / reassigned / unassigned.
 *
 * Assignment ↔ routing sync (slice 1A) — inside ONE transaction over
 * `conversationOverrides` + `connectorAudit` + `conversationAssignmentEvents`:
 *   - character → `characterId` written, `characterDisabled` sentinel cleared,
 *     `routingSource = "assignment"`; the previous routing fields are
 *     snapshotted ONCE (`assignmentPreviousRouting`) the first time an
 *     assignment writes routing. A later character ⇄ team reassignment
 *     re-applies the snapshot before writing the new target so a stale
 *     `teamId` cannot keep winning over the newly assigned character.
 *   - team → same with `teamId` / `teamDisabled`.
 *   - human → `assignmentPreviousMode = row.mode ?? null`, `mode = "manual"`
 *     (the AI stops auto-replying; routing fields are left alone).
 *   - null (unassign) → while `routingSource === "assignment"` the snapshot is
 *     restored and the marker dropped; while `assignmentPreviousMode` is set
 *     the mode is restored. After `clearAssignmentRoutingMarker` (explicit
 *     routing edit) unassign only clears the assignee.
 * Every routing/mode write is audited as `override.config_changed` with
 * `fields.source = "assignment"` + `changedKeys`; the trail event carries
 * `fields.routing` describing the sync.
 */
export async function setAssignee(
  conversationKey: string,
  assignee: ConversationAssignee | null,
  opts: SetAssigneeOptions = {}
): Promise<void> {
  const db = getDb()
  const ensured = await ensureRow(conversationKey, opts.sessionId)
  const adapterId = resolveAuditAdapterId(conversationKey, opts.adapterId)
  const now = Date.now()

  await db.transaction(
    "rw",
    [db.conversationOverrides, db.connectorAudit, db.conversationAssignmentEvents],
    async () => {
      const row = (await db.conversationOverrides.get(ensured.id)) ?? ensured
      const had = row.assignee
      const patch: Partial<ConversationOverrideRow> = {
        assignee: assignee ?? undefined,
        assigneeKind: assignee?.kind,
        updatedAt: now,
      }
      const routingPatch: Partial<ConversationOverrideRow> = {}
      let routing: AssignmentRoutingSync | undefined

      const restoreMode = (): void => {
        if (row.assignmentPreviousMode === undefined) return
        routingPatch.mode = row.assignmentPreviousMode ?? undefined
        routingPatch.assignmentPreviousMode = undefined
      }
      const restoreRouting = (): void => {
        if (row.routingSource !== "assignment") return
        const snap = row.assignmentPreviousRouting ?? {}
        for (const key of ROUTING_SNAPSHOT_KEYS) {
          ;(routingPatch as Record<string, unknown>)[key] = snap[key]
        }
        routingPatch.routingSource = undefined
        routingPatch.assignmentPreviousRouting = undefined
      }
      const applyTargetRouting = (): void => {
        // Re-apply the snapshot first so a character ⇄ team reassignment
        // starts from the pre-assignment routing, and snapshot ONCE.
        if (row.routingSource === "assignment") {
          const snap = row.assignmentPreviousRouting ?? {}
          for (const key of ROUTING_SNAPSHOT_KEYS) {
            ;(routingPatch as Record<string, unknown>)[key] = snap[key]
          }
          routingPatch.assignmentPreviousRouting = row.assignmentPreviousRouting ?? {}
        } else {
          routingPatch.assignmentPreviousRouting = snapshotRouting(row)
        }
        routingPatch.routingSource = "assignment"
        // A human assignment forced manual mode; handing the conversation to
        // an AI target hands the mode back too.
        restoreMode()
      }

      if (assignee?.kind === "character" && assignee.id) {
        applyTargetRouting()
        routingPatch.characterId = assignee.id
        routingPatch.characterDisabled = undefined
        routing = { kind: "character", characterId: assignee.id }
        if (routingPatch.mode !== undefined || row.assignmentPreviousMode !== undefined) {
          routing.mode = routingPatch.mode ?? null
        }
      } else if (assignee?.kind === "team" && assignee.id) {
        applyTargetRouting()
        routingPatch.teamId = assignee.id
        routingPatch.teamDisabled = undefined
        routing = { kind: "team", teamId: assignee.id }
        if (routingPatch.mode !== undefined || row.assignmentPreviousMode !== undefined) {
          routing.mode = routingPatch.mode ?? null
        }
      } else if (assignee?.kind === "human") {
        if (row.assignmentPreviousMode === undefined) {
          routingPatch.assignmentPreviousMode = row.mode ?? null
        }
        routingPatch.mode = "manual"
        routing = { kind: "manual-mode", mode: "manual" }
      } else if (!assignee) {
        restoreRouting()
        restoreMode()
        if (Object.keys(routingPatch).length > 0) {
          routing = {
            kind: "restored",
            characterId: routingPatch.characterId,
            teamId: routingPatch.teamId,
            ...(row.assignmentPreviousMode !== undefined
              ? { mode: row.assignmentPreviousMode }
              : {}),
          }
        }
      }

      const changedKeys = Object.keys(routingPatch)
        .filter((key) => {
          const before = (row as unknown as Record<string, unknown>)[key]
          const after = (routingPatch as Record<string, unknown>)[key]
          return before !== after
        })
        .sort()

      await db.conversationOverrides.update(row.id, { ...patch, ...routingPatch })

      if (changedKeys.length > 0 && adapterId) {
        await db.connectorAudit.add({
          id: crypto.randomUUID(),
          adapterId,
          projectId: row.projectId,
          conversationKey,
          kind: "override.config_changed",
          at: now,
          fields: {
            scope: "conversation",
            section: "responder",
            changedKeys,
            source: "assignment",
            via: opts.via,
            assigneeKind: assignee?.kind ?? null,
          },
        })
      }

      const kind: AssignmentEventKind = !assignee ? "unassigned" : had ? "reassigned" : "assigned"
      await appendAssignmentEvent({
        conversationKey,
        kind,
        fields: {
          from: had ?? null,
          to: assignee ?? null,
          via: opts.via,
          ...(routing ? { routing } : {}),
        },
      })
    }
  )
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
  const patch: Partial<ConversationOverrideRow> = {
    nextResponseDueAt: undefined,
    // A reply ends the overdue window — reset the escalation chain so the
    // next breach starts again at step 0.
    escalatedStep: undefined,
    escalatedAt: undefined,
    updatedAt: now,
  }
  if (row.firstRespondedAt === undefined) patch.firstRespondedAt = now
  await getDb().conversationOverrides.update(row.id, patch)
}
