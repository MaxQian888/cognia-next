/**
 * The management channel to a remote host (ADR-0224 A4).
 *
 * A desktop manages its always-on host without routing to it: status, owned
 * items, approvals, secrets and migration all talk to that one machine while
 * the rest of the app keeps running locally. Each of those panels used to be
 * free to open its own isolated transport with `openRemoteHostTarget`, so a
 * console showing a host's runtime, its liveness and its worktrees dialled the
 * same machine three times.
 *
 * This is the one place they get a connection from. A lease is reference
 * counted per host; the last release starts an idle timer rather than closing
 * at once, so a liveness probe every minute and a panel opened between probes
 * share one connection, and a relay route (which is slow to open) is not torn
 * down and rebuilt each time. Opening never touches the app's routing.
 */

import {
  isPairedHostTargetCurrent,
  openRemoteHostTarget,
  pairedHostIdOf,
  type RemoteHostTarget,
} from "@/lib/remote-host/target-transport"
import type { Transport } from "@/lib/tauri/transport-types"
import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"

/**
 * How long an unused channel stays open. Longer than the liveness interval
 * (`lib/remote-host/liveness.ts`), so a host that is probed every minute
 * keeps one connection instead of reopening it on every probe.
 */
export const MANAGEMENT_CHANNEL_IDLE_MS = 150_000

export interface ManagementChannelLease {
  host: RemoteHost
  transport: Transport
  /** Give the lease back. Idempotent. */
  release: () => void
}

export interface ManagementChannelDeps {
  openTarget?: (hostRef: string) => Promise<RemoteHostTarget>
  idleMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

interface Entry {
  target: Promise<RemoteHostTarget>
  refs: number
  idleTimer: unknown
  closed: boolean
  /** The pairing the connection was opened with, once known. */
  deviceId?: string
}

/**
 * Whether a channel was opened with a pairing the host no longer has. A
 * re-pair replaces the device id and keys; a connection built from the old
 * ones is refused as unauthorized, which a probe would read as a revocation.
 */
function isStale(hostRef: string, entry: Entry): boolean {
  if (entry.deviceId === undefined) return false
  const pairedHostId = pairedHostIdOf(hostRef)
  if (pairedHostId) return !isPairedHostTargetCurrent(pairedHostId, entry.deviceId)
  const host = useRemoteHostStore.getState().hosts.find((candidate) => candidate.id === hostRef)
  return !host || host.config.deviceId !== entry.deviceId
}

const channels = new Map<string, Entry>()

/**
 * The key a host's channel lives under: its `RemoteHost.id`. Callers name a
 * host either way (the console by row id, placement by the stable identity in
 * its manifest), and two keys for one machine would be two connections.
 */
export function managementChannelKey(hostRef: string): string {
  const host = useRemoteHostStore.getState().hosts.find((candidate) => {
    const manifestRef =
      candidate.featureManifest?.schemaVersion === 2
        ? candidate.featureManifest.hostIdentity.id
        : undefined
    return candidate.id === hostRef || manifestRef === hostRef
  })
  return host?.id ?? hostRef
}

function closeEntry(hostRef: string, entry: Entry, deps: ManagementChannelDeps): void {
  if (entry.closed) return
  entry.closed = true
  if (entry.idleTimer !== undefined) (deps.clearTimer ?? clearTimeout)(entry.idleTimer as never)
  if (channels.get(hostRef) === entry) channels.delete(hostRef)
  void entry.target.then((target) => target.close()).catch(() => undefined)
}

/**
 * Lease a connection to a host. The first lease opens it; later ones share it.
 * A failed open is not cached, so the next lease tries again.
 */
export async function acquireManagementChannel(
  ref: string,
  deps: ManagementChannelDeps = {}
): Promise<ManagementChannelLease> {
  const hostRef = managementChannelKey(ref)
  let entry = channels.get(hostRef)
  if (entry && !entry.closed && isStale(hostRef, entry)) {
    closeEntry(hostRef, entry, deps)
    entry = undefined
  }
  if (!entry || entry.closed) {
    const created: Entry = {
      target: (deps.openTarget ?? openRemoteHostTarget)(hostRef),
      refs: 0,
      idleTimer: undefined,
      closed: false,
    }
    channels.set(hostRef, created)
    created.target.then(
      (target) => {
        created.deviceId = target.host.config.deviceId
      },
      () => undefined
    )
    created.target.catch(() => {
      if (channels.get(hostRef) === created) channels.delete(hostRef)
      created.closed = true
    })
    entry = created
  }
  const current = entry
  current.refs += 1
  if (current.idleTimer !== undefined) {
    ;(deps.clearTimer ?? clearTimeout)(current.idleTimer as never)
    current.idleTimer = undefined
  }

  let target: RemoteHostTarget
  try {
    target = await current.target
  } catch (error) {
    current.refs -= 1
    throw error
  }
  if (current.closed) {
    // Closed while it was opening (the host was removed or re-paired).
    current.refs -= 1
    throw new Error(`the management channel to ${target.host.label} was closed`)
  }

  let released = false
  return {
    host: target.host,
    transport: target.transport,
    release: () => {
      if (released) return
      released = true
      current.refs -= 1
      if (current.refs > 0 || current.closed) return
      current.idleTimer = (deps.setTimer ?? setTimeout)(
        () => closeEntry(hostRef, current, deps),
        deps.idleMs ?? MANAGEMENT_CHANNEL_IDLE_MS
      )
    },
  }
}

/** Run one piece of work over a host's channel and give the lease back. */
export async function withManagementChannel<T>(
  hostRef: string,
  work: (lease: ManagementChannelLease) => Promise<T>,
  deps: ManagementChannelDeps = {}
): Promise<T> {
  const lease = await acquireManagementChannel(hostRef, deps)
  try {
    return await work(lease)
  } finally {
    lease.release()
  }
}

/**
 * Close a host's channel now, whatever holds it: the host was removed,
 * re-paired or revoked, and a connection built from its old credentials must
 * not outlive that. Leases still out keep their transport object but it is
 * destroyed; their next call fails and their owner re-acquires.
 */
export function closeManagementChannel(ref: string, deps: ManagementChannelDeps = {}): void {
  const hostRef = managementChannelKey(ref)
  const entry = channels.get(hostRef)
  if (entry) closeEntry(hostRef, entry, deps)
}

/**
 * Close every channel whose host was removed or re-paired since it opened.
 * The liveness loop calls this on each tick, so a connection never outlives
 * the credentials it was built from by more than one tick.
 */
export function closeStaleManagementChannels(deps: ManagementChannelDeps = {}): void {
  const known = new Set(useRemoteHostStore.getState().hosts.map((host) => host.id))
  for (const [hostRef, entry] of [...channels]) {
    if (!known.has(hostRef) || isStale(hostRef, entry)) closeEntry(hostRef, entry, deps)
  }
}

/** Hosts with an open (or opening) channel. */
export function openManagementChannels(): string[] {
  return [...channels.keys()]
}

/** Test-only: drop every channel without waiting for idle timers. */
export function __resetManagementChannelsForTests(): void {
  for (const [hostRef, entry] of [...channels]) closeEntry(hostRef, entry, {})
  channels.clear()
}
