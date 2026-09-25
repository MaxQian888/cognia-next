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

/**
 * How many rows the whole table keeps, across every device.
 *
 * The per-device cap alone does not bound the table: every re-pairing mints a
 * new device id, so a browser paired, reset and paired again for a year leaves
 * a hundred rows behind per identity with nothing ever reading them again.
 */
export const MAX_BROWSER_SUBMISSIONS_TOTAL = 1_000

/**
 * How long a row is kept at all.
 *
 * Ninety days: well past anything the panel's recent list or the append-target
 * catalogue would still offer, and short enough that a side note about a page
 * somebody captured does not outlive their memory of capturing it. The session
 * the row points at is not affected — it lives in Cognia, where the user
 * decides how long it stays.
 */
export const BROWSER_SUBMISSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000

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
 * Record a submission, and apply retention: this device's cap, then the age
 * ceiling and the table-wide cap.
 *
 * `put` rather than `add` so a replayed idempotent submission overwrites its
 * own row instead of throwing — the RPC layer replays the original receipt in
 * that case, and a constraint error here would turn a correct replay into a
 * failure.
 *
 * Retention runs here, in the same transaction, because this is the only
 * writer: a separate sweep would need a schedule, and a Host that is rarely
 * open would rarely run it. The row being written is never pruned by its own
 * write, even when it is old — a redrive rewrites a row with its original
 * `submittedAt`, and deleting it mid-redrive would lose the record the retry
 * exists to finish.
 */
export async function putBrowserSubmission(
  row: BrowserSubmissionRow,
  now: number = Date.now()
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.browserSubmissions, async () => {
    await db.browserSubmissions.put(row)
    const existing = await db.browserSubmissions.where("deviceId").equals(row.deviceId).toArray()
    if (existing.length > MAX_BROWSER_SUBMISSIONS_PER_DEVICE) {
      const doomed = existing
        .sort((left, right) => left.submittedAt - right.submittedAt)
        .slice(0, existing.length - MAX_BROWSER_SUBMISSIONS_PER_DEVICE)
        .map((candidate) => candidate.submissionId)
        .filter((submissionId) => submissionId !== row.submissionId)
      await db.browserSubmissions.bulkDelete(doomed)
    }
    await pruneWithin(db, now, row.submissionId)
  })
}

/**
 * Apply the age ceiling and the table-wide cap, outside of a write.
 *
 * For a Host that has stopped receiving submissions altogether — the one case
 * the prune inside {@link putBrowserSubmission} never reaches. Answers how many
 * rows went.
 */
export async function pruneBrowserSubmissions(now: number = Date.now()): Promise<number> {
  const db = getDb()
  return db.transaction("rw", db.browserSubmissions, () => pruneWithin(db, now))
}

/**
 * The retention rules, inside a transaction the caller already holds.
 *
 * Age first, then count: an old row is gone whatever the count, and the count
 * then only ever has to trim rows that are still inside the window. Both walk
 * the `submittedAt` index, so neither reads the whole table to find the few
 * rows it drops.
 */
async function pruneWithin(
  db: ReturnType<typeof getDb>,
  now: number,
  keep?: string
): Promise<number> {
  const cutoff = now - BROWSER_SUBMISSION_MAX_AGE_MS
  const stale = (await db.browserSubmissions.where("submittedAt").below(cutoff).toArray())
    // A row redriven recently is not stale, whenever it was first submitted.
    .filter((candidate) => Math.max(candidate.submittedAt, candidate.updatedAt) < cutoff)
    .map((candidate) => candidate.submissionId)
    .filter((submissionId) => submissionId !== keep)
  if (stale.length > 0) await db.browserSubmissions.bulkDelete(stale)

  const total = await db.browserSubmissions.count()
  let trimmed = 0
  if (total > MAX_BROWSER_SUBMISSIONS_TOTAL) {
    const oldest = (await db.browserSubmissions
      .orderBy("submittedAt")
      .limit(total - MAX_BROWSER_SUBMISSIONS_TOTAL + 1)
      .primaryKeys()) as string[]
    const doomed = oldest
      .filter((submissionId) => submissionId !== keep)
      .slice(0, total - MAX_BROWSER_SUBMISSIONS_TOTAL)
    await db.browserSubmissions.bulkDelete(doomed)
    trimmed = doomed.length
  }
  return stale.length + trimmed
}

/**
 * Forget one device's history.
 *
 * Called by the Host's own control — Settings → Connectivity → Pairing →
 * Browser Companion → "Clear recorded submissions" — one device at a time.
 * NOT by the extension: its "Clear local data" forgets the panel's cached
 * appearance and last workspace in `chrome.storage.local`, and no RPC lets a
 * browser delete rows here. That is deliberate — a browser device holds
 * `browser.read-own`, not a right to rewrite the Host's record of what it sent.
 */
export async function clearBrowserSubmissions(deviceId: string): Promise<number> {
  return getDb().browserSubmissions.where("deviceId").equals(deviceId).delete()
}

/**
 * What this Host has recorded, in aggregate.
 *
 * Device ids rather than a count alone, because clearing is device-scoped and
 * must stay that way: `clearBrowserSubmissions` is the only delete a person
 * asks for, and a "clear everything" that reached past it would be a second,
 * unscoped delete path sitting next to the one the security model describes.
 * The caller iterates the ids instead. (Retention in `putBrowserSubmission`
 * also deletes, but only by age and count — never by a caller's choice.)
 */
export async function summarizeBrowserSubmissions(): Promise<{
  deviceIds: string[]
  total: number
}> {
  const rows = await getDb().browserSubmissions.toArray()
  return { deviceIds: [...new Set(rows.map((row) => row.deviceId))], total: rows.length }
}
