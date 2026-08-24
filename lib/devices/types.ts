/**
 * One row shape for every kind of machine this account can reach.
 *
 * Device management was split across two surfaces that could not see each
 * other — `paired-devices-card.tsx` for phones and `hosts-tab.tsx` for remote
 * Hosts — while `lib/placement/types.ts` had already modelled
 * `worker | paired-device | remote-host | local` as one candidate space. This
 * module is the console's projection of that space: `DeviceRow.ref` is the
 * same value as `PlacementCandidate.ref`, so "the device I am looking at" and
 * "the candidate placement picked" are the same identity, not two ids that
 * happen to agree.
 *
 * Pure types plus structural input shapes. Deliberately no import from
 * `stores/remote-host` or `lib/companion/*` runtime: the builders in this
 * folder must stay testable without zustand, Dexie, or a transport, so remote
 * hosts arrive as {@link RemoteHostInput} — a structural subset that the real
 * `RemoteHost` satisfies.
 */

import type { PlacementLiveness } from "@/lib/placement/liveness"
import type { PlacementRequirement } from "@/lib/placement/types"
import type { CapabilityId } from "@/lib/platform/capabilities"
import type { HostFeatureManifest } from "@/lib/platform/host-feature-manifest"
import type { Platform } from "@/lib/platform/detect"
import type {
  DeviceAttention,
  EventPlaneState,
  EventStreamConnection,
} from "@/lib/companion/device-presence-registry"
import type { DevicePlatform, PairedDeviceRow } from "@/types/mobile/paired-device"
import type { SandboxConnectionRow, SandboxShellTier } from "@/types/sandbox"

/** Which candidate space a row belongs to. Mirrors `PlacementCandidateKind`. */
export type DeviceKind = "local" | "paired-device" | "remote-host" | "worker"

/**
 * Presence, as the console states it.
 *
 * `unknown` is not a synonym for `offline`: a remote Host that has never been
 * activated has no liveness evidence at all, and painting that as "offline"
 * would claim knowledge the client does not have.
 */
export type DeviceReachability = "online" | "recently-active" | "offline" | "unknown"

/** Owner-facing lifecycle state, as opposed to reachability. */
export type DeviceAdminState = "active" | "paused" | "revoked" | "unknown"

/**
 * How well a single capability is evidenced.
 *
 * `absent` and `unknown` must never collapse into each other. A device that
 * reported twenty capabilities and simply lacks `ocr` is a different fact from
 * a device that has never reported at all, and rendering the second as twenty
 * `absent` cells invents a negative answer nobody gave.
 */
export type DeviceCapabilityState = "reported" | "expected" | "absent" | "unknown"

export type DeviceCapabilitySource =
  /** The device told us, via `device_capabilities_report`. */
  | "device-report"
  /** Inferred from `capabilitiesForPlatform()` because nothing was reported. */
  | "platform-baseline"
  /** From the Host's versioned `featureManifest`. */
  | "host-manifest"
  /** Probed on this machine. */
  | "local-probe"

/** Which matrix section a cell belongs to. */
export type DeviceCapabilityGroup = "platform" | "host-execution" | "host-proxy"

export interface DeviceCapabilityCell {
  /** `CapabilityId` for platform cells, `HostFeatureId` for host cells. */
  id: string
  group: DeviceCapabilityGroup
  state: DeviceCapabilityState
  source: DeviceCapabilitySource
  /** Version + operations for host features. Never used for matching. */
  detail?: string
}

/** The four grants the owner can hand a paired device. */
export type DeviceGrantId = "control" | "agentControl" | "terminal" | "lockedComputerUse"

/**
 * `partial` is the state this console exists to expose.
 *
 * `companion_list_device_grants` answers with an all-of test, so a device
 * holding `agent.run` but not `workspace.write` reported as plain "off" — the
 * owner could not tell a never-granted device from a half-revoked one.
 */
export type DeviceGrantState = "granted" | "partial" | "denied" | "unknown"

export interface DeviceGrantRow {
  id: DeviceGrantId
  state: DeviceGrantState
  /** Every SecurityStore capability this grant confers, in catalog order. */
  capabilities: readonly string[]
  /** The subset the host says this device actually holds. */
  heldCapabilities: readonly string[]
  /**
   * Whether the grant can be handed out on this build at all. `false` marks
   * an intentionally inert control (CLAUDE.md working rule 7) — the switch
   * still renders, labelled, rather than implying a permission is being given.
   */
  available: boolean
  /** i18n key suffix explaining an unavailable or unknown grant. */
  reasonKey?: string
}

/** Whether a runtime surface can be inspected on this device right now. */
export type DeviceRuntimeSupport =
  /** Readable and actionable here. */
  | "supported"
  /** This kind of device cannot host this surface at all. */
  | "unsupported"
  /** Readable, but only while this Host is the active routing target. */
  | "requires-activation"

export interface DeviceShellTierRow {
  tier: SandboxShellTier
  available: boolean
  /** i18n key suffix under `devices.runtime.tierReason.*`. */
  reasonKey?: string
}

export interface DeviceRuntimeSection {
  support: DeviceRuntimeSupport
  /** i18n key suffix under `devices.runtime.reason.*`. */
  reasonKey?: string
}

export interface DeviceRuntimeSummary {
  /**
   * Sandbox connections are a `client`-target command family
   * (`cua_sandbox_*`), so they never follow the active remote host: only the
   * machine running this renderer has any.
   */
  sandbox: DeviceRuntimeSection & { connections: readonly SandboxConnectionRow[] }
  shellTiers: readonly DeviceShellTierRow[]
  /**
   * Workspace environments are an `execution`-target command
   * (`task_workspace_environment_list`), so the answer follows whichever host
   * the transport is currently routing to — which is why this is
   * `requires-activation` rather than a flat yes/no.
   */
  workspaces: DeviceRuntimeSection
  /** True when `transport.call` currently resolves to this device. */
  isRoutingTarget: boolean
}

/**
 * What a device offers a placement decision.
 *
 * Deliberately no `liveness` field: {@link DeviceRow.liveness} is the single
 * copy, and `deviceCandidates` reads it from there. Two fields holding the
 * same fact is how a row ends up rendering "online" beside a candidate the
 * resolver has already written off.
 */
export interface DevicePlacementSummary {
  provides: readonly PlacementRequirement[]
  activeUnits: number
  maxUnits: number
}

export interface DevicePresenceSummary {
  eventPlane: EventPlaneState
  attention: DeviceAttention
  streams: readonly EventStreamConnection[]
}

export interface DeviceRow {
  /** Identity within the placement candidate space. Stable, never a label. */
  ref: string
  kind: DeviceKind
  label: string
  /** True for the machine rendering this console. */
  isSelf: boolean

  /** Paired devices and workers. */
  deviceId?: string
  /**
   * The device's public key, carried only because provisioning a terminal host
   * descriptor needs it. Never rendered — it is not a secret, but it is also
   * not a fact a human reads.
   */
  pubkey?: string
  /** Remote hosts — the local store id, not the remote device id. */
  hostId?: string

  /** Capability baseline platform. Absent when the device never said. */
  platform?: Platform
  /** What a paired device called itself, verbatim. */
  reportedPlatform?: DevicePlatform
  appVersion?: string
  serverVersion?: string
  baseUrl?: string
  /** Full SHA-256 of the server SPKI. Never pre-truncated here. */
  fingerprint?: string
  /** Owner vs member, from the host SecurityStore. */
  role?: string

  adminState: DeviceAdminState
  /**
   * Set when the host and the local mirror disagree about {@link adminState}.
   *
   * A device suspended through the `cognia-server devices` CLI or the Owner
   * API leaves the Dexie mirror untouched, and the old card showed the mirror
   * — so the row read "active" while every call from it was being refused.
   */
  adminStateConflict?: boolean

  reachability: DeviceReachability
  liveness: PlacementLiveness
  lastSeenAt?: number
  pairedAt?: number
  addedAt?: number
  lastConnectedAt?: number
  connectionState?: RemoteHostConnectionState
  connectionError?: string

  capabilities: readonly DeviceCapabilityCell[]
  capabilitiesReportedAt?: number
  /** True when nothing has ever been reported — every cell is `unknown`. */
  capabilityReportMissing: boolean

  grants: readonly DeviceGrantRow[]
  presence?: DevicePresenceSummary
  placement: DevicePlacementSummary
  runtime: DeviceRuntimeSummary
}

export type RemoteHostConnectionState =
  "disconnected" | "connecting" | "ready" | "degraded" | "revoked" | "versionMismatch"

/**
 * Structural subset of `stores/remote-host`'s `RemoteHost`.
 *
 * Declared here rather than imported so this folder stays a pure leaf — the
 * store pulls in zustand, the credential vault, and the transport, none of
 * which a row builder should need to load in a unit test.
 */
export interface RemoteHostInput {
  id: string
  label: string
  connectionState: RemoteHostConnectionState
  connectionError?: string
  addedAt: number
  lastActiveAt?: number
  lastConnectedAt?: number
  capabilities?: readonly CapabilityId[]
  capabilitiesAt?: number
  featureManifest?: HostFeatureManifest
  featureManifestAt?: number
  config: { baseUrl: string; serverVersion: string; serverFingerprint?: string }
}

/** Structural subset of `lib/fleet/execution-workers`' `WorkerDeviceSummary`. */
export interface WorkerInput {
  deviceId: string
  hostRef: string
  displayName: string
  role: string
  status: string
  createdAt: number
  updatedAt: number
  capabilities: readonly string[]
}

/**
 * Structural subset of the Rust `DeviceSummary` returned by
 * `companion_list_devices` — the host's own answer about a device, as opposed
 * to the Dexie mirror.
 */
export interface HostDeviceSummaryInput {
  deviceId: string
  displayName: string
  role: string
  /** `active` | `suspended` | `revoked`, per the SecurityStore. */
  status: string
  createdAt: number
  updatedAt: number
  /** Raw SecurityStore capability ids this device holds. */
  capabilities: readonly string[]
}

/** This machine, as the console describes it. */
export interface LocalDeviceInput {
  ref: string
  label: string
  platform: Platform
  appVersion: string
  capabilities: readonly CapabilityId[]
  /** Registered `MicrovmExecAdapter`, i.e. the E2B plugin is active. */
  microvmAvailable: boolean
  /** `sandbox_health_probe` said the OS sandbox backend is installed. */
  osSandboxAvailable: boolean
}

export interface BuildDeviceRowsInput {
  local: LocalDeviceInput
  pairedDevices: readonly PairedDeviceRow[]
  /** Keyed by `deviceId`. Absent entirely when the host could not be asked. */
  hostDevices?: ReadonlyMap<string, HostDeviceSummaryInput>
  remoteHosts: readonly RemoteHostInput[]
  workers: readonly WorkerInput[]
  /** Keyed by `deviceId`. Live, in-process; empty after a renderer reload. */
  presence?: ReadonlyMap<string, DevicePresenceSummary>
  /** Sandbox connections, which only ever belong to {@link local}. */
  sandboxConnections: readonly SandboxConnectionRow[]
  /** `activeHostId` from the remote-host store; `null` routes locally. */
  activeHostId: string | null
  now: number
}
