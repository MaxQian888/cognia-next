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

/** Forget one device's history — the extension's "clear local data". */
export async function clearBrowserSubmissions(deviceId: string): Promise<number> {
  return getDb().browserSubmissions.where("deviceId").equals(deviceId).delete()
}

/**
 * What this Host has recorded, in aggregate.
 *
 * Device ids rather than a count alone, because clearing is device-scoped and
 * must stay that way: `clearBrowserSubmissions` is the only writer that deletes
 * from this table, and a "clear everything" that reached past it would be a
 * second, unscoped delete path sitting next to the one the security model
 * describes. The caller iterates the ids instead.
 */
export async function summarizeBrowserSubmissions(): Promise<{
  deviceIds: string[]
  total: number
}> {
  const rows = await getDb().browserSubmissions.toArray()
  return { deviceIds: [...new Set(rows.map((row) => row.deviceId))], total: rows.length }
}
