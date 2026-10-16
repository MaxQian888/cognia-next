/**
 * Hint each paired browser when one of its submissions changes state
 * (ADR-0228 §4–5).
 *
 * The extension polls on its own, so this is latency, not correctness: a task
 * that finishes while the side panel is closed shows on the toolbar badge, and
 * raises its notification, within a second instead of at the next alarm. The
 * hint carries nothing — the browser reads the list it was always allowed to
 * read.
 *
 * It observes the submission ledger and the latest run of each conversation a
 * submission started, and compares one digest per device. Only devices whose
 * digest moved are hinted, and a failed hint is dropped: the next change, or
 * the browser's own poll, covers it.
 */
import type { BrowserSubmissionRow } from "@/lib/db/browser-submissions-types"

/** One device's view: each submission's id and the state it is in now. */
export type DeviceStatusDigests = Map<string, string>

export interface StatusNotifierDeps {
  /**
   * Re-run `read` whenever what it reads changes, and hand each result to
   * `onResult`. Returns the unsubscribe. Dexie's `liveQuery` in production.
   */
  observe: (
    read: () => Promise<DeviceStatusDigests>,
    onResult: (digests: DeviceStatusDigests) => void
  ) => () => void
  /** All submissions, any device. */
  listSubmissions: () => Promise<BrowserSubmissionRow[]>
  /** The latest run status of each of these conversations. */
  latestRunStatuses: (sessionIds: readonly string[]) => Promise<Map<string, string>>
  notify: (deviceId: string) => Promise<void>
}

/** How long after its last change a submission is still worth watching. */
export const STATUS_WATCH_WINDOW_MS = 24 * 60 * 60 * 1_000

export async function readDeviceStatusDigests(
  deps: Pick<StatusNotifierDeps, "listSubmissions" | "latestRunStatuses">,
  now: number
): Promise<DeviceStatusDigests> {
  const rows = (await deps.listSubmissions()).filter(
    (row) => now - Math.max(row.submittedAt, row.updatedAt) < STATUS_WATCH_WINDOW_MS
  )
  const sessionIds = [...new Set(rows.flatMap((row) => (row.sessionId ? [row.sessionId] : [])))]
  const runs = sessionIds.length > 0 ? await deps.latestRunStatuses(sessionIds) : new Map()
  const perDevice = new Map<string, string[]>()
  for (const row of rows) {
    const live = row.sessionId ? runs.get(row.sessionId) : undefined
    const parts = perDevice.get(row.deviceId) ?? []
    parts.push(`${row.submissionId}:${row.status}:${live ?? "-"}`)
    perDevice.set(row.deviceId, parts)
  }
  const digests: DeviceStatusDigests = new Map()
  for (const [deviceId, parts] of perDevice) digests.set(deviceId, parts.sort().join("|"))
  return digests
}

/** Devices whose digest differs between two observations. */
export function changedDevices(previous: DeviceStatusDigests, next: DeviceStatusDigests): string[] {
  const devices = new Set([...previous.keys(), ...next.keys()])
  return [...devices].filter((deviceId) => previous.get(deviceId) !== next.get(deviceId)).sort()
}

export function startBrowserStatusNotifier(
  deps: StatusNotifierDeps,
  now: () => number = () => Date.now()
): () => void {
  let previous: DeviceStatusDigests | null = null
  return deps.observe(
    () => readDeviceStatusDigests(deps, now()),
    (next) => {
      // The first observation is the baseline, not a change: hinting every
      // browser on every app start would make each one refetch for nothing.
      if (previous) {
        for (const deviceId of changedDevices(previous, next)) {
          void deps.notify(deviceId).catch(() => undefined)
        }
      }
      previous = next
    }
  )
}
