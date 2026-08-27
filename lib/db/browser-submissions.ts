/**
 * Browser Companion submission side-notes — Dexie table `browserSubmissions`
 * (v199).
 *
 * Not the submission itself. The durable record of the work is the
 * `WorkSubmission` ledger plus the session it created; this table is the small
 * amount the side panel needs that neither of those can answer: which browser
 * device sent it, what capture mode the user picked, and which site it came
 * from. Deleting a row here does not delete a Cognia session.
 *
 * Every read is device-scoped. `browser.read-own` is not "read submissions" —
 * it is "read the ones this device made", so a second browser paired to the
 * same Host cannot enumerate the first one's history.
 *
 * Mechanical module — no network, no gating.
 */
import type { BrowserSubmissionStatus } from "@/types/browser-companion"

import type { BrowserSubmissionRow } from "./browser-submissions-types"
import { getDb } from "./schema"

/**
 * How many rows one device keeps.
 *
 * The panel shows 20. Keeping a few multiples of that means a user can scroll
 * back through a week without the table growing without bound on a machine
 * that never opens the extension again.
 */
export const MAX_BROWSER_SUBMISSIONS_PER_DEVICE = 100

export async function getBrowserSubmission(
  submissionId: string
): Promise<BrowserSubmissionRow | undefined> {
  return getDb().browserSubmissions.get(submissionId)
}

/**
 * One device's submissions, newest first.
 *
 * `deviceId` is a parameter rather than an option with a default: a call that
 * forgets it would return every device's history, and a default would make
 * that the easy mistake to make.
 */
export async function listBrowserSubmissions(
  deviceId: string,
  limit = 20
): Promise<BrowserSubmissionRow[]> {
  const rows = await getDb().browserSubmissions.where("deviceId").equals(deviceId).toArray()
  return rows
    .sort(
      (left, right) =>
        right.submittedAt - left.submittedAt || left.submissionId.localeCompare(right.submissionId)
    )
    .slice(0, Math.max(1, limit))
}

/**
 * Record a submission, and trim this device's history to the cap.
 *
 * `put` rather than `add` so a replayed idempotent submission overwrites its
 * own row instead of throwing — the RPC layer replays the original receipt in
 * that case, and a constraint error here would turn a correct replay into a
 * failure.
 */
export async function putBrowserSubmission(row: BrowserSubmissionRow): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.browserSubmissions, async () => {
    await db.browserSubmissions.put(row)
    const existing = await db.browserSubmissions.where("deviceId").equals(row.deviceId).toArray()
    if (existing.length <= MAX_BROWSER_SUBMISSIONS_PER_DEVICE) return
    const doomed = existing
      .sort((left, right) => left.submittedAt - right.submittedAt)
      .slice(0, existing.length - MAX_BROWSER_SUBMISSIONS_PER_DEVICE)
      .map((candidate) => candidate.submissionId)
    await db.browserSubmissions.bulkDelete(doomed)
  })
}

/**
 * Move a submission's status on.
 *
 * A no-op when the row is gone, because the row is a convenience and the run
 * it describes is not: a trimmed-away submission must not resurrect itself as
 * a partial row when its session later completes.
 */
export async function updateBrowserSubmissionStatus(
  submissionId: string,
  status: BrowserSubmissionStatus,
  now: number,
  errorCode?: string
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.browserSubmissions, async () => {
    const existing = await db.browserSubmissions.get(submissionId)
    if (!existing) return
    await db.browserSubmissions.put({
      ...existing,
      status,
      updatedAt: now,
      ...(errorCode ? { errorCode } : {}),
    })
  })
}

/** Forget one device's history — the extension's "clear local data". */
export async function clearBrowserSubmissions(deviceId: string): Promise<number> {
  return getDb().browserSubmissions.where("deviceId").equals(deviceId).delete()
}
