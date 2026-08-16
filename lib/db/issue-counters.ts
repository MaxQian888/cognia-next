/**
 * Monotonic issue-number allocation — Dexie table `issueCounters` (v170).
 *
 * This repo had NO sequential-identifier precedent before the tracker: every
 * primary key is an opaque nanoid/uuid, and the only counters that existed
 * were in-memory and session-scoped. So this is built from scratch, and the
 * only durable atomicity primitive available is a Dexie `rw` transaction.
 *
 * That transaction is not optional. A read-modify-write outside one collides
 * the moment the app is open in two windows/tabs (or a desktop window plus the
 * pet popup), handing two different issues the same `MERC-4`. The identifier
 * is denormalized onto the issue row and shared into commits and chat, so a
 * duplicate is effectively unrecoverable.
 *
 * Callers inside a larger `rw` transaction get transaction nesting for free
 * provided `issueCounters` is in their scope — Dexie joins the parent rather
 * than opening a second one.
 */

import type { IssueCounter } from "@/types/issues"
import { getDb } from "./schema"

/**
 * Hand out the next number for an issue-project, creating the counter on
 * first use. Numbers start at 1 and are never reused, including after the
 * issue holding a number is deleted — identifiers must stay stable references.
 */
export async function allocateIssueNumber(issueProjectId: string): Promise<number> {
  const db = getDb()
  return db.transaction("rw", db.issueCounters, async () => {
    const existing = await db.issueCounters.get(issueProjectId)
    const next = existing?.next ?? 1
    const row: IssueCounter = { scopeId: issueProjectId, next: next + 1 }
    await db.issueCounters.put(row)
    return next
  })
}

/** Current watermark without consuming it — for "next issue will be KEY-N" hints. */
export async function peekIssueNumber(issueProjectId: string): Promise<number> {
  const existing = await getDb().issueCounters.get(issueProjectId)
  return existing?.next ?? 1
}

/**
 * Raise the watermark so it sits above `observed`. Used when importing issues
 * that already carry numbers (a restored backup, or a future GitHub adoption
 * path) so subsequent local allocations cannot collide with them.
 */
export async function ensureIssueNumberAbove(
  issueProjectId: string,
  observed: number
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.issueCounters, async () => {
    const existing = await db.issueCounters.get(issueProjectId)
    const current = existing?.next ?? 1
    if (current > observed) return
    await db.issueCounters.put({ scopeId: issueProjectId, next: observed + 1 })
  })
}

/** Drop a project's counter. Only called when the project itself is deleted. */
export async function deleteIssueCounter(issueProjectId: string): Promise<void> {
  await getDb().issueCounters.delete(issueProjectId)
}
