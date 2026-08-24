/**
 * The one place a device row is assembled.
 *
 * Pure: no React, no Dexie, no transport, no clock. Every source of truth
 * arrives as an argument so the whole matrix of "host reachable / host
 * unreachable / never reported / mirror disagrees" is reachable in a unit test
 * rather than only on a paired phone.
 *
 * Precedence is fixed and deliberate — **the host's answer when we have it,
 * the local mirror only as a fallback for shells that cannot reach the host.**
 * That is the rule the old paired-devices card already used for its switches;
 * this module extends it to lifecycle state, which the card did not, and
 * flags a disagreement rather than silently preferring one side. A device
 * suspended through the `cognia-server devices` CLI left the Dexie mirror
 * untouched, so the row read "active" while every call from it was refused.
 */

import { RECENTLY_ACTIVE_WINDOW_MS } from "@/lib/companion/device-presence-registry"
import { isPlaceable, type PlacementLiveness } from "@/lib/placement/liveness"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"

import {
  baselinePlatformFor,
  buildHostFeatureCells,
  buildPlatformCapabilityCells,
} from "./capability-cells"
import { buildDeviceRuntime } from "./device-runtime"
import { buildGrantRows, type GrantEvidence } from "./grant-capabilities"
import { buildDevicePlacement } from "./placement-directory"
import type {
  BuildDeviceRowsInput,
  DeviceAdminState,
  DeviceReachability,
  DeviceRow,
  RemoteHostInput,
  WorkerInput,
} from "./types"

/** Namespaced so a paired device and a Host can never collide on `ref`. */
export function pairedDeviceRef(deviceId: string): string {
  return `device:${deviceId}`
}

export function remoteHostRef(host: RemoteHostInput): string {
  // The Host's own identity when it published one — that is the value
  // `runOn: { mode: "pinned", ref }` already stores — falling back to the local
  // store id so an unprobed Host is still addressable.
  return host.featureManifest?.schemaVersion === 2
    ? host.featureManifest.hostIdentity.id
    : `host:${host.id}`
}

export function workerRef(worker: WorkerInput): string {
  // Workers are pinned by `hostRef` throughout `remote-worker-runtime.ts`, so
  // the console must address them the same way or a pin set here would not
  // match the one the resolver reads.
  return worker.hostRef
}

/**
 * The key this device is addressed by in `hostDispatchQueue`.
 *
 * Not the console `ref`. `HostDispatchJobRow.targetRef` is documented as being
 * "in the target's own vocabulary" — a raw `deviceId` for a paired device, a
 * `hostRef` for a worker, a remote-host id for a handoff — and the console
 * namespaces its refs so a phone and a Host cannot collide. Querying with the
 * namespaced ref would silently return nothing, which reads as "no work has
 * ever been sent here".
 */
export function dispatchTargetRef(row: DeviceRow): string | undefined {
  switch (row.kind) {
    case "paired-device":
      return row.deviceId
    case "remote-host":
      return row.hostId
    case "worker":
      return row.ref
    default:
      return undefined
  }
}

/**
 * Reachability from liveness plus, when we have it, the event plane.
 *
 * A ready event stream is proof of presence now; a timestamp is only evidence
 * inside `isPlaceable`'s TTL. Beyond that TTL but inside the recently-active
 * window the device is worth showing without claiming it may act — the
 * distinction `device-presence-registry` insists on.
 */
export function deriveReachability(
  liveness: PlacementLiveness,
  eventPlaneReady: boolean,
  now: number
): DeviceReachability {
  if (liveness.source === "local") return "online"
  if (eventPlaneReady) return "online"
  if (!Number.isFinite(liveness.lastSeenAt) || liveness.lastSeenAt <= 0) return "unknown"
  if (isPlaceable(liveness, now)) return "online"
  return now - liveness.lastSeenAt <= RECENTLY_ACTIVE_WINDOW_MS ? "recently-active" : "offline"
}

function adminStateFromHostStatus(status: string): DeviceAdminState {
  switch (status) {
    case "active":
      return "active"
    case "suspended":
      return "paused"
    case "revoked":
      return "revoked"
    default:
      return "unknown"
  }
}

function mirrorAdminState(row: PairedDeviceRow): DeviceAdminState {
  if (row.revokedAt !== undefined) return "revoked"
  if (row.pausedAt !== undefined) return "paused"
  return "active"
}

function buildPairedDeviceRow(row: PairedDeviceRow, input: BuildDeviceRowsInput): DeviceRow {
  const hostDevice = input.hostDevices?.get(row.deviceId)
  const mirror = mirrorAdminState(row)
  const hostState = hostDevice ? adminStateFromHostStatus(hostDevice.status) : undefined
  const adminState = hostState && hostState !== "unknown" ? hostState : mirror
  const presence = input.presence?.get(row.deviceId)

  const liveness: PlacementLiveness = {
    online: adminState === "active",
    lastSeenAt: row.lastSeenAt,
    source: presence?.eventPlane === "ready" ? "socket" : "request",
  }

  const evidence: GrantEvidence = {
    hostCapabilities: hostDevice?.capabilities,
    mirror: {
      control: row.allowRemoteControl === true,
      agentControl: row.allowAgentControl === true,
      terminal: row.allowRemoteTerminal === true,
      lockedComputerUse: row.allowLockedComputerUse === true,
    },
    revoked: adminState === "revoked",
  }

  const capabilities = buildPlatformCapabilityCells({
    reported: row.capabilities,
    reportedAt: row.capabilitiesReportedAt,
    platform: baselinePlatformFor(row.platform),
  })

  return {
    ref: pairedDeviceRef(row.deviceId),
    kind: "paired-device",
    label: row.label,
    isSelf: false,
    deviceId: row.deviceId,
    pubkey: row.pubkey,
    platform: baselinePlatformFor(row.platform),
    reportedPlatform: row.platform,
    appVersion: row.appVersion,
    fingerprint: row.serverFingerprint,
    role: hostDevice?.role,
    adminState,
    adminStateConflict: hostState !== undefined && hostState !== mirror ? true : undefined,
    reachability: deriveReachability(liveness, presence?.eventPlane === "ready", input.now),
    liveness,
    lastSeenAt: row.lastSeenAt,
    pairedAt: row.pairedAt,
    capabilities,
    capabilitiesReportedAt: row.capabilitiesReportedAt,
    capabilityReportMissing: row.capabilitiesReportedAt === undefined,
    grants: buildGrantRows(evidence),
    presence,
    placement: buildDevicePlacement({
      kind: "paired-device",
      platformCapabilities: row.capabilities ?? [],
    }),
    runtime: buildDeviceRuntime({
      kind: "paired-device",
      local: input.local,
      sandboxConnections: [],
      activeHostId: input.activeHostId,
    }),
  }
}

function buildRemoteHostRow(host: RemoteHostInput, input: BuildDeviceRowsInput): DeviceRow {
  const lastSeenAt = host.lastConnectedAt ?? host.featureManifestAt ?? host.capabilitiesAt ?? 0
  const liveness: PlacementLiveness = {
    online: host.connectionState === "ready",
    lastSeenAt,
    source: "manifest",
  }
  const adminState: DeviceAdminState =
    host.connectionState === "revoked" ? "revoked" : lastSeenAt > 0 ? "active" : "unknown"

  const capabilities = [
    ...buildPlatformCapabilityCells({
      reported: host.capabilities,
      reportedAt: host.capabilitiesAt,
      // A Host reports its own capability list; when it has not, there is no
      // baseline to infer from — its platform is whatever it runs, not ours.
      platform: undefined,
    }),
    ...buildHostFeatureCells(host.featureManifest),
  ]

  return {
    ref: remoteHostRef(host),
    kind: "remote-host",
    label: host.label,
    isSelf: false,
    hostId: host.id,
    serverVersion: host.config.serverVersion,
    baseUrl: host.config.baseUrl,
    fingerprint: host.config.serverFingerprint,
    adminState,
    reachability: deriveReachability(liveness, host.connectionState === "ready", input.now),
    liveness,
    lastSeenAt: lastSeenAt > 0 ? lastSeenAt : undefined,
    addedAt: host.addedAt,
    lastConnectedAt: host.lastConnectedAt,
    connectionState: host.connectionState,
    connectionError: host.connectionError,
    capabilities,
    capabilitiesReportedAt: host.capabilitiesAt,
    capabilityReportMissing:
      host.capabilitiesAt === undefined && host.featureManifestAt === undefined,
    grants: [],
    placement: buildDevicePlacement({
      kind: "remote-host",
      platformCapabilities: host.capabilities ?? [],
      featureManifest: host.featureManifest,
    }),
    runtime: buildDeviceRuntime({
      kind: "remote-host",
      hostId: host.id,
      local: input.local,
      sandboxConnections: [],
      activeHostId: input.activeHostId,
    }),
  }
}

function buildWorkerRow(worker: WorkerInput, input: BuildDeviceRowsInput): DeviceRow {
  const liveness: PlacementLiveness = {
    online: worker.status === "active",
    lastSeenAt: worker.updatedAt,
    source: "request",
  }
  return {
    ref: workerRef(worker),
    kind: "worker",
    label: worker.displayName,
    isSelf: false,
    deviceId: worker.deviceId,
    adminState: adminStateFromHostStatus(worker.status),
    reachability: deriveReachability(liveness, false, input.now),
    liveness,
    lastSeenAt: worker.updatedAt,
    pairedAt: worker.createdAt,
    role: worker.role,
    // A worker's enrollment carries SecurityStore capability ids, not the
    // platform vocabulary, so it gets no platform matrix — showing one would
    // read those ids in a vocabulary that does not own them.
    capabilities: [],
    capabilityReportMissing: worker.capabilities.length === 0,
    grants: [],
    placement: buildDevicePlacement({
      kind: "worker",
      agentCapabilities: worker.capabilities,
    }),
    runtime: buildDeviceRuntime({
      kind: "worker",
      local: input.local,
      sandboxConnections: [],
      activeHostId: input.activeHostId,
    }),
  }
}

function buildLocalRow(input: BuildDeviceRowsInput): DeviceRow {
  const liveness: PlacementLiveness = {
    online: true,
    lastSeenAt: input.now,
    source: "local",
  }
  const runtime = buildDeviceRuntime({
    kind: "local",
    local: input.local,
    sandboxConnections: input.sandboxConnections,
    activeHostId: input.activeHostId,
  })
  return {
    ref: input.local.ref,
    kind: "local",
    label: input.local.label,
    isSelf: true,
    platform: input.local.platform,
    appVersion: input.local.appVersion,
    adminState: "active",
    reachability: "online",
    liveness,
    lastSeenAt: input.now,
    capabilities: buildPlatformCapabilityCells({
      reported: input.local.capabilities,
      reportedAt: input.now,
      platform: input.local.platform,
      source: "local-probe",
    }),
    capabilitiesReportedAt: input.now,
    capabilityReportMissing: false,
    grants: [],
    placement: buildDevicePlacement({
      kind: "local",
      platformCapabilities: input.local.capabilities,
      shellTiers: runtime.shellTiers,
    }),
    runtime,
  }
}

const REACHABILITY_ORDER: Record<DeviceReachability, number> = {
  online: 0,
  "recently-active": 1,
  unknown: 2,
  offline: 3,
}

/**
 * Every reachable machine, this one first, then live before dormant.
 *
 * Sorted by presence rather than alphabetically for the same reason
 * `squad-fleet-console` is: a fleet view is read to find what is running, and
 * an alphabetical list buries that under whatever happens to start with "A".
 * The final tiebreak is `ref`, which is stable and unique, so the order never
 * shuffles between renders of identical data.
 */
export function buildDeviceRows(input: BuildDeviceRowsInput): DeviceRow[] {
  const rows: DeviceRow[] = [
    buildLocalRow(input),
    ...input.pairedDevices.map((row) => buildPairedDeviceRow(row, input)),
    ...input.remoteHosts.map((host) => buildRemoteHostRow(host, input)),
    ...input.workers.map((worker) => buildWorkerRow(worker, input)),
  ]

  return rows.sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1
    const byReach = REACHABILITY_ORDER[a.reachability] - REACHABILITY_ORDER[b.reachability]
    if (byReach !== 0) return byReach
    const byLabel = a.label.localeCompare(b.label)
    return byLabel !== 0 ? byLabel : a.ref.localeCompare(b.ref)
  })
}

/** Counts for the console header. */
export function summarizeDeviceRows(rows: readonly DeviceRow[]): {
  total: number
  online: number
  needsAttention: number
} {
  let online = 0
  let needsAttention = 0
  for (const row of rows) {
    if (row.reachability === "online") online += 1
    if (
      row.adminState === "revoked" ||
      row.adminStateConflict === true ||
      row.connectionState === "degraded" ||
      row.connectionState === "versionMismatch"
    ) {
      needsAttention += 1
    }
  }
  return { total: rows.length, online, needsAttention }
}
