/**
 * One look at the space, as the foreground poller takes it every 20 s
 * (ADR-0215 phase 2: polling now, a socket in phase 3): where this device
 * stands, and which new devices wait for an approval. A `403 device_revoked`
 * is acted on only through the verified list (`handleRevokedAnswer`).
 */

import type { EnrollmentStatus } from "./enrollment"
import { listIncoming, type IncomingRequest } from "./enrollment/approve"
import type { AccountSyncContext } from "./enrollment/context"
import { handleRevokedAnswer } from "./enrollment/revoked"
import { readEnrollmentStatus } from "./enrollment/status"
import { SyncApiError } from "./sync-api"

export const ACCOUNT_SYNC_POLL_MS = 20_000
export const ACCOUNT_SYNC_MAX_BACKOFF_MS = 5 * 60_000

export type AccountSyncView = { kind: "idle" } | { kind: "signed-out" } | EnrollmentStatus

export interface PollResult {
  view: AccountSyncView
  /** Open requests this device can act on. */
  incoming: IncomingRequest[]
}

export async function pollAccountSync(context: AccountSyncContext | null): Promise<PollResult> {
  if (!context) return { view: { kind: "signed-out" }, incoming: [] }
  const view = await readEnrollmentStatus(context)
  if (view.kind !== "enrolled") return { view, incoming: [] }
  try {
    const incoming = (await listIncoming(context, view.device)).filter((request) => request.open)
    return { view, incoming }
  } catch (error) {
    if (error instanceof SyncApiError && error.code === "device_revoked") {
      const removal = await handleRevokedAnswer(context, view.device)
      if (removal) return { view: { kind: "removed", removal }, incoming: [] }
    }
    throw error
  }
}

/** Requests to announce (new and still waiting for anyone) and ones that ended since the last look. */
export function requestChanges(
  announced: ReadonlySet<string>,
  incoming: readonly IncomingRequest[]
): { added: IncomingRequest[]; ended: string[] } {
  const open = new Set(incoming.map((request) => request.requestId))
  return {
    added: incoming.filter(
      (request) => request.state === "pending" && !announced.has(request.requestId)
    ),
    ended: [...announced].filter((id) => !open.has(id)),
  }
}

/** The wait before the next look: 20 s, doubling after failures up to five minutes. */
export function pollDelayMs(failures: number): number {
  if (failures <= 0) return ACCOUNT_SYNC_POLL_MS
  return Math.min(ACCOUNT_SYNC_MAX_BACKOFF_MS, ACCOUNT_SYNC_POLL_MS * 2 ** failures)
}
