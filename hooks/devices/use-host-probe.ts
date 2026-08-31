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
 * `openRemoteHostTarget` was built for exactly this and had no UI caller. It
 * opens an isolated `CompanionTransport` for one host and returns a `close`,
 * leaving `RoutingTransport` untouched. So the console can now answer "what is
 * on that machine?" the way every machine directory does, without the user
 * first having to point their whole desktop at it.
 *
 * The probe is explicit, never automatic. Opening a transport dials a remote
 * server, and doing that to every host in the list the moment the console
 * mounts would turn a read into a fleet-wide connection storm.
 */

import { useCallback, useState } from "react"

import { openRemoteHostTarget } from "@/lib/remote-host/target-transport"
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
  openTarget?: typeof openRemoteHostTarget
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
  const openTarget = deps.openTarget ?? openRemoteHostTarget
  const [entry, setEntry] = useState<ProbeEntry>({ host: hostRef, state: { status: "idle" } })

  // Reset during render rather than in an effect: an effect would paint one
  // frame of the previous host's worktrees under the newly selected host.
  if (entry.host !== hostRef) setEntry({ host: hostRef, state: { status: "idle" } })

  const probe = useCallback(() => {
    if (!hostRef) return
    setEntry({ host: hostRef, state: { status: "probing" } })
    void (async () => {
      let close: (() => void) | undefined
      const settle = (state: HostProbeState) =>
        setEntry((prev) => (prev.host === hostRef ? { host: hostRef, state } : prev))
      try {
        const target = await openTarget(hostRef)
        close = target.close
        const environments = (await target.transport.call(
          "task_workspace_environment_list",
          {}
        )) as WorkspaceEnvironmentSummary[] | null
        settle({ status: "ready", environments: environments ?? [] })
      } catch (cause) {
        settle({ status: "error", message: cause instanceof Error ? cause.message : String(cause) })
      } finally {
        // Always closed, including when the selection moved on mid-flight: an
        // abandoned probe still holds a live connection to a remote machine.
        close?.()
      }
    })()
  }, [hostRef, openTarget])

  return { state: entry.host === hostRef ? entry.state : { status: "idle" }, probe }
}
