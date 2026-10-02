/**
 * Bounded job leases with monotonic fences.
 *
 * Aggregation, reconciliation, delivery and retention each take their own
 * lease row. Acquiring is one conditional UPDATE that increments the fence;
 * every committing write of the job appends `leaseGuard()` to its WHERE
 * clause (or runs the guard statement first in the same batch), so a runner
 * that lost its lease to expiry cannot publish a snapshot or mark mail sent.
 */

export interface JobLease {
  job: string
  owner: string
  fence: number
  expiresAtMs: number
}

export const DEFAULT_LEASE_MS = 50_000

export async function acquireLease(
  db: D1Database,
  job: string,
  nowMs: number,
  durationMs = DEFAULT_LEASE_MS
): Promise<JobLease | null> {
  const owner = crypto.randomUUID()
  const expiresAtMs = nowMs + durationMs
  // Insert the row for a job the migrations did not seed (a new job kind).
  await db.prepare("INSERT OR IGNORE INTO leases (job) VALUES (?)").bind(job).run()
  const row = await db
    .prepare(
      `UPDATE leases SET owner = ?, fence = fence + 1, expires_at = ?
       WHERE job = ? AND (owner IS NULL OR expires_at <= ?)
       RETURNING fence`
    )
    .bind(owner, expiresAtMs, job, nowMs)
    .first<{ fence: number }>()
  return row ? { job, owner, fence: row.fence, expiresAtMs } : null
}

/** Release only if still held; a stale owner's release is a no-op. */
export async function releaseLease(db: D1Database, lease: JobLease): Promise<void> {
  await db
    .prepare(
      "UPDATE leases SET owner = NULL, expires_at = 0 WHERE job = ? AND owner = ? AND fence = ?"
    )
    .bind(lease.job, lease.owner, lease.fence)
    .run()
}

/**
 * SQL predicate that is true only while this lease is still held. Append to
 * the WHERE clause of every committing statement:
 *
 *   `UPDATE x SET ... WHERE id = ? AND ${guard.sql}` with `...guard.params`.
 */
export function leaseGuard(lease: JobLease, nowMs: number): { sql: string; params: unknown[] } {
  return {
    sql: "EXISTS (SELECT 1 FROM leases WHERE job = ? AND owner = ? AND fence = ? AND expires_at > ?)",
    params: [lease.job, lease.owner, lease.fence, nowMs],
  }
}

/** True while the lease is still held (for read-then-write decisions). */
export async function leaseHeld(db: D1Database, lease: JobLease, nowMs: number): Promise<boolean> {
  const guard = leaseGuard(lease, nowMs)
  const row = await db
    .prepare(`SELECT ${guard.sql} AS held`)
    .bind(...guard.params)
    .first<{ held: number }>()
  return row?.held === 1
}

/**
 * Run `work` under a lease; returns null when another runner holds it.
 * The lease is released afterwards even if `work` throws.
 */
export async function withLease<T>(
  db: D1Database,
  job: string,
  nowMs: number,
  work: (lease: JobLease) => Promise<T>,
  durationMs = DEFAULT_LEASE_MS
): Promise<T | null> {
  const lease = await acquireLease(db, job, nowMs, durationMs)
  if (!lease) return null
  try {
    return await work(lease)
  } finally {
    await releaseLease(db, lease)
  }
}
