/**
 * CRUD for `browserRecordings` (v110) — recorded browser flows (ADR-0072).
 *
 * The row IS the domain type: `RecordedFlow` from
 * `lib/browser/recording/protocol.ts` already carries an `id`, the `baseUrl`
 * and `updatedAt` the indexes need, and the step list. Per `CONVENTIONS.md`
 * ("a full domain type already exists → reuse it") there is no separate row
 * shape to keep in sync.
 *
 * Local-only by design: not registered in `lib/sync`. A flow scripts one
 * machine's dev server, so syncing it would push localhost URLs off-device for
 * no benefit. Credentials cannot appear here — the recorder never captures a
 * password's value, only a `secret: true` flag.
 */
import type { RecordedFlow } from "@/lib/browser/recording/protocol"
import { getDb } from "./schema"

export type BrowserRecordingRow = RecordedFlow

/**
 * Flows recorded against `baseUrl`, newest first — what the pane offers for the
 * origin it currently has loaded. This is the only list the UI needs: a flow
 * scripts one origin's dev server, so an unscoped "all flows" list would mix
 * flows that cannot replay against the loaded page.
 */
export async function listRecordingsForBase(baseUrl: string): Promise<BrowserRecordingRow[]> {
  const rows = await getDb().browserRecordings.where("baseUrl").equals(baseUrl).toArray()
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Read one flow by id. The panel loads whole rows straight from
 * {@link listRecordingsForBase}, so this exists as the module's read primitive —
 * it is how the suite asserts that save / rename / delete actually landed,
 * without reaching past this module into `getDb()` (see `CONVENTIONS.md`: these
 * helpers are the supported API).
 */
export async function getRecording(id: string): Promise<BrowserRecordingRow | undefined> {
  return getDb().browserRecordings.get(id)
}

/** Insert or replace a flow wholesale — a flow is only ever written whole. */
export async function saveRecording(flow: BrowserRecordingRow): Promise<void> {
  await getDb().browserRecordings.put(flow)
}

/**
 * Rename a flow. Returns false when the id is unknown, so the caller can tell
 * "renamed" from "the row went away underneath me".
 */
export async function renameRecording(id: string, name: string, now: number): Promise<boolean> {
  const updated = await getDb().browserRecordings.update(id, { name, updatedAt: now })
  return updated > 0
}

export async function deleteRecording(id: string): Promise<void> {
  await getDb().browserRecordings.delete(id)
}
