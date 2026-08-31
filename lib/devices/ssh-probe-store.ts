"use client"

/**
 * What a Test connection last found out about each saved SSH host.
 *
 * The device console derives its rows from pure inputs, and until now the SSH
 * ones had nothing to derive presence from: nothing pinged a saved host, so
 * `buildSshHostRow` reported `unknown` forever. `lib/terminal/ssh-probe.ts`
 * produces the missing signal, and this is where it lands so the row, the list
 * dot and the card all read the same answer.
 *
 * **Session-scoped and deliberately not persisted**, on the same reasoning as
 * `lib/signaling/wan-wake-overrides.ts`. A probe result is a fact about one
 * moment. Restoring it after a restart would let the console claim a machine
 * was online on the strength of a connection made yesterday, which is the exact
 * dishonesty `reachability: "unknown"` was protecting against in the first
 * place.
 *
 * Staleness is explicit rather than implied. Past {@link SSH_PROBE_TTL_MS} an
 * entry stops answering, and the row falls back to `unknown` instead of showing
 * a result nobody has re-checked. Re-probing is always manual: opening a
 * connection to every saved host because a console mounted would be a
 * fleet-wide connection storm, and each one authenticates and writes an auth
 * log line on the far side.
 *
 * The snapshot identity is stable between changes so `useSyncExternalStore`
 * does not loop.
 */

/**
 * How long a probe result keeps answering.
 *
 * Ten minutes, the same order as the presence signals the console reads for
 * every other machine class, so an SSH row does not go stale on a visibly
 * different clock from the phone next to it.
 */
export const SSH_PROBE_TTL_MS = 10 * 60 * 1000

export interface SshProbeRecord {
  /** Whether the host answered. A refusal is a real `false`, not an absence. */
  online: boolean
  /** When the probe settled, as the epoch millis the row is judged against. */
  at: number
  /** Present only on a reachable answer, since only a connection produces one. */
  fingerprint?: string
  /**
   * The identity the answer describes. A probe result belongs to an address,
   * not to a name: editing a host's port or user in Settings makes the previous
   * answer a statement about a machine the row no longer points at.
   */
  target: string
}

export type SshProbeMap = ReadonlyMap<string, SshProbeRecord>

const EMPTY: SshProbeMap = new Map<string, SshProbeRecord>()

let probes: SshProbeMap = EMPTY
const listeners = new Set<() => void>()

function publish(next: SshProbeMap): void {
  probes = next
  for (const listener of [...listeners]) listener()
}

/**
 * The identity a probe answer is about.
 *
 * Includes the jump host, because reaching a box through a bastion and
 * reaching it direct are different claims: the first can fail while the second
 * succeeds, and a result carried across that edit would report the wrong one.
 */
export function sshProbeTarget(profile: {
  host: string
  port: number
  username: string
  jumpHostId?: string | null
}): string {
  return `${profile.username}@${profile.host}:${profile.port}/${profile.jumpHostId ?? ""}`
}

/** Every recorded probe. Stable by identity until one actually changes. */
export function getSshProbes(): SshProbeMap {
  return probes
}

/**
 * The answer for one host, or `undefined` when there is none that still counts.
 *
 * Returns nothing for an expired entry and for one recorded against a different
 * address, so a caller cannot accidentally render a stale or misattributed
 * result. Both are the same kind of mistake: reporting knowledge nobody has.
 */
export function readSshProbe(
  hostId: string,
  target: string,
  now: number
): SshProbeRecord | undefined {
  const record = probes.get(hostId)
  if (!record) return undefined
  if (record.target !== target) return undefined
  if (now - record.at >= SSH_PROBE_TTL_MS) return undefined
  return record
}

export function recordSshProbe(hostId: string, record: SshProbeRecord): void {
  const next = new Map(probes)
  next.set(hostId, record)
  publish(next)
}

/** Drop one host's answer, for a profile that was deleted or re-pointed. */
export function forgetSshProbe(hostId: string): void {
  if (!probes.has(hostId)) return
  const next = new Map(probes)
  next.delete(hostId)
  publish(next)
}

/** Subscribe to probe changes. Returns the unsubscribe function. */
export function subscribeSshProbes(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Server snapshot for `useSyncExternalStore`.
 *
 * A separate frozen empty map rather than {@link getSshProbes}, so a static
 * export's prerender can never observe a client-side probe and hydrate into a
 * mismatch.
 */
export function getSshProbesServerSnapshot(): SshProbeMap {
  return EMPTY
}

export function resetSshProbesForTests(): void {
  probes = EMPTY
  listeners.clear()
}
