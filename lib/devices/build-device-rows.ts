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
import { isWanBlocked, isWanDormant, lastWanEvidenceAt } from "@/lib/signaling/wan-dormancy"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"

import {
  baselinePlatformFor,
  buildHostFeatureCells,
  buildPlatformCapabilityCells,
} from "./capability-cells"
import { buildDeviceRuntime } from "./device-runtime"
import { buildGrantRows, ownerPermits, type GrantEvidence } from "./grant-capabilities"
import { buildDevicePlacement } from "./placement-directory"
import type {
  BuildDeviceRowsInput,
  DeviceAdminState,
  DeviceReachability,
  DeviceRow,
  DeviceWanSummary,
  RemoteHostInput,
  SshHostInput,
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

export function sshHostRef(profile: { id: string }): string {
  return `ssh:${profile.id}`
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

/**
 * Whether the desktop holds a WAN signaling connection for this device, and
 * why not when it does not.
 *
 * Mirrors `selectSignalingDevices` in `lib/signaling/desktop-controller.ts`
 * exactly, reading the same `isWanDormant` and `isWanBlocked` leaves, because a
 * console that described a different rule from the one the hub applies would be
 * worse than one that said nothing. The order is fixed: structural facts first
 * (there is no room to join), then the deny-list, then this shell's ability to
 * answer at all, then the master switch, then dormancy. Each answer supersedes
 * the ones below it, so the reader gets the reason that actually decides the
 * outcome rather than the last one checked.
 *
 * The deny-list step reads BOTH the mirror row (via `isWanBlocked`, the exact
 * predicate the hub push applies) and the host-preferred `adminState`, because
 * the two can disagree: that disagreement is what `adminStateConflict` records.
 * Trusting `adminState` alone let a row whose mirror carries `pausedAt` but
 * whose host reports `active` render as "Held open" for a device the hub had
 * already dropped, with a "Connect now" button that re-pushed a list the same
 * `pausedAt` filtered straight back out.
 */
export function buildDeviceWan(
  row: PairedDeviceRow,
  input: Pick<
    BuildDeviceRowsInput,
    "holdsWanConnections" | "wanEnabled" | "wokenWanDeviceIds" | "now"
  >,
  adminState: DeviceAdminState
): DeviceWanSummary {
  const evidenceAt = lastWanEvidenceAt(row)
  const base = {
    ...(evidenceAt > 0 ? { lastEvidenceAt: evidenceAt } : {}),
    canWake: false,
  }

  const provisioned =
    typeof row.rendezvousId === "string" &&
    row.signalingRoomDescriptor?.v === 2 &&
    typeof row.signalingKeyRef === "string"
  if (!provisioned) return { ...base, state: "unprovisioned" }
  if (isWanBlocked(row) || adminState === "revoked" || adminState === "paused") {
    return { ...base, state: "blocked" }
  }
  if (!input.holdsWanConnections) return { ...base, state: "unmanaged" }
  if (input.wanEnabled === false) return { ...base, state: "disabled" }
  if (!isWanDormant(row, input.now)) return { ...base, state: "automatic" }
  if (input.wokenWanDeviceIds?.has(row.deviceId) === true) return { ...base, state: "woken" }
  return { ...base, state: "dormant", canWake: true }
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
    // ADR-0149 §5 step two. The host re-decides this per request; the mirror
    // exists so the console can explain a switch it is drawing as off.
    ownerSuspended: !ownerPermits(input.hostPersonUserId, hostDevice?.userId),
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
    // Only the host knows this; the Dexie mirror has never carried it.
    ...(hostDevice?.userId
      ? {
          ownerUserId: hostDevice.userId,
          ...(input.ownerNames?.get(hostDevice.userId)
            ? { ownerLabel: input.ownerNames.get(hostDevice.userId) }
            : {}),
        }
      : {}),
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
    wan: buildDeviceWan(row, input, adminState),
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
  /**
   * `ready` is socket-grade evidence, not a timestamp to be aged out.
   *
   * The remote-host store only reports `ready` after authentication AND both
   * capability probes succeed, so the transport is demonstrably open right
   * now — which is exactly what `LivenessSource: "socket"` means. Treating it
   * as a `manifest` timestamp instead would judge a freshly-activated host
   * against `lastConnectedAt`, and a host that is connected but has not yet
   * recorded one would be reported offline while it is answering calls.
   */
  const liveness: PlacementLiveness =
    host.connectionState === "ready"
      ? { online: true, lastSeenAt: lastSeenAt > 0 ? lastSeenAt : input.now, source: "socket" }
      : { online: false, lastSeenAt, source: "manifest" }
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

/**
 * A saved SSH host, as the console describes it.
 *
 * Everything here is deliberately empty or `unknown`, and each blank is a fact
 * rather than a gap:
 *
 *  * **`reachability` from an explicit Test connection, or `unknown`.** A saved
 *    host carries no presence of its own, so until someone probes it there is
 *    nothing to report, and `offline` would claim knowledge nobody has. A probe
 *    answers directly rather than through `deriveReachability`: that function
 *    reads a *stream* of presence, where a recent timestamp with `online:
 *    false` means "was here, may not be able to act" and maps to
 *    `recently-active`. A probe is not a stream. It is one question, and a
 *    refusal to it means `offline` now, not "seen recently".
 *  * **No capabilities and no grants.** An SSH server never reported anything
 *    and holds no SecurityStore capability. A matrix of `absent` cells would
 *    invent twenty negative answers nobody gave.
 *  * **No placement `provides`.** `placementKindFor` already keeps it out of
 *    the candidate space; this makes the row itself say why, in the stat strip
 *    that renders `0` dimensions as `attention`.
 *  * **Every runtime surface unsupported.** `ssh_terminal_*` is
 *    `target: "client"` with `capability: client.local`, so a paired phone
 *    cannot reach one at all, and no workspace, sandbox or shell-tier question
 *    has an answer over a bare SSH shell.
 */
function buildSshHostRow(profile: SshHostInput, input: BuildDeviceRowsInput): DeviceRow {
  const probe = input.sshProbes?.get(profile.id)
  /**
   * `lastSeenAt: 0` is what `deriveReachability` reads as "no evidence at
   * all", which is the honest answer for a host nobody has asked about and the
   * same shape a remote Host that has never been connected carries. A probe
   * replaces it with the moment it settled, in both directions: a refusal is
   * evidence too, and dating it is what lets the card say how old the answer
   * is.
   */
  const liveness: PlacementLiveness = probe
    ? { online: probe.online, lastSeenAt: probe.at, source: "request" }
    : { online: false, lastSeenAt: 0, source: "manifest" }
  return {
    ref: sshHostRef(profile),
    kind: "ssh-host",
    label: profile.name || `${profile.username}@${profile.host}`,
    isSelf: false,
    baseUrl: `ssh://${profile.username}@${profile.host}:${profile.port}`,
    adminState: "unknown",
    reachability: probe
      ? probe.online
        ? "online"
        : "offline"
      : deriveReachability(liveness, false, input.now),
    liveness,
    lastSeenAt: probe?.online ? probe.at : undefined,
    capabilities: [],
    capabilityReportMissing: true,
    grants: [],
    placement: { provides: [], activeUnits: 0, maxUnits: 0 },
    runtime: {
      sandbox: { support: "unsupported", reasonKey: "sshShellOnly", connections: [] },
      shellTiers: [],
      workspaces: { support: "unsupported", reasonKey: "sshShellOnly" },
      isRoutingTarget: false,
    },
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
    ...input.sshHosts.map((profile) => buildSshHostRow(profile, input)),
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
/**
 * Whether this row is something a person has to go and look at.
 *
 * Deliberately not "is it offline": a phone in a pocket is offline and that is
 * the expected state, so counting it would make the badge permanently lit and
 * therefore unreadable. What qualifies is a device whose *configuration* is
 * wrong — revoked, disagreeing with the host about its own lifecycle, or
 * connected-but-broken — because each of those needs an action to clear.
 *
 * Exported because the rail dot and the header count must never disagree; they
 * used to re-derive this predicate separately, which is exactly how a badge
 * ends up saying "1" with no row marked.
 */
export function rowNeedsAttention(row: DeviceRow): boolean {
  return (
    row.adminState === "revoked" ||
    row.adminStateConflict === true ||
    row.connectionState === "degraded" ||
    row.connectionState === "versionMismatch"
  )
}

export function summarizeDeviceRows(rows: readonly DeviceRow[]): {
  total: number
  online: number
  needsAttention: number
} {
  let online = 0
  let needsAttention = 0
  for (const row of rows) {
    if (row.reachability === "online") online += 1
    if (rowNeedsAttention(row)) needsAttention += 1
  }
  return { total: rows.length, online, needsAttention }
}
