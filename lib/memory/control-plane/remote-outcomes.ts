/**
 * What a paired client does with the host's answer to `memory_mutate`.
 *
 * The outbound queue marks a delivered row sent whatever the host said, because
 * a structured refusal (`{ ok: false, reason }`) is an answer, not a transport
 * failure — retrying it would only be refused again. The answer still matters
 * here, in two ways:
 *
 *   - **Applied:** the mirror already moved, but some effects exist only on
 *     the host (a new row's id, a restored revision, tombstones, recall
 *     counters). One coalesced `memories` pull a moment later brings them.
 *   - **Refused:** nothing changed upstream, so the optimistic mirror write is
 *     now wrong and a delta pull would never correct it. The `memories` cursor
 *     is rewound and re-pulled, and listeners (the toast in the outbound runner
 *     provider) are told why.
 */

import type { ManageMemoryResult } from "./manage"

export type RemoteMemoryRefusalReason = Extract<ManageMemoryResult, { ok: false }>["reason"]

export interface RemoteMemoryRefusal {
  reason: RemoteMemoryRefusalReason
}

type Listener = (refusal: RemoteMemoryRefusal) => void

const listeners = new Set<Listener>()

export function subscribeRemoteMemoryRefusals(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const KNOWN_REASONS: ReadonlySet<string> = new Set<RemoteMemoryRefusalReason>([
  "partial_failure",
  "not_found",
  "disabled",
  "temporary",
  "pii_blocked",
  "policy_denied",
  "scope_denied",
  "idempotency_key_reused",
  "unauthorized_namespace",
])

/** Delay before the follow-up pull, so a burst of commands shares one. */
export const MEMORY_FOLLOW_UP_SYNC_MS = 1_500

export interface SettleDeps {
  rewind: () => void
  pull: () => Promise<unknown>
  schedule: (run: () => void, ms: number) => unknown
  cancel: (handle: unknown) => void
}

let pending: unknown = null

async function defaultDeps(): Promise<SettleDeps> {
  const { rewindSyncTable, runSyncDown } = await import("@/lib/sync/companion-sync")
  return {
    rewind: () => rewindSyncTable("memories"),
    pull: () => runSyncDown({ only: ["memories"] }),
    schedule: (run, ms) => setTimeout(run, ms),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
}

/** Read the host's answer; anything that is not a refusal counts as applied. */
export function remoteMemoryRefusal(result: unknown): RemoteMemoryRefusal | null {
  if (typeof result !== "object" || result === null) return null
  const answer = result as { ok?: unknown; reason?: unknown }
  if (answer.ok !== false) return null
  const reason =
    typeof answer.reason === "string" && KNOWN_REASONS.has(answer.reason)
      ? (answer.reason as RemoteMemoryRefusalReason)
      : "policy_denied"
  return { reason }
}

export async function settleRemoteMemoryMutation(
  result: unknown,
  deps?: SettleDeps
): Promise<void> {
  const resolved = deps ?? (await defaultDeps())
  const refusal = remoteMemoryRefusal(result)
  if (pending !== null) {
    resolved.cancel(pending)
    pending = null
  }
  if (refusal) {
    resolved.rewind()
    for (const listener of listeners) listener(refusal)
    await resolved.pull().catch(() => undefined)
    return
  }
  pending = resolved.schedule(() => {
    pending = null
    void resolved.pull().catch(() => undefined)
  }, MEMORY_FOLLOW_UP_SYNC_MS)
}

/** Test-only: forget a scheduled follow-up pull. */
export function __resetRemoteMemoryOutcomesForTests(): void {
  pending = null
  listeners.clear()
}
