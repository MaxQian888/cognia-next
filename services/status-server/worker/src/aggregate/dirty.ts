/**
 * Dirty-hour marking. Ingestion, late observations and retroactive
 * maintenance edits mark the hours whose rollups must be rebuilt; the
 * aggregation job rebuilds them and clears a mark only if its sequence did
 * not move meanwhile, so work that arrives during a rebuild is never lost.
 */

import { HOUR_MS, MINUTE_MS } from "../../../../../lib/status/contract"
import { incrementCounterStatement } from "../platform/store"

/** Upper bound on hours one call may mark (a 400-day retroactive edit). */
export const MAX_DIRTY_HOURS_PER_MARK = 400 * 24

export function hoursCovering(fromMinute: number, toMinute: number): number[] {
  if (toMinute <= fromMinute) return []
  const first = Math.floor((fromMinute * MINUTE_MS) / HOUR_MS)
  const last = Math.floor(((toMinute - 1) * MINUTE_MS) / HOUR_MS)
  const count = Math.min(last - first + 1, MAX_DIRTY_HOURS_PER_MARK)
  return Array.from({ length: count }, (_, index) => last - count + 1 + index)
}

/** Statements that bump the dirty sequence and mark the given hours. */
export function markHoursDirtyStatements(
  db: D1Database,
  hours: readonly number[]
): D1PreparedStatement[] {
  if (hours.length === 0) return []
  const statements: D1PreparedStatement[] = [incrementCounterStatement(db, "dirty_seq")]
  for (const hour of hours) {
    statements.push(
      db
        .prepare(
          `INSERT INTO dirty_hours (hour, seq) VALUES (?, (SELECT value FROM counters WHERE name = 'dirty_seq'))
           ON CONFLICT (hour) DO UPDATE SET seq = excluded.seq`
        )
        .bind(hour)
    )
  }
  return statements
}

/**
 * Two statements marking every hour that covers `[fromMinute, toMinute)`,
 * however long the range: a recursive CTE enumerates the hours, so a
 * retroactive edit spanning weeks costs the same as one hour. Append them to
 * the batch that makes the edit, so the edit and its rebuild mark commit
 * together.
 */
export function markMinuteRangeDirtyStatements(
  db: D1Database,
  fromMinute: number,
  toMinute: number
): D1PreparedStatement[] {
  const hours = hoursCovering(fromMinute, toMinute)
  if (hours.length === 0) return []
  return [
    incrementCounterStatement(db, "dirty_seq"),
    db
      .prepare(
        `WITH RECURSIVE span(hour) AS (SELECT ? UNION ALL SELECT hour + 1 FROM span WHERE hour < ?)
         INSERT INTO dirty_hours (hour, seq)
         SELECT hour, (SELECT value FROM counters WHERE name = 'dirty_seq') FROM span WHERE true
         ON CONFLICT (hour) DO UPDATE SET seq = excluded.seq`
      )
      .bind(hours[0], hours[hours.length - 1]),
  ]
}

export async function markMinutesDirty(
  db: D1Database,
  fromMinute: number,
  toMinute: number
): Promise<void> {
  const statements = markMinuteRangeDirtyStatements(db, fromMinute, toMinute)
  if (statements.length > 0) await db.batch(statements)
}
