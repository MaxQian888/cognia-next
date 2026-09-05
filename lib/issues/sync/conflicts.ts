/**
 * Sync conflicts as events (spec 2026-09-06, D2).
 *
 * A conflict is a `sync_conflict` event. It is open until a
 * `sync_conflict_resolved` event names it. Both live on the trail, so the
 * conflicts panel needs no table and the phone sees them through the sync
 * it already has. Resolving with the losing side re-applies that value
 * through the normal writers, attributed to the person, so the next
 * reconciliation pushes it (a human decision beats the remote's timestamp).
 */

import { getDb } from "@/lib/db/schema"
import { appendIssueEvent, listIssueEvents } from "@/lib/db/issue-events"
import type { Issue, IssueActor, IssueEvent, IssueSyncField } from "@/types/issues"
import { applyRemoteField, type RemoteFieldValue } from "./apply"

export interface OpenSyncConflict {
  eventId: string
  issueId: string
  ts: number
  provider: string
  field: IssueSyncField
  winner: "local" | "remote"
  localValue: unknown
  remoteValue: unknown
}

function toOpenConflict(event: IssueEvent): OpenSyncConflict | null {
  if (event.payload.kind !== "sync_conflict") return null
  return {
    eventId: event.id,
    issueId: event.issueId,
    ts: event.ts,
    provider: event.payload.provider,
    field: event.payload.field,
    winner: event.payload.winner,
    localValue: event.payload.localValue,
    remoteValue: event.payload.remoteValue,
  }
}

/** Open conflicts of one issue, oldest first. */
export async function listOpenSyncConflicts(issueId: string): Promise<OpenSyncConflict[]> {
  const events = await listIssueEvents({ issueId })
  return openFrom(events)
}

/** Open conflicts across every issue of a workspace, oldest first. */
export async function listWorkspaceSyncConflicts(projectId: string): Promise<OpenSyncConflict[]> {
  const db = getDb()
  const issueIds = new Set(
    (await db.issues.where("projectId").equals(projectId).primaryKeys()) as string[]
  )
  const events = await db.issueEvents
    .where("kind")
    .anyOf("sync_conflict", "sync_conflict_resolved")
    .toArray()
  return openFrom(events.filter((event) => issueIds.has(event.issueId))).sort((a, b) => a.ts - b.ts)
}

function openFrom(events: readonly IssueEvent[]): OpenSyncConflict[] {
  const resolved = new Set<string>()
  for (const event of events) {
    if (event.payload.kind === "sync_conflict_resolved") resolved.add(event.payload.conflictEventId)
  }
  return events
    .map(toOpenConflict)
    .filter(
      (conflict): conflict is OpenSyncConflict =>
        conflict !== null && !resolved.has(conflict.eventId)
    )
}

/**
 * Close a conflict. `kept` names the side whose value should stand. When it
 * differs from the winner recorded on the event, the other side's value is
 * written through the normal writers as the person's own edit.
 */
export async function resolveSyncConflict(
  conflict: OpenSyncConflict,
  kept: "local" | "remote",
  by: IssueActor
): Promise<void> {
  const db = getDb()
  const issue = await db.issues.get(conflict.issueId)
  if (!issue) return
  if (kept !== conflict.winner) {
    const value = (
      kept === "local" ? conflict.localValue : conflict.remoteValue
    ) as RemoteFieldValue
    await applyRemoteField(issue as Issue, conflict.field, value, by, { record: false })
  }
  await appendIssueEvent({
    issueId: conflict.issueId,
    payload: { kind: "sync_conflict_resolved", conflictEventId: conflict.eventId, kept, by },
  })
}
