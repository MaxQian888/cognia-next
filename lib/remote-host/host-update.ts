/**
 * An always-on host's own updates, from a device that manages it (ADR-0224
 * A10).
 *
 * The host checks the signed catalog itself, waits until nothing would be cut
 * off, swaps its server and brain together and proves the new version or
 * rolls back. This device reads that state, changes the channel and
 * auto-update, and asks for an update now. Every call goes over the host's
 * management channel and works across a contract mismatch
 * (`VERSION_INDEPENDENT_COMMANDS`), because that is when it is needed.
 */

import {
  withManagementChannel,
  type ManagementChannelDeps,
} from "@/lib/remote-host/management-channel"

export type HostUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "waiting-for-idle"
  | "downloading"
  | "installing"
  | "restarting"
  | "trial"

export type HostUpdateUnmanagedReason =
  "desktop-app" | "not-installed" | "not-a-service" | "no-deploy-agent"

export type HostUpdateChannel = "stable" | "beta"

/** What keeps the host from updating right now, by source. */
export interface HostUpdateIdleReport {
  /** null while a connected brain has not reported recently. */
  activeRuns?: number | null
  jobs: number
  workerSlots: number
  mutations: number
  adminLeases: number
}

export interface HostUpdateOutcome {
  attemptId: string
  from: string
  to: string
  result: "installed" | "rolled-back"
  reason?: string
  atMs: number
}

/** `host_update_status`, as `crates/cognia-companion/src/host_update` sends it. */
export interface HostUpdateStatus {
  install: "native" | "compose" | "unmanaged"
  unmanagedReason?: HostUpdateUnmanagedReason
  currentVersion: string
  target?: string
  channel: HostUpdateChannel
  autoUpdate: boolean
  channelSetBy?: string
  phase: HostUpdatePhase
  available?: {
    version: string
    criticality: string
    releasedAt?: string
    releaseNotes?: string
  }
  installRequested: boolean
  waitingFor?: HostUpdateIdleReport
  lastCheckedAt?: number
  lastError?: string
  lastOutcome?: HostUpdateOutcome
  trial?: { from: string; to: string; deadlineMs: number }
}

export interface HostUpdateDeps {
  channel?: ManagementChannelDeps
}

/**
 * The host predates self-update: it answers the command with
 * `unknown_command`. It has to be updated by hand once.
 */
export class HostUpdateUnsupportedError extends Error {
  constructor() {
    super("this host predates self-update; update it by hand once")
    this.name = "HostUpdateUnsupportedError"
  }
}

function isUnknownCommand(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === "unknown_command"
}

async function call(
  hostId: string,
  name: string,
  args: Record<string, unknown>,
  deps: HostUpdateDeps
): Promise<HostUpdateStatus> {
  try {
    return await withManagementChannel(
      hostId,
      (lease) => lease.transport.call<HostUpdateStatus>(name, args),
      deps.channel
    )
  } catch (error) {
    if (isUnknownCommand(error)) throw new HostUpdateUnsupportedError()
    throw error
  }
}

export function readHostUpdateStatus(hostId: string, deps: HostUpdateDeps = {}) {
  return call(hostId, "host_update_status", {}, deps)
}

/** Ask the host to look at the catalog now. */
export function refreshHostUpdate(hostId: string, deps: HostUpdateDeps = {}) {
  return call(hostId, "host_update_refresh", {}, deps)
}

export function configureHostUpdate(
  hostId: string,
  patch: { channel?: HostUpdateChannel; autoUpdate?: boolean },
  deps: HostUpdateDeps = {}
) {
  return call(hostId, "host_update_configure", patch, deps)
}

/** Install the available release as soon as the host is idle. */
export function installHostUpdate(hostId: string, deps: HostUpdateDeps = {}) {
  return call(hostId, "host_update_install", {}, deps)
}

/** Phases in which the host is moving and worth watching closely. */
export function isHostUpdateInFlight(status: HostUpdateStatus): boolean {
  return (
    status.phase === "checking" ||
    status.phase === "waiting-for-idle" ||
    status.phase === "downloading" ||
    status.phase === "installing" ||
    status.phase === "restarting" ||
    status.phase === "trial"
  )
}

/** Whether "update now" can do anything on this host. */
export function canInstallHostUpdate(status: HostUpdateStatus): boolean {
  return (
    status.install !== "unmanaged" &&
    status.available !== undefined &&
    !status.installRequested &&
    !isHostUpdateInFlight(status)
  )
}
