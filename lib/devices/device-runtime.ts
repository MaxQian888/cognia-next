/**
 * What each kind of device can actually tell us about its runtime.
 *
 * The answers are dictated by the transport routing rules in
 * `lib/tauri/transport-routing.ts`, which dispatch on the `target` recorded
 * for each command in `protocol/companion-commands.json` — not by what a
 * device could theoretically do:
 *
 *   * `cua_sandbox_start|stop|health` are `target: "client"` with
 *     `transports: ["internal"]`. They never follow the active remote host, so
 *     **sandbox connections always belong to the machine running this
 *     renderer** and no other row can have any.
 *   * `task_workspace_environment_list` is `target: "execution"`, so it
 *     resolves to `activeRemote ?? local`. Calling it while a Host is active
 *     returns *that Host's* environments. A workspace list is therefore only
 *     ever true of the current routing target, which is why the third state
 *     here is `requires-activation` rather than a flat yes/no.
 *
 * Getting this wrong is not cosmetic: it would print a remote machine's
 * worktrees under the local device's name.
 */

import type {
  DeviceKind,
  DeviceRuntimeSummary,
  DeviceShellTierRow,
  LocalDeviceInput,
} from "./types"
import type { SandboxConnectionRow } from "@/types/sandbox"

export interface DeviceRuntimeInput {
  kind: DeviceKind
  /** Set for `remote-host` rows. */
  hostId?: string
  local: LocalDeviceInput
  sandboxConnections: readonly SandboxConnectionRow[]
  activeHostId: string | null
}

/**
 * Shell tiers this machine can actually execute in.
 *
 * `cua-desktop` is listed and never available. It survives in
 * `SandboxShellTier` for stored values only: the character picker renders its
 * item disabled, `preflightMutableTarget` throws at bind time, and
 * `executeSandbox` throws at call time with host fallback explicitly
 * forbidden. Hiding it would leave a session that still carries the stored
 * value with nothing on screen explaining why it refuses.
 */
export function buildLocalShellTiers(local: LocalDeviceInput): DeviceShellTierRow[] {
  return [
    {
      tier: "os",
      available: local.osSandboxAvailable,
      reasonKey: local.osSandboxAvailable ? undefined : "osBackendUnavailable",
    },
    {
      tier: "microvm",
      available: local.microvmAvailable,
      // The adapter is registered by the E2B plugin on activate. Without it
      // `executeSandbox` raises `microvm-unavailable` and never falls back to
      // the host, so an unregistered adapter is a hard refusal, not a warning.
      reasonKey: local.microvmAvailable ? undefined : "microvmAdapterMissing",
    },
    { tier: "cua-desktop", available: false, reasonKey: "cuaDesktopRetired" },
  ]
}

export function buildDeviceRuntime(input: DeviceRuntimeInput): DeviceRuntimeSummary {
  const routesLocally = input.activeHostId === null

  if (input.kind === "local") {
    return {
      sandbox: { support: "supported", connections: input.sandboxConnections },
      shellTiers: buildLocalShellTiers(input.local),
      workspaces: routesLocally
        ? { support: "supported" }
        : { support: "requires-activation", reasonKey: "routedToRemoteHost" },
      isRoutingTarget: routesLocally,
    }
  }

  if (input.kind === "remote-host") {
    const isRoutingTarget = input.activeHostId !== null && input.activeHostId === input.hostId
    return {
      sandbox: {
        support: "unsupported",
        reasonKey: "sandboxIsClientLocal",
        connections: [],
      },
      // `HOST_FEATURE_IDS` carries no sandbox contract, so a Host's shell tiers
      // are genuinely unknown to us. An empty list plus the reason below says
      // that; inventing a mapping from `workflow.execution` would not.
      shellTiers: [],
      workspaces: isRoutingTarget
        ? { support: "supported" }
        : { support: "requires-activation", reasonKey: "activateToInspect" },
      isRoutingTarget,
    }
  }

  if (input.kind === "paired-device") {
    return {
      sandbox: { support: "unsupported", reasonKey: "sandboxNotHosted", connections: [] },
      shellTiers: [],
      workspaces: { support: "unsupported", reasonKey: "workspaceNotHosted" },
      isRoutingTarget: false,
    }
  }

  return {
    sandbox: { support: "unsupported", reasonKey: "sandboxIsClientLocal", connections: [] },
    shellTiers: [],
    // A worker is reached over Agent RPC for dispatch only; the device routing
    // plane never points at one, so there is no transport to ask.
    workspaces: { support: "unsupported", reasonKey: "workerNoRoutingPlane" },
    isRoutingTarget: false,
  }
}
