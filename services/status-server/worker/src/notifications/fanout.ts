/**
 * Event fan-out: turn each public notification event into one outbox row
 * per matching confirmed subscriber, a bounded slice per run.
 *
 * Matching: the subscriber is confirmed, confirmed no later than the event
 * (a new subscriber is not mailed about events from before it joined), and
 * its component filter intersects the event's scope (an empty filter means
 * every component). Subscribers are walked in ID order behind a cursor
 * stored on the event; the cursor advance commits in the same batch as the
 * rows it covers, and the outbox unique key makes a replay a no-op, so a
 * crash between runs neither skips nor duplicates anyone.
 *
 * An event older than `FANOUT_MAX_AGE_MS` that was never fanned out (mail
 * was switched off, or delivery was down for a day) is closed without mail:
 * a day-old incident update arriving now would mislead more than inform.
 */

import { HOUR_MS, type ComponentId } from "../../../../../lib/status/contract"
import { parseJsonColumn } from "../incidents/ids"
import { leaseGuard } from "../platform/lease"
import { logEvent } from "../platform/http"
import type { JobContext } from "../seams"
import type { NotificationPayload } from "./events"
import { fanoutRowStatements } from "./outbox"

export const FANOUT_MAX_AGE_MS = 24 * HOUR_MS
export const FANOUT_EVENTS_PER_RUN = 10
export const FANOUT_SUBSCRIBERS_PER_SLICE = 50
export const FANOUT_ROWS_PER_RUN = 200

interface EventRow {
  id: string
  payload_json: string
  created_at: number
  fanout_cursor: string | null
}

interface CandidateRow {
  id: string
  locale: "en" | "zh-CN"
  component_ids_json: string
  consent_version: number
  preference_revision: number
}

export function matchesScope(
  filter: readonly ComponentId[],
  scope: readonly ComponentId[]
): boolean {
  return filter.length === 0 || filter.some((id) => scope.includes(id))
}

/** Returns how many outbox rows the run attempted to create. */
export async function fanOutEvents(job: JobContext): Promise<number> {
  const db = job.env.DB
  const events = await db
    .prepare(
      `SELECT id, payload_json, created_at, fanout_cursor FROM notification_events
       WHERE fanout_done = 0 ORDER BY created_at ASC, id ASC LIMIT ?`
    )
    .bind(FANOUT_EVENTS_PER_RUN)
    .all<EventRow>()
  let created = 0
  for (const event of events.results) {
    if (created >= FANOUT_ROWS_PER_RUN) break
    const guard = leaseGuard(job.lease, job.nowMs)
    const payload = parseJsonColumn<NotificationPayload>(
      event.payload_json,
      "notification_events.payload_json"
    )
    if (payload.type === "subscriber" || job.nowMs - event.created_at > FANOUT_MAX_AGE_MS) {
      await db
        .prepare(`UPDATE notification_events SET fanout_done = 1 WHERE id = ? AND ${guard.sql}`)
        .bind(event.id, ...guard.params)
        .run()
      if (payload.type !== "subscriber") {
        logEvent("notification.fanout_expired", { eventId: event.id })
      }
      continue
    }
    const cursor = event.fanout_cursor ?? ""
    const candidates = await db
      .prepare(
        `SELECT id, locale, component_ids_json, consent_version, preference_revision FROM subscribers
         WHERE state = 'confirmed' AND confirmed_at <= ? AND id > ? ORDER BY id ASC LIMIT ?`
      )
      .bind(event.created_at, cursor, FANOUT_SUBSCRIBERS_PER_SLICE)
      .all<CandidateRow>()
    const statements: D1PreparedStatement[] = []
    for (const candidate of candidates.results) {
      const filter = parseJsonColumn<ComponentId[]>(
        candidate.component_ids_json,
        "subscribers.component_ids_json"
      )
      if (!matchesScope(filter, payload.componentIds)) continue
      statements.push(
        ...(await fanoutRowStatements(
          db,
          job.env,
          {
            eventId: event.id,
            payload,
            subscriber: {
              id: candidate.id,
              locale: candidate.locale,
              consentVersion: candidate.consent_version,
              preferenceRevision: candidate.preference_revision,
            },
            nowMs: job.nowMs,
          },
          guard
        ))
      )
      created += 1
    }
    const last = candidates.results[candidates.results.length - 1]
    const done = candidates.results.length < FANOUT_SUBSCRIBERS_PER_SLICE
    statements.push(
      db
        .prepare(
          `UPDATE notification_events SET fanout_cursor = ?, fanout_done = ? WHERE id = ? AND ${guard.sql}`
        )
        .bind(last ? last.id : event.fanout_cursor, done ? 1 : 0, event.id, ...guard.params)
    )
    await db.batch(statements)
  }
  return created
}
