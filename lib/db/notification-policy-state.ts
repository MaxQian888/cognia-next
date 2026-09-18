// Dexie access for Notification V2 policy-state rows (v227).
//
// The durable, replayable evidence the planner commits: a committed decision
// per fact, an open/acknowledged/resolved incident, a pending approval, or an
// escalation marker. `stateKind` is a closed union — the row is never a
// free-form JSON blob, which is what keeps the policy queryable and the
// audit replayable.

import { nanoid } from "nanoid"
import { getDb, type CogniaDB } from "./schema"
import type { NotificationPolicyStateRow } from "@/types/notifications/decision"

export type { NotificationPolicyStateRow }

/** Persist a policy-state row (decision / incident / approval / escalation). */
export async function putPolicyState(
  row: Omit<NotificationPolicyStateRow, "id" | "createdAt" | "updatedAt"> & { id?: string },
  txDb?: CogniaDB
): Promise<NotificationPolicyStateRow> {
  const db = txDb ?? getDb()
  const now = Date.now()
  const next: NotificationPolicyStateRow = {
    ...row,
    id: row.id ?? nanoid(),
    createdAt: now,
    updatedAt: now,
  }
  const run = async (): Promise<NotificationPolicyStateRow> => {
    await db.notificationPolicyState.put(next)
    return next
  }
  if (txDb) return run()
  return db.transaction("rw", db.notificationPolicyState, run)
}

/** The latest policy-state row for a fact+kind — the planner's read. */
export async function getPolicyState(
  scopeKey: string,
  factKey: string,
  stateKind?: NotificationPolicyStateRow["stateKind"]
): Promise<NotificationPolicyStateRow | undefined> {
  const rows = await getDb()
    .notificationPolicyState.where("[scopeKey+factKey]")
    .equals([scopeKey, factKey])
    .toArray()
  const filtered = stateKind ? rows.filter((r) => r.stateKind === stateKind) : rows
  if (filtered.length === 0) return undefined
  return filtered.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
}

/** Open incidents in a scope — the inhibitor's suppression set. */
export async function listOpenIncidents(scopeKey: string): Promise<NotificationPolicyStateRow[]> {
  return getDb()
    .notificationPolicyState.where("scopeKey")
    .equals(scopeKey)
    .filter((r) => r.stateKind === "incident" && r.incident?.state !== "resolved")
    .toArray()
}

/** Patch an incident's lifecycle (open → acknowledged → resolved). */
export async function transitionIncident(
  scopeKey: string,
  factKey: string,
  patch: {
    state: "acknowledged" | "resolved"
    ackedBy?: string
    at?: number
  },
  txDb?: CogniaDB
): Promise<NotificationPolicyStateRow | undefined> {
  const db = txDb ?? getDb()
  const now = Date.now()
  const run = async (): Promise<NotificationPolicyStateRow | undefined> => {
    const rows = await db.notificationPolicyState
      .where("[scopeKey+factKey]")
      .equals([scopeKey, factKey])
      .toArray()
    const row = rows.find((r) => r.stateKind === "incident" && r.incident)
    if (!row?.incident) return undefined
    const at = patch.at ?? now
    const next: NotificationPolicyStateRow = {
      ...row,
      incident: {
        ...row.incident,
        state: patch.state,
        ...(patch.state === "acknowledged"
          ? { acknowledgedAt: at, ...(patch.ackedBy ? { ackedBy: patch.ackedBy } : {}) }
          : { resolvedAt: at }),
      },
      updatedAt: now,
    }
    await db.notificationPolicyState.put(next)
    return next
  }
  if (txDb) return run()
  return db.transaction("rw", db.notificationPolicyState, run)
}
