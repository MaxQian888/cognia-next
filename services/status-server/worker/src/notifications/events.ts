/**
 * Notification events: the immutable, de-duplicated record that something
 * public happened. Incident and maintenance writes insert one in the same
 * guarded batch as the public update; delivery fans each event out to the
 * matching confirmed subscribers later.
 *
 * Event IDs are stable (`incident-update:<updateId>`,
 * `maintenance:<id>:<phase>:<revision>`), and the insert is `OR IGNORE`, so
 * a replayed reconciliation or a retried request never creates a second
 * event, and therefore never a second email.
 */

import type {
  ComponentId,
  IncidentImpact,
  IncidentState,
  LocalizedText,
} from "../../../../../lib/status/contract"
import type { WriteGuard } from "../admin/mutation"

export interface IncidentEventPayload {
  type: "incident"
  phase: "opened" | "updated" | "resolved"
  incidentId: string
  updateId: string
  title: LocalizedText
  message: LocalizedText
  state: IncidentState
  impact: IncidentImpact
  componentIds: ComponentId[]
  atMs: number
}

export interface MaintenanceEventPayload {
  type: "maintenance"
  phase: "scheduled" | "changed" | "started" | "ended"
  /** For `ended`: how the window ended. */
  endKind: "completed" | "cancelled" | null
  maintenanceId: string
  title: LocalizedText
  description: LocalizedText
  message: LocalizedText | null
  componentIds: ComponentId[]
  startsAtMs: number
  endsAtMs: number
  actualEndAtMs: number | null
  revision: number
  atMs: number
}

/** Per-subscriber transactional mail (confirmation, welcome, manage link). */
export interface SubscriberEventPayload {
  type: "subscriber"
  purpose: "confirmation" | "welcome" | "manage_link"
  subscriberId: string
  atMs: number
}

export type NotificationPayload =
  IncidentEventPayload | MaintenanceEventPayload | SubscriberEventPayload

export function incidentEventId(updateId: string): string {
  return `incident-update:${updateId}`
}

export function maintenanceEventId(
  maintenanceId: string,
  phase: MaintenanceEventPayload["phase"],
  revision: number
): string {
  return `maintenance:${maintenanceId}:${phase}:${revision}`
}

/** Component scope of an event; subscriber mail has none. */
export function payloadComponents(payload: NotificationPayload): ComponentId[] | null {
  return payload.type === "subscriber" ? null : payload.componentIds
}

/**
 * Insert an event only if `guard` holds (the parent write committed). Public
 * events start un-fanned-out; subscriber events are created with their one
 * outbox row already in place, so they are born `fanout_done`.
 */
export function guardedEventStatement(
  db: D1Database,
  event: { id: string; payload: NotificationPayload; createdAtMs: number },
  guard: WriteGuard
): D1PreparedStatement {
  const fanoutDone = event.payload.type === "subscriber" ? 1 : 0
  return db
    .prepare(
      `INSERT OR IGNORE INTO notification_events (id, kind, payload_json, created_at, fanout_cursor, fanout_done)
       SELECT ?, ?, ?, ?, NULL, ? WHERE ${guard.sql}`
    )
    .bind(
      event.id,
      eventKind(event.payload),
      JSON.stringify(event.payload),
      event.createdAtMs,
      fanoutDone,
      ...guard.params
    )
}

export function eventKind(payload: NotificationPayload): string {
  switch (payload.type) {
    case "incident":
      return `incident.${payload.phase}`
    case "maintenance":
      return `maintenance.${payload.phase}`
    case "subscriber":
      return `subscriber.${payload.purpose}`
  }
}
