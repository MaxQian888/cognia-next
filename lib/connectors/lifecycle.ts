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
import { getConnectorRuntimeSupervisor } from "@/lib/connectors/runtime-supervisor"

export interface AdapterRuntimeEntry {
  adapter: PlatformAdapter
  abortController: AbortController
  /** Starter the registry calls on `requeueAdapter`. */
  restart: () => Promise<void>
  /** Plugin adapters are lifecycle-managed here but not backed by adapterInstances rows. */
  owner?: "adapter-instance" | "plugin"
}

const entries = new Map<string, AdapterRuntimeEntry>()
interface SuspendedAdapterRuntimeEntry {
  entry: AdapterRuntimeEntry
  stopped: Promise<void>
  cancelled: boolean
  resuming: boolean
}
const suspendedEntries = new Map<string, SuspendedAdapterRuntimeEntry>()

function stopEntry(adapterId: string, entry: AdapterRuntimeEntry): Promise<void> {
  entry.abortController.abort()
  return entry.adapter.stop().catch((err) => {
    console.error(
      `[lifecycle] adapter ${adapterId} failed to stop: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  })
}

export function registerRunningAdapter(adapterId: string, entry: AdapterRuntimeEntry): void {
  entries.set(adapterId, entry)
}

export function unregisterRunningAdapter(adapterId: string): void {
  const suspended = suspendedEntries.get(adapterId)
  if (suspended) {
    suspended.cancelled = true
    suspendedEntries.delete(adapterId)
  }
  const entry = entries.get(adapterId)
  entries.delete(adapterId)
  if (!entry) return
  const managed = getConnectorRuntimeSupervisor().getRunningAdapter(adapterId)
  if (managed?.adapter === entry.adapter) return
  // Stop is best-effort — the caller may already be in teardown.
  void stopEntry(adapterId, entry)
}

export function getRunningAdapter(adapterId: string): AdapterRuntimeEntry | undefined {
  return entries.get(adapterId)
}

export function listRunningAdapters(): AdapterRuntimeEntry[] {
  return Array.from(entries.values())
}

/**
 * Yield transports owned by one subsystem without losing their restart
 * closures. Used when the local connector runtime hands ownership to a remote
 * brain: plugin transports must stop to avoid double-dial, then recover when
 * local ownership returns.
 */
export function suspendRunningAdaptersByOwner(
  owner: NonNullable<AdapterRuntimeEntry["owner"]>
): void {
  const supervisor = getConnectorRuntimeSupervisor()
  void supervisor.suspendOwner(owner)
  for (const [adapterId, entry] of entries) {
    if (entry.owner !== owner) continue
    if (supervisor.hasDefinition(adapterId)) continue
    entries.delete(adapterId)
    suspendedEntries.set(adapterId, {
      entry,
      stopped: stopEntry(adapterId, entry),
      cancelled: false,
      resuming: false,
    })
  }
}

/**
 * Restart transports previously suspended for an owner. Failed restarts stay
 * suspended so the next local-runtime acquisition can retry them.
 */
export async function resumeSuspendedAdaptersByOwner(
  owner: NonNullable<AdapterRuntimeEntry["owner"]>
): Promise<void> {
  await getConnectorRuntimeSupervisor().resumeOwner(owner)
  const candidates = Array.from(suspendedEntries.entries()).filter(
    ([, suspended]) => suspended.entry.owner === owner && !suspended.resuming
  )
  await Promise.all(
    candidates.map(async ([adapterId, suspended]) => {
      suspended.resuming = true
      await suspended.stopped
      if (suspended.cancelled) return
      try {
        await suspended.entry.restart()
        if (suspended.cancelled) {
          unregisterRunningAdapter(adapterId)
          return
        }
        suspendedEntries.delete(adapterId)
      } catch (error) {
        suspended.resuming = false
        console.error(
          `[lifecycle] suspended adapter ${adapterId} failed to resume: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    })
  )
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
  const supervisor = getConnectorRuntimeSupervisor()
  if (supervisor.hasDefinition(adapterId)) {
    await supervisor.restartAdapter(adapterId, "manual_restart")
    const observed = supervisor.getSnapshot(adapterId)?.observedState
    return observed === "running" || observed === "starting" || observed === "degraded"
  }
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
      const supervisor = getConnectorRuntimeSupervisor()
      const present = entries.has(adapterId) || supervisor.hasDefinition(adapterId)
      if (!present) return
      try {
        if (supervisor.hasDefinition(adapterId)) {
          await supervisor.restartAdapter(adapterId, "credentials_rotated")
        } else {
          await requeueAdapter(adapterId)
        }
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
  for (const suspended of suspendedEntries.values()) {
    suspended.cancelled = true
    suspended.entry.abortController.abort()
  }
  entries.clear()
  suspendedEntries.clear()
}
