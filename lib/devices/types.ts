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

/**
 * Which candidate space a row belongs to.
 *
 * The first four mirror `PlacementCandidateKind` one for one. `ssh-host` does
 * not, and deliberately: an SSH box can give you a shell and nothing else, so
 * letting `evaluatePlacement` pick one to run an agent would be a promise the
 * transport cannot keep. `placementKindFor` returns `null` for it, and
 * `deviceCandidates` drops it. The invariant is therefore "every placement
 * candidate has a row", not "every row is a candidate".
 */
export type DeviceKind = "local" | "paired-device" | "remote-host" | "worker" | "ssh-host"

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

/**
 * Whether the desktop is holding a WAN signaling connection for this device.
 *
 * ADR-0021 costs one permanent WSS socket per connected device (the hosted
 * deployment routes each one to a per-room Durable Object, so they cannot be
 * multiplexed), and the paired-device list only ever grows. A device silent for
 * 30 days therefore gets no automatic connection. That is a real reduction in
 * what the console can promise, so it is stated rather than left for the reader
 * to infer from a device that never answers.
 *
 * The states are not interchangeable, which is the whole point of having seven:
 *
 *  * `automatic` The desktop keeps a connection for this device. Whether the
 *    socket is up *this second* is the WebRTC card's question, not this one.
 *  * `woken` Dormant, but a connection is being held because the owner asked
 *    for one. Lasts until the app restarts or the device answers.
 *  * `dormant` Idle past the window. No connection, and the only state with a
 *    button.
 *  * `blocked` Paused or revoked. The device is on the host deny-list, so a
 *    socket could not serve a request even if one existed. Resuming it is a
 *    different control, in Access.
 *  * `unprovisioned` Paired before WebRTC existed, so there is no room to join
 *    and never was.
 *  * `disabled` The WebRTC master switch is off for every device.
 *  * `unmanaged` This shell does not hold WAN connections at all. Only the
 *    Tauri desktop runs the hub, so a phone or a browser reading this console
 *    genuinely does not know and cannot act.
 */
export type DeviceWanState =
  "automatic" | "woken" | "dormant" | "blocked" | "unprovisioned" | "disabled" | "unmanaged"

export interface DeviceWanSummary {
  state: DeviceWanState
  /**
   * The timestamp the dormancy decision was measured from, i.e. the later of
   * `lastSeenAt` and `pairedAt`. `undefined` when the row carries neither,
   * which reads as "never" rather than as "the epoch".
   */
  lastEvidenceAt?: number
  /**
   * Whether the owner can start a connection from here. True only in
   * `dormant`, and only on a shell that runs the hub. Every other state stays
   * rendered with the button disabled and a reason, because hiding it would
   * merge "not supported" with "one click away".
   */
  canWake: boolean
}

/** The four grants the owner can hand a paired device. */
export type DeviceGrantId = "control" | "agentControl" | "terminal" | "lockedComputerUse"

/**
 * `partial` is the state this console exists to expose.
 *
 * `companion_list_device_grants` answers with an all-of test, so a device
 * holding `agent.run` but not `workspace.write` reported as plain "off" — the
 * owner could not tell a never-granted device from a half-revoked one.
 *
 * `suspended` is ADR-0149 §5 step two: the grant rows are still there, but the
 * device belongs to a different person than the one signed in on this host, so
 * the host refuses them. Distinct from `denied` on purpose — nothing was
 * revoked, and handing the device back to its person restores it without a
 * re-grant. Showing it as `denied` would invite an owner to re-grant something
 * that is already granted.
 */
export type DeviceGrantState = "granted" | "partial" | "denied" | "unknown" | "suspended"

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
  /**
   * Whose machine this is (`usr_…`), when the host knows — ADR-0149 §5.
   *
   * Bookkeeping only. It answers a question the console could not answer at
   * all before ("some device of mine was compromised — which person's?"), and
   * it is deliberately NOT an input to any grant decision until the reroute
   * lands. A row without it is unattributed, never restricted.
   */
  ownerUserId?: string
  /** The owner's display name, when the identity projection has one. */
  ownerLabel?: string

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
  /**
   * WAN signaling, for a paired device. Absent on every other kind: a Host, a
   * worker and an SSH box are reached over their own transports and never cost
   * a rendezvous socket.
   */
  wan?: DeviceWanSummary
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

/**
 * Structural subset of `lib/terminal/ssh-profiles`' `SshHostProfile`.
 *
 * Declared here for the same reason as {@link RemoteHostInput}: the row
 * builders stay a pure leaf, testable without the terminal store or the
 * russh bridge.
 *
 * There is no liveness field because there is no liveness source. Nothing
 * pings a saved SSH host, so its {@link DeviceRow.reachability} is always
 * `unknown`. Painting it `offline` would claim knowledge the client does not
 * have, which is the same rule `unknown ≠ offline` states for a remote Host
 * that has never been activated.
 */
export interface SshHostInput {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: "password" | "privateKey" | "agent"
  /** Present when a password lives in the keyring for this profile. */
  credentialRef?: string
  /** Id of another profile this one is reached through. */
  jumpHostId?: string | null
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
  /**
   * The `usr_…` this device belongs to — ADR-0149 §5, step one.
   *
   * Absent on a device enrolled before anybody signed in on this profile,
   * which stays a supported state. Reported so the console can answer "whose
   * machine is this?"; **nothing** gates a capability on it yet, and a device
   * with no owner is not a device with less access.
   */
  userId?: string
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
  /**
   * Saved SSH hosts, from `AppSettings.terminal.sshHosts`.
   *
   * Local-identity only: `ssh_terminal_*` is `target: "client"` with
   * `capability: client.local`, and the Rust arm refuses a profile that did not
   * come from this machine. They are listed everywhere and connectable only on
   * the desktop, which the row states rather than hides.
   */
  sshHosts: readonly SshHostInput[]
  workers: readonly WorkerInput[]
  /** Keyed by `deviceId`. Live, in-process; empty after a renderer reload. */
  presence?: ReadonlyMap<string, DevicePresenceSummary>
  /** Sandbox connections, which only ever belong to {@link local}. */
  sandboxConnections: readonly SandboxConnectionRow[]
  /** `activeHostId` from the remote-host store; `null` routes locally. */
  activeHostId: string | null
  /**
   * Whether this shell runs the signaling hub, i.e. whether it is the Tauri
   * desktop. Only that shell holds WAN connections, so anywhere else the WAN
   * facet reports `unmanaged` rather than guessing.
   */
  holdsWanConnections: boolean
  /**
   * `AppSettings.webrtcEnabled`. When the master switch is off no device gets a
   * connection, and a wake button that silently did nothing would be worse than
   * one that says why.
   *
   * Optional, and absent means on, which is the same default
   * `buildSignalingConfigPatch` applies to a settings row written before the
   * toggle existed. A surface that does not manage WAN connections says so
   * through {@link BuildDeviceRowsInput.holdsWanConnections} and never reaches
   * this.
   */
  wanEnabled?: boolean
  /**
   * Device ids the owner woke this session, from
   * `lib/signaling/wan-wake-overrides.ts`.
   */
  wokenWanDeviceIds?: ReadonlySet<string>
  /**
   * `usr_…` → display name, from the ADR-0149 identity projection.
   *
   * Absent for a person this client has never mirrored, and the console falls
   * back to the raw id rather than hiding the fact that the device belongs to
   * *somebody*. "Unknown person" is a worse answer than an id you can search.
   */
  ownerNames?: ReadonlyMap<string, string>
  /**
   * The person signed in on THIS host, from `host_bindings` — ADR-0149 §5
   * step two.
   *
   * Absent when nobody has signed in, which is the common state and means
   * ownership decides nothing. When present, a device attributed to somebody
   * else has its grants suspended by the host, and the console must say so
   * rather than keep drawing them as live.
   */
  hostPersonUserId?: string
  now: number
}
