/**
 * An always-on host's headless runtimes, from a device that manages it
 * (ADR-0059 W2).
 *
 * The host's brain starts each runtime (connectors, sync sources, schedulers,
 * plugins…) on its own, and one that fails to start leaves the rest running.
 * This reads which ones are up and restarts one by name, over the host's
 * management channel like the rest of its device page (ADR-0224 A6).
 */

import {
  withManagementChannel,
  type ManagementChannelDeps,
} from "@/lib/remote-host/management-channel"

export type HostRuntimeState = "running" | "failed" | "restarting"

/** One runtime, as `lib/headless/bootstrap.ts` reports it. */
export interface HostRuntime {
  name: string
  state: HostRuntimeState
  /** Older hosts omit this and retain optional/degraded behavior. */
  criticality?: "required" | "optional"
  /** Why its last start, or the teardown of a restart, failed. */
  error?: string
  /** Whether a restart can act on it now. */
  restartable: boolean
  restarts: number
  /** When it last started (epoch ms). */
  startedAt?: number
}

/** `host_runtime_status` and `host_runtime_restart`. */
export interface HostRuntimes {
  runtimes: HostRuntime[]
  /** The runtime a restart acted on, as it is afterwards. */
  runtime?: HostRuntime
}

export type HostRuntimesUnavailableReason =
  /** The host is older than runtime control: it does not know the command. */
  | "outdated"
  /** The host is a desktop app; its runtimes live in its window. */
  | "not-headless"

/** The host cannot report its runtimes at all, and why. */
export class HostRuntimesUnavailableError extends Error {
  constructor(readonly reason: HostRuntimesUnavailableReason) {
    super(`host runtimes unavailable: ${reason}`)
    this.name = "HostRuntimesUnavailableError"
  }
}

export interface HostRuntimesDeps {
  channel?: ManagementChannelDeps
}

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code
}

async function call(
  hostRef: string,
  name: string,
  args: Record<string, unknown>,
  deps: HostRuntimesDeps
): Promise<HostRuntimes> {
  try {
    return await withManagementChannel(
      hostRef,
      (lease) => lease.transport.call<HostRuntimes>(name, args),
      deps.channel
    )
  } catch (error) {
    const code = codeOf(error)
    if (code === "unknown_command") throw new HostRuntimesUnavailableError("outdated")
    if (code === "headless_host_required") throw new HostRuntimesUnavailableError("not-headless")
    throw error
  }
}

export function readHostRuntimes(hostRef: string, deps: HostRuntimesDeps = {}) {
  return call(hostRef, "host_runtime_status", {}, deps)
}

/** Restart one runtime: a failed one starts again, a running one is stopped first. */
export function restartHostRuntime(hostRef: string, name: string, deps: HostRuntimesDeps = {}) {
  return call(hostRef, "host_runtime_restart", { name }, deps)
}

/** The runtimes that failed to start, in the host's order. */
export function failedHostRuntimes(runtimes: readonly HostRuntime[]): HostRuntime[] {
  return runtimes.filter((runtime) => runtime.state === "failed")
}
