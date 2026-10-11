/**
 * Liveness of remote hosts this desktop is not routing to (ADR-0224 A4).
 *
 * The routed host proves itself on its own connection. Every other paired host,
 * the always-on one above all, used to be judged by the timestamp of its last
 * activation, which stops moving the moment the user goes back to driving
 * locally. The device console then showed a running host as offline, and the
 * ADR-0136 timing authority took the schedule back five minutes later.
 *
 * So each one is asked `host_feature_manifest` over its management channel
 * about once a minute, inside the 90 s window `isPlaceable` trusts a manifest
 * for, and the answer is written to the remote-host store (`recordHostProbe`).
 * A host that does not answer is asked less often, up to every ten minutes, so
 * a laptop that is closed for the night does not cost a connection attempt a
 * minute.
 */

import {
  closeStaleManagementChannels,
  withManagementChannel,
  type ManagementChannelDeps,
} from "@/lib/remote-host/management-channel"
import {
  recordHostProbe,
  useRemoteHostStore,
  type RemoteHost,
  type RemoteHostProbe,
  type RemoteHostState,
} from "@/stores/remote-host/remote-host-store"

/** Inside `DEFAULT_LIVENESS_TTL_MS` (90 s), so a healthy host never lapses. */
export const HOST_LIVENESS_INTERVAL_MS = 60_000
/** Ceiling of the backoff for a host that keeps not answering. */
export const HOST_LIVENESS_MAX_BACKOFF_MS = 10 * 60_000
/**
 * How long one probe may take. Generous because a relay route has to open its
 * room first; a probe that has not answered by then counts as no answer.
 */
export const HOST_PROBE_TIMEOUT_MS = 20_000
/** How often the loop looks for hosts that are due. */
export const HOST_LIVENESS_TICK_MS = 15_000

export interface HostLivenessDeps {
  channel?: ManagementChannelDeps
  now?: () => number
  timeoutMs?: number
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the host did not answer within ${Math.round(ms / 1000)} s`)),
      ms
    )
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** Probe one host now and record the answer. `null` when the host is gone. */
export async function probeHostLiveness(
  hostId: string,
  deps: HostLivenessDeps = {}
): Promise<RemoteHostProbe | null> {
  const now = deps.now ?? Date.now
  try {
    const manifest = await withManagementChannel(
      hostId,
      (lease) =>
        withTimeout(
          lease.transport.call<unknown>("host_feature_manifest", {}),
          deps.timeoutMs ?? HOST_PROBE_TIMEOUT_MS
        ),
      deps.channel
    )
    return recordHostProbe(hostId, { kind: "answered", manifest }, now())
  } catch (error) {
    return recordHostProbe(hostId, { kind: "failed", error }, now())
  }
}

/**
 * The hosts the loop probes: every paired host except the one being routed to
 * (its own connection is the evidence) and revoked ones (a revoked device is
 * refused, so asking again only adds noise to the host's log).
 */
export function hostsToProbe(state: Pick<RemoteHostState, "hosts" | "activeHostId">): RemoteHost[] {
  return state.hosts.filter(
    (host) => host.id !== state.activeHostId && host.connectionState !== "revoked"
  )
}

/**
 * When a host is next due: a minute after a good answer, then doubling after
 * each consecutive miss up to the ceiling.
 */
export function nextProbeDelay(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return HOST_LIVENESS_INTERVAL_MS
  return Math.min(
    HOST_LIVENESS_INTERVAL_MS * 2 ** consecutiveFailures,
    HOST_LIVENESS_MAX_BACKOFF_MS
  )
}

export interface HostLivenessLoopDeps extends HostLivenessDeps {
  probe?: (hostId: string) => Promise<RemoteHostProbe | null>
  tickMs?: number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

/**
 * Probe due hosts until stopped. Returns the stop function.
 *
 * Hosts are probed one at a time per host (a probe still in flight is never
 * doubled) and right away when first seen, so a host paired a moment ago
 * shows its state without waiting a minute.
 */
export function startHostLivenessLoop(deps: HostLivenessLoopDeps = {}): () => void {
  const now = deps.now ?? Date.now
  const probe = deps.probe ?? ((hostId: string) => probeHostLiveness(hostId, deps))
  const schedule = new Map<string, { dueAt: number; failures: number }>()
  const inFlight = new Set<string>()
  let stopped = false

  const tick = () => {
    if (stopped) return
    closeStaleManagementChannels(deps.channel)
    const due = hostsToProbe(useRemoteHostStore.getState())
    const present = new Set(due.map((host) => host.id))
    for (const id of [...schedule.keys()]) if (!present.has(id)) schedule.delete(id)
    const at = now()
    for (const host of due) {
      const entry = schedule.get(host.id) ?? { dueAt: at, failures: 0 }
      schedule.set(host.id, entry)
      if (inFlight.has(host.id) || entry.dueAt > at) continue
      inFlight.add(host.id)
      void probe(host.id)
        .then((result) => {
          const failures = result && !result.ok ? entry.failures + 1 : 0
          schedule.set(host.id, { dueAt: now() + nextProbeDelay(failures), failures })
        })
        .catch(() => {
          const failures = entry.failures + 1
          schedule.set(host.id, { dueAt: now() + nextProbeDelay(failures), failures })
        })
        .finally(() => inFlight.delete(host.id))
    }
  }

  tick()
  const handle = (deps.setInterval ?? setInterval)(tick, deps.tickMs ?? HOST_LIVENESS_TICK_MS)
  return () => {
    stopped = true
    ;(deps.clearInterval ?? clearInterval)(handle as never)
  }
}
