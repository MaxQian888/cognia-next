/**
 * Singleton registry of running adapters (im-refactored-crayon).
 *
 * The provider populates this map as each adapter completes `start()` so
 * the Health Tab's "Reconnect now" button can call `requeueAdapter(id)`
 * without juggling React refs across distant components.
 *
 * The entry holds the adapter handle and the abort signal that gates the
 * inbound transport. Heartbeats are driven by a single bus-scope sweep
 * (v51, `health/heartbeat-sweep.ts`), not per entry. `requeueAdapter` ends
 * the entry (stop + abort) and re-runs a starter function the provider
 * hands in. All operations are best-effort: a failing stop() must not
 * block a restart attempt.
 */

import type { PlatformAdapter } from "@/types/connectors/adapter"
import { onCredentialsRotated } from "@/lib/connectors/credentials-events"
import { appendAudit } from "@/lib/connectors/audit"

export interface AdapterRuntimeEntry {
  adapter: PlatformAdapter
  abortController: AbortController
  /** Starter the registry calls on `requeueAdapter`. */
  restart: () => Promise<void>
}

const entries = new Map<string, AdapterRuntimeEntry>()

export function registerRunningAdapter(adapterId: string, entry: AdapterRuntimeEntry): void {
  entries.set(adapterId, entry)
}

export function unregisterRunningAdapter(adapterId: string): void {
  const entry = entries.get(adapterId)
  entries.delete(adapterId)
  if (!entry) return
  entry.abortController.abort()
  // Stop is best-effort — the caller may already be in teardown — but
  // log on rejection so operators see why a transport is leaking.
  void entry.adapter.stop().catch((err) => {
    console.error(
      `[lifecycle] adapter ${adapterId} failed to stop: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  })
}

export function getRunningAdapter(adapterId: string): AdapterRuntimeEntry | undefined {
  return entries.get(adapterId)
}

export function listRunningAdapters(): AdapterRuntimeEntry[] {
  return Array.from(entries.values())
}

/**
 * Stop + restart a single adapter. Returns true on success, false if
 * the adapter was not in the registry. Used by the Health Tab's
 * "Reconnect now" affordance.
 *
 * The current entry's resources (abort signal, transport) are torn down
 * first. The provider-supplied `restart` callback then builds a fresh entry,
 * re-registers it, and fires an immediate heartbeat (v51; heartbeats are no
 * longer owned per entry — the bus-scope sweep drives the periodic ones).
 */
export async function requeueAdapter(adapterId: string): Promise<boolean> {
  const entry = entries.get(adapterId)
  if (!entry) return false
  const restart = entry.restart
  unregisterRunningAdapter(adapterId)
  try {
    await restart()
    return true
  } catch (err) {
    // A transient restart failure (network blip right after OS wake is the
    // common case) must not permanently drop the adapter: with no registry
    // entry, later credential rotations no-op and the resume-reconnect
    // sweep can't see it. One bounded in-place retry, then re-register the
    // stale entry as a placeholder — its transport is stopped and signal
    // aborted, but its `restart` closure stays valid, so the next sweep or
    // "Reconnect now" click can retry instead of requiring an app restart.
    try {
      await restart()
      return true
    } catch (retryErr) {
      if (!entries.has(adapterId)) entries.set(adapterId, entry)
      console.error(
        `[lifecycle] adapter ${adapterId} restart failed twice (${
          err instanceof Error ? err.message : String(err)
        }); placeholder re-registered for a later retry:`,
        retryErr instanceof Error ? retryErr.message : String(retryErr)
      )
      return false
    }
  }
}

/**
 * Subscribe lifecycle to `credentials:rotated` so a Settings save
 * automatically re-queues the affected adapter against the new keyring
 * material. The handler is idempotent: if the adapter is not currently
 * registered (disabled / not yet started), the event is a no-op.
 *
 * The audit row distinguishes credential-driven requeues from manual
 * "Reconnect now" clicks so operators in the Audit tab can tell the
 * source apart.
 *
 * Call once from the bus runtime bootstrap (`initConnectorBusRuntime`).
 * Returns an unsubscribe handle for tests.
 */
export function subscribeCredentialsRotatedToLifecycle(): () => void {
  return onCredentialsRotated(({ adapterId, rotatedAt }) => {
    void (async () => {
      const present = entries.has(adapterId)
      if (!present) return
      try {
        await requeueAdapter(adapterId)
        await appendAudit({
          id: crypto.randomUUID(),
          adapterId,
          kind: "adapter.credentials_rotated",
          at: rotatedAt,
          fields: { via: "settings_save" },
        })
      } catch (err) {
        console.error(
          `[lifecycle] credentials_rotated requeue failed for ${adapterId}:`,
          err instanceof Error ? err.message : String(err)
        )
      }
    })()
  })
}

/** Test helper — clears all entries (production code must not call this). */
export function __resetLifecycleForTesting(): void {
  for (const entry of entries.values()) {
    entry.abortController.abort()
  }
  entries.clear()
}
