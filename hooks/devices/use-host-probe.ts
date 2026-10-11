"use client"

/**
 * Read a remote Host without making it the app's execution target.
 *
 * `task_workspace_environment_list` is `target: "execution"`, so it follows
 * whichever host global routing points at. That is why the console could only
 * offer an "Activate" button for an inactive Host: listing its worktrees any
 * other way would have printed one machine's directories under another
 * machine's name.
 *
 * It reads through the host's management channel (ADR-0224 A4,
 * `lib/remote-host/management-channel.ts`): an isolated connection to that one
 * host, shared with the liveness probe and the other host panels, leaving
 * `RoutingTransport` untouched. So the console can answer "what is on that
 * machine?" the way every machine directory does, without the user first
 * having to point their whole desktop at it.
 *
 * The probe is explicit, never automatic. Listing worktrees is a real read on
 * the remote machine, and doing it for every host in the list the moment the
 * console mounts would turn browsing into a fleet-wide sweep.
 */

import { useCallback, useState } from "react"

import { useManagementChannel } from "@/hooks/remote-host/use-management-channel"
import type { ManagementChannelLease } from "@/lib/remote-host/management-channel"
import type { WorkspaceEnvironmentSummary } from "@/lib/task-workspace/types"

export type HostProbeState =
  /** Never asked. The console offers a button. */
  | { status: "idle" }
  | { status: "probing" }
  | { status: "ready"; environments: readonly WorkspaceEnvironmentSummary[] }
  /**
   * The host refused or could not be reached. Carried verbatim: "could not
   * reach it" and "it refused this device" need different fixes, and the
   * message is the only thing that distinguishes them here.
   */
  | { status: "error"; message: string }

export interface UseHostProbeResult {
  state: HostProbeState
  probe: () => void
}

export interface UseHostProbeDeps {
  acquire?: (hostRef: string) => Promise<ManagementChannelLease>
}

/**
 * State carries the host it describes.
 *
 * That pairing is the staleness guard: every write is a functional update that
 * drops the result unless the entry still belongs to the same host. Probing
 * host A, switching to B and probing again would otherwise land A's worktrees
 * under B's name whenever A answered second.
 */
interface ProbeEntry {
  host: string | null
  state: HostProbeState
}

/**
 * @param hostRef the `RemoteHost.id`, or `null` when the selected row is not
 *   an inactive remote host and nothing should be probed.
 */
export function useHostProbe(
  hostRef: string | null,
  deps: UseHostProbeDeps = {}
): UseHostProbeResult {
  const { call } = useManagementChannel(hostRef, deps)
  const [entry, setEntry] = useState<ProbeEntry>({ host: hostRef, state: { status: "idle" } })

  // Reset during render rather than in an effect: an effect would paint one
  // frame of the previous host's worktrees under the newly selected host.
  if (entry.host !== hostRef) setEntry({ host: hostRef, state: { status: "idle" } })

  const probe = useCallback(() => {
    if (!hostRef) return
    setEntry({ host: hostRef, state: { status: "probing" } })
    void (async () => {
      const settle = (state: HostProbeState) =>
        setEntry((prev) => (prev.host === hostRef ? { host: hostRef, state } : prev))
      try {
        // The lease is given back inside `call`, including when the selection
        // moved on mid-flight: one nobody releases keeps the channel open.
        const environments = await call<WorkspaceEnvironmentSummary[] | null>(
          "task_workspace_environment_list",
          {}
        )
        settle({ status: "ready", environments: environments ?? [] })
      } catch (cause) {
        settle({ status: "error", message: cause instanceof Error ? cause.message : String(cause) })
      }
    })()
  }, [hostRef, call])

  return { state: entry.host === hostRef ? entry.state : { status: "idle" }, probe }
}
