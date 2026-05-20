/**
 * Singleton registry of running adapters (im-refactored-crayon).
 *
 * The provider populates this map as each adapter completes `start()` so
 * the Health Tab's "Reconnect now" button can call `requeueAdapter(id)`
 * without juggling React refs across distant components.
 *
 * The entry holds the adapter handle, the abort signal that gates the
 * inbound transport, and the heartbeat disposer. `requeueAdapter` ends
 * the entry (stop + dispose heartbeat) and re-runs a starter function
 * the provider hands in. All operations are best-effort: a failing
 * stop() must not block a restart attempt.
 */

import type { PlatformAdapter } from "@/types/connectors/adapter"
import type { HeartbeatHandle } from "@/lib/connectors/health/heartbeat"

export interface AdapterRuntimeEntry {
  adapter: PlatformAdapter
  heartbeat: HeartbeatHandle
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
  entry.heartbeat.dispose()
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
 * The current entry's resources (heartbeat, abort signal, transport)
 * are torn down first. The provider-supplied `restart` callback then
 * builds a fresh entry and re-registers it.
 */
export async function requeueAdapter(adapterId: string): Promise<boolean> {
  const entry = entries.get(adapterId)
  if (!entry) return false
  const restart = entry.restart
  unregisterRunningAdapter(adapterId)
  await restart()
  return true
}

/** Test helper — clears all entries (production code must not call this). */
export function __resetLifecycleForTesting(): void {
  for (const entry of entries.values()) {
    entry.heartbeat.dispose()
    entry.abortController.abort()
  }
  entries.clear()
}
