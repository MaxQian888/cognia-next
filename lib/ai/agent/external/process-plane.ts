/**
 * Can an external agent's PROCESS start from where this code is running?
 *
 * There are three runtimes, not two, and merging the last two is the bug this
 * module exists to fix:
 *
 *   1. **A shell with a process table.** Tauri desktop, the headless brain, the
 *      CLI. It spawns the agent itself.
 *   2. **A companion.** A browser tab or a phone paired to a Host. It has no
 *      process table, but it does not need one: `agentInvoke` already routes
 *      `spawn_external_agent` and its siblings over the companion RPC plane,
 *      and the Host runs the child.
 *   3. **Neither.** A browser with nothing paired. Here, and only here, is a
 *      stdio agent genuinely out of reach.
 *
 * `supportsExternalAgents()` answers `isTauri() || isHeadlessHost()`, which is
 * case 1 alone. Every companion therefore fell into the same bucket as case 3
 * and was told "the stdio transport requires the desktop (Tauri) runtime",
 * about a Host that was connected, granted, and perfectly able to run it.
 *
 * ## Why the answer is a reason, not a boolean
 *
 * Four different situations produce "no", and they need four different screens:
 * nothing is paired, the handshake has not finished, the Host is too old to
 * spawn, and the Host can spawn but has not granted THIS device the right to
 * ask. Collapsing them into `false` is what produced the misleading message in
 * the first place, so the refusal carries its reason and the caller renders it.
 *
 * The grant matters as much as the feature: `spawn_external_agent` is declared
 * `capability: "process.spawn"`, which a paired device only holds through the
 * separate Agent Control grant (`GrantKind::AgentControl`). A companion that
 * skips this check offers a Run button that the Host answers with 403.
 *
 * Which grant, though, is per command and read from the command manifest, not
 * assumed: `get_external_agent_status` is `agent.run`, and gating that on
 * `process.spawn` would refuse a device the Host would have served. Detection
 * is `process.spawn` and belongs there, because it is only nominally a read:
 * answering it forks a `--version` child per catalogued runtime, and a device
 * the user withheld Agent Control from must not be able to drive that.
 *
 * @see ./agent-transport.ts for the invoke/listen indirection this gates
 * @see ./remote-host-configs.ts, the same shape for the configuration store
 */

import { hasCapability } from "@/lib/platform/capabilities"
import { isCliHost } from "@/lib/platform/detect"
import type { HostFeatureManifest } from "@/lib/platform/host-feature-manifest"
import { supportsHostFeatureOperation } from "@/lib/platform/host-feature-manifest"
import { getRuntimeSnapshot, subscribeRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { getCommandDescriptor } from "@/lib/tauri/command-descriptors"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import {
  activeHostFeatureManifest,
  useRemoteHostStore,
} from "@/stores/remote-host/remote-host-store"

/** The feature id a Host declares when it can start an agent for a client. */
export const PROCESS_PLANE_FEATURE = "external-agent.process-plane" as const

/**
 * The SecurityStore capability the spawn arms are declared under. A paired
 * device holds it only through the Agent Control grant.
 *
 * It is the answer for the plane *in general*, i.e. the question asked with no
 * operation named. Per operation, the grant to check is whatever the command
 * manifest declares for that command, which is NOT uniformly this one: status
 * is `agent.run`. See {@link requiredGrantFor}.
 */
export const PROCESS_SPAWN_CAPABILITY = "process.spawn"

/**
 * The grant a specific plane command actually needs, read from the command
 * manifest rather than assumed.
 *
 * Assuming `process.spawn` for all five over-gated `get_external_agent_status`,
 * which is `agent.run`: refusing it here rendered a picker with no status
 * about a Host that would have answered. Detection goes the other way and is
 * `process.spawn` in the manifest, because it spawns. The manifest is the same
 * source the Host authorizes against, so the two cannot drift either way.
 */
function requiredGrantFor(operation?: ProcessPlaneCommand): string {
  if (!operation) return PROCESS_SPAWN_CAPABILITY
  return getCommandDescriptor(operation)?.capability ?? PROCESS_SPAWN_CAPABILITY
}

export const PROCESS_PLANE_COMMANDS = Object.freeze({
  spawn: "spawn_external_agent",
  send: "send_to_external_agent",
  kill: "kill_external_agent",
  status: "get_external_agent_status",
  detect: "external_agent_detect_runtimes",
} as const)

export type ProcessPlaneCommand =
  (typeof PROCESS_PLANE_COMMANDS)[keyof typeof PROCESS_PLANE_COMMANDS]

export type ProcessPlaneUnavailableReason =
  /** No Host is paired and this shell has no process table of its own. */
  | "no-host"
  /** A Host is active but has not reported its feature manifest yet. */
  | "manifest-missing"
  /** The Host does not run external agent processes for clients. */
  | "unsupported"
  /** The Host can, but this device was never granted Agent Control. */
  | "not-granted"

export type ProcessPlaneAvailability =
  { ok: true; via: "local" | "remote" } | { ok: false; reason: ProcessPlaneUnavailableReason }

/** Injectable seams so the verdict is testable without shell globals. */
export interface ProcessPlaneDeps {
  isRemoteHostActive: () => boolean
  hasLocalProcessTable: () => boolean
  getRuntimeSnapshot: typeof getRuntimeSnapshot
  activeHostFeatureManifest: () => HostFeatureManifest | null
  activeHostId: () => string | null
}

const defaultDeps: ProcessPlaneDeps = {
  isRemoteHostActive,
  activeHostId: () => useRemoteHostStore.getState().activeHostId ?? null,
  // Keyed on the capability rather than on `isTauri()`, because the headless
  // brain and the CLI must answer `true` here too. An active remote host does
  // not subtract from it: `agentInvoke` keeps sending the spawn to this
  // machine's own process table.
  //
  // The CLI needs the second term: `detectPlatform()` resolves it to `web`
  // (a Node process has no `window`, which is what SSR looks like too), so the
  // capability baseline it gets is the browser's — `["webview"]`, no `shell`.
  // The CLI does own a process table and spawns the child itself through
  // `cli/src/runtime/external/node-backend.ts`, so asking the baseline alone
  // told every `cognia-agent chat --backend <agent>` that a stdio agent needs
  // "the desktop app, or a paired Host" while the spawn it refused would have
  // succeeded on the spot.
  hasLocalProcessTable: () => hasCapability("shell") || isCliHost(),
  getRuntimeSnapshot,
  activeHostFeatureManifest,
}

let deps: ProcessPlaneDeps = defaultDeps

/** Test seam. Returns a restore function. */
export function __setProcessPlaneDepsForTests(next: Partial<ProcessPlaneDeps>): () => void {
  const previous = deps
  deps = { ...deps, ...next }
  return () => {
    deps = previous
  }
}

function deviceGrants(manifest: HostFeatureManifest, grant: string): readonly string[] {
  // A v1 manifest predates the field. It cannot say what this device holds, so
  // it is not evidence of absence: the Host's own authorization still decides,
  // and refusing here would make an older Host permanently unusable for a
  // device that is in fact granted.
  return manifest.schemaVersion === 2 ? manifest.deviceGrants : [grant]
}

/**
 * Where, if anywhere, an external agent process can start right now.
 *
 * Pass the specific command when the caller needs one operation rather than the
 * plane in general: a Host can ship the spawn arms before it ships detection,
 * and `supportsHostFeatureOperation` is per operation for exactly that reason.
 */
export function externalAgentProcessPlane(
  operation?: ProcessPlaneCommand
): ProcessPlaneAvailability {
  // A shell with its own process table answers `local` unconditionally, even
  // while it is driving a remote Host, because that is where the child actually
  // starts: `agentInvoke` sends every plane command through Tauri `invoke` the
  // moment `isTauri()` holds, and never through the routing transport. Letting
  // an active remote host win here judged the desktop against somebody else's
  // manifest, and since no Host shipped `external-agent.process-plane` before
  // this change, every stdio agent came back `transport_blocked` with its
  // Connect button disabled while the spawn it refused would have succeeded.
  if (deps.hasLocalProcessTable()) return { ok: true, via: "local" }

  const grant = requiredGrantFor(operation)

  if (deps.isRemoteHostActive()) {
    const manifest = deps.activeHostFeatureManifest()
    if (!manifest) return { ok: false, reason: "manifest-missing" }
    if (!supportsHostFeatureOperation(manifest, PROCESS_PLANE_FEATURE, operation)) {
      return { ok: false, reason: "unsupported" }
    }
    if (!deviceGrants(manifest, grant).includes(grant)) {
      return { ok: false, reason: "not-granted" }
    }
    return { ok: true, via: "remote" }
  }

  // No remote host is *active*, but the runtime snapshot may still describe one
  // this shell is attached to. Same fallback `remote-host-configs` uses, and the
  // path a CLI or a headless client takes.
  const snapshot = deps.getRuntimeSnapshot()
  const host = snapshot.host
  if (!host) return { ok: false, reason: "no-host" }
  // A snapshot outlives the connection it describes. Reporting a reachable
  // plane off a stale one hands the user a Run button whose spawn dies at the
  // transport with a raw network error, instead of the `no-host` message this
  // module exists to produce.
  if (snapshot.connectionState !== "online") return { ok: false, reason: "no-host" }
  if (host.compatible !== true) return { ok: false, reason: "unsupported" }
  if (operation && !host.operations.includes(operation)) {
    return { ok: false, reason: "unsupported" }
  }
  // The snapshot already resolved the grant question for both manifest
  // versions, so read it rather than re-deriving one here.
  if (!host.grants.includes(grant)) {
    return { ok: false, reason: "not-granted" }
  }
  return { ok: true, via: "remote" }
}

/**
 * Wake a reader whenever the plane's answer could have moved.
 *
 * The two inputs are the runtime snapshot (connection state, host operations,
 * grants) and the remote-host store (which Host is active). Shared rather than
 * written out per consumer: a hook that subscribes to only one of them keeps
 * rendering a verdict from before the other changed, and the model-surface
 * hook was doing exactly that by subscribing to neither.
 */
export function subscribeExternalAgentProcessPlane(onChange: () => void): () => void {
  const stopSnapshot = subscribeRuntimeSnapshot(onChange)
  const stopHosts = useRemoteHostStore.subscribe(onChange)
  return () => {
    stopSnapshot()
    stopHosts()
  }
}

/**
 * Which machine the plane would reach right now, as an opaque key.
 *
 * Anything that CACHES an answer about the host has to be able to notice that
 * the host changed, and there is no event for it: a companion is repointed at
 * a second Host, a desktop attaches or drops a remote one, and a cache keyed
 * on nothing keeps describing the machine that answered first. Comparing this
 * key is how such a cache tells the two apart.
 *
 * `local` is one scope for every shell with its own process table, because
 * that is the machine the code is running on and it cannot change underneath
 * the process.
 */
export function externalAgentProcessPlaneScope(): string {
  if (deps.hasLocalProcessTable()) return "local"
  if (deps.isRemoteHostActive()) return `host:${deps.activeHostId() ?? "unknown"}`
  return `target:${deps.getRuntimeSnapshot().target?.id ?? "none"}`
}

/** True when a stdio external agent can actually be started from here. */
export function canStartExternalAgentProcess(): boolean {
  return externalAgentProcessPlane(PROCESS_PLANE_COMMANDS.spawn).ok
}

/** True when this runtime can ask something for the list of installed agents. */
export function canDetectInstalledAgents(): boolean {
  return externalAgentProcessPlane(PROCESS_PLANE_COMMANDS.detect).ok
}
