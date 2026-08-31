"use client"

/**
 * Run one Test connection against a saved SSH host, and remember the answer.
 *
 * The same discipline as `hooks/devices/use-host-probe.ts`, for the same
 * reason: the probe is explicit and never automatic. Opening a connection
 * authenticates, writes an auth log line on the far side and on every bastion,
 * and learns the host key on first contact, so doing it to every saved host
 * because a console mounted would be a fleet-wide connection storm with a
 * paper trail to match.
 *
 * The settled answer goes into `lib/devices/ssh-probe-store.ts` rather than
 * staying local, so the row's presence dot, the list and this card cannot
 * disagree about a machine that was just asked.
 */

import { useCallback, useState } from "react"

import { recordSshProbe, sshProbeTarget } from "@/lib/devices/ssh-probe-store"
import { probeSshHost, type SshProbeOutcome } from "@/lib/terminal/ssh-probe"
import type { SshHostProfile } from "@/lib/terminal/ssh-profiles"

export type SshProbeState =
  /** Never asked. The card offers a button. */
  { status: "idle" } | { status: "probing" } | { status: "settled"; outcome: SshProbeOutcome }

export interface UseSshProbeResult {
  state: SshProbeState
  probe: () => void
}

export interface UseSshProbeDeps {
  run?: typeof probeSshHost
  now?: () => number
}

/**
 * State carries the host it describes.
 *
 * The same staleness guard `useHostProbe` uses: every write is a functional
 * update that drops the result unless the entry still belongs to the same
 * host. Probing A, switching to B and probing again would otherwise land A's
 * verdict under B's name whenever A answered second.
 */
interface ProbeEntry {
  hostId: string | null
  state: SshProbeState
}

/**
 * @param profile the selected host, or `null` when the row is not an SSH host
 *   or its profile is no longer saved and there is nothing to probe.
 * @param allProfiles the whole saved set. Required rather than optional for the
 *   same reason the connect path requires it: a jump host is stored as a
 *   profile id, and without the set a bastion-backed host is probed direct.
 */
export function useSshProbe(
  profile: SshHostProfile | null,
  allProfiles: readonly SshHostProfile[],
  deps: UseSshProbeDeps = {}
): UseSshProbeResult {
  const run = deps.run ?? probeSshHost
  const now = deps.now ?? Date.now
  const hostId = profile?.id ?? null
  const [entry, setEntry] = useState<ProbeEntry>({ hostId, state: { status: "idle" } })

  // Reset during render rather than in an effect: an effect would paint one
  // frame of the previous host's verdict under the newly selected host.
  if (entry.hostId !== hostId) setEntry({ hostId, state: { status: "idle" } })

  const probe = useCallback(() => {
    if (!profile) return
    setEntry({ hostId: profile.id, state: { status: "probing" } })
    void (async () => {
      const outcome = await run({ profile, allProfiles })
      /**
       * An `invalid` profile is not a statement about the machine. It says the
       * request could not be built, which the host had no part in, so nothing
       * is recorded and the row keeps saying `unknown`.
       */
      if (outcome.kind !== "invalid") {
        recordSshProbe(profile.id, {
          online: outcome.kind === "reachable",
          at: now(),
          fingerprint: outcome.kind === "reachable" ? outcome.hostKeyFingerprint : undefined,
          target: sshProbeTarget(profile),
        })
      }
      setEntry((prev) =>
        prev.hostId === profile.id
          ? { hostId: profile.id, state: { status: "settled", outcome } }
          : prev
      )
    })()
  }, [allProfiles, now, profile, run])

  return { state: entry.hostId === hostId ? entry.state : { status: "idle" }, probe }
}
