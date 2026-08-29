/**
 * Client for the host that owns external-agent configurations.
 *
 * A browser Composer cannot run an external agent itself — it has no process
 * table — so the configuration and the process both live on a paired host and
 * this module is the only way the browser touches them. Everything here is a
 * thin, typed call over the companion RPC plane; the authority is entirely on
 * the other side.
 *
 * Two rules shape the surface:
 *
 *   1. **The handshake is checked before every call, not once at boot.** The
 *      active target changes while the app is open — a user switches paired
 *      hosts, a host is upgraded underneath a long-lived tab. A capability
 *      cached at startup would describe a host that is no longer the one being
 *      talked to. `supportsHostFeatureOperation` is per operation for exactly
 *      this reason: a host may ship the store before it ships admission.
 *
 *   2. **An unsupported host is an error, never a fallback.** The tempting
 *      degradation — run it locally instead, or send the whole configuration
 *      per turn — is precisely the arrangement the host-owned store exists to
 *      replace, and it would silently move execution somewhere the user did
 *      not choose. So the refusal is structured and loud, and the caller
 *      decides what to tell the user.
 */

import { transport } from "@/lib/tauri"
import { issueHostAdminLease } from "@/lib/tauri/admin-lease"
import { activeHostFeatureManifest } from "@/stores/remote-host/remote-host-store"
import { hasCapability } from "@/lib/platform/capabilities"
import { getRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import type { HostFeatureManifest } from "@/lib/platform/host-feature-manifest"
import { supportsHostFeatureOperation } from "@/lib/platform/host-feature-manifest"
import type {
  ExternalAgentConfigRecord,
  ExternalAgentConfigStamp,
} from "@/types/agent/external-agent-config-store"
import type { StoredExternalAgentConfig } from "@/stores/agent/external-agent-store/types"
import type { RunAdmissionRefusal } from "./run-admission"

/** The feature id that groups every operation in this module. */
export const HOST_CONFIGS_FEATURE = "external-agent.host-configs" as const

export const HOST_CONFIG_COMMANDS = Object.freeze({
  list: "external_agent_config_list",
  get: "external_agent_config_get",
  create: "external_agent_config_create",
  update: "external_agent_config_update",
  delete: "external_agent_config_delete",
  reconcile: "external_agent_config_reconcile",
  admit: "external_agent_admit_run",
  release: "external_agent_release_run",
  // The run plane. It rides the same feature id and therefore the same
  // availability gate: a host that can store a configuration but not run one
  // is not a runnable target, and a client has to be told which of the two it
  // is looking at rather than getting "unknown command" from the transport.
  run: "external_agent_run_turn",
  cancel: "external_agent_cancel_run",
  resolve: "external_agent_resolve_decision",
} as const)

export type HostConfigCommand = (typeof HOST_CONFIG_COMMANDS)[keyof typeof HOST_CONFIG_COMMANDS]

/**
 * Used when no specific operation is named — "is this surface worth offering
 * at all?". Asking about the feature id alone is not enough: a host can
 * advertise the feature while listing no operations, and treating that as
 * support would put an empty, unusable panel in front of the user.
 */
const ANY_COMMAND: readonly HostConfigCommand[] = Object.freeze(Object.values(HOST_CONFIG_COMMANDS))

/**
 * Why this client cannot reach a host that owns configurations.
 *
 * `no-host` and `unsupported` are separated because they are different
 * sentences to a user: "pair a host first" versus "this host is too old". A
 * single boolean would make the second unexplainable.
 */
export type HostConfigsUnavailableReason = "no-host" | "unsupported" | "manifest-missing"

/**
 * The structured refusal. Carries the feature and the operation so a caller can
 * say which capability is missing rather than "something went wrong", and so a
 * log line identifies the host that needs upgrading.
 */
export class HostConfigsUnsupportedError extends Error {
  readonly reason: HostConfigsUnavailableReason
  readonly feature = HOST_CONFIGS_FEATURE
  readonly operation?: HostConfigCommand

  constructor(reason: HostConfigsUnavailableReason, operation?: HostConfigCommand) {
    super(
      reason === "no-host"
        ? "No paired host owns external-agent configurations."
        : reason === "manifest-missing"
          ? "The paired host has not reported its feature manifest yet."
          : `The paired host does not support ${operation ?? HOST_CONFIGS_FEATURE}.`
    )
    this.name = "HostConfigsUnsupportedError"
    this.reason = reason
    this.operation = operation
  }
}

/** Injectable seams so routing is testable without shell globals. */
export interface RemoteHostConfigDeps {
  isRemoteHostActive: () => boolean
  hasLocalAuthority: () => boolean
  getRuntimeSnapshot: typeof getRuntimeSnapshot
  activeHostFeatureManifest: () => HostFeatureManifest | null
  call: <T>(command: string, payload?: Record<string, unknown>) => Promise<T>
  issueAdminLease: typeof issueHostAdminLease
}

const defaultDeps: RemoteHostConfigDeps = {
  isRemoteHostActive,
  // A shell that can spawn a process owns its own store; the same commands
  // then dispatch in-process rather than over the wire. Keyed on the
  // capability rather than on `isTauri()` because a headless brain must answer
  // `true` here too, and a desktop driving a remote host must not — which is
  // what the `isRemoteHostActive()` term above it settles.
  hasLocalAuthority: () => hasCapability("shell"),
  getRuntimeSnapshot,
  activeHostFeatureManifest,
  call: (command, payload) => transport.call(command, payload ?? {}),
  issueAdminLease: issueHostAdminLease,
}

let deps: RemoteHostConfigDeps = defaultDeps

/** Test seam — returns a restore function. */
export function __setRemoteHostConfigDepsForTests(next: Partial<RemoteHostConfigDeps>): () => void {
  const previous = deps
  deps = { ...deps, ...next }
  return () => {
    deps = previous
  }
}

/**
 * Can `operation` run against whatever host is active right now?
 *
 * Returns the reason rather than a boolean so the caller can render the right
 * empty state: a browser with nothing paired, a paired host still handshaking,
 * and a paired host that is simply too old are three different screens.
 */
export function hostConfigsAvailability(
  operation?: HostConfigCommand
): { ok: true } | { ok: false; reason: HostConfigsUnavailableReason } {
  if (deps.hasLocalAuthority() && !deps.isRemoteHostActive()) return { ok: true }

  if (deps.isRemoteHostActive()) {
    const manifest = deps.activeHostFeatureManifest()
    if (!manifest) return { ok: false, reason: "manifest-missing" }
    const supports = (candidate: HostConfigCommand) =>
      supportsHostFeatureOperation(manifest, HOST_CONFIGS_FEATURE, candidate)
    return (operation ? supports(operation) : ANY_COMMAND.some(supports))
      ? { ok: true }
      : { ok: false, reason: "unsupported" }
  }

  const host = deps.getRuntimeSnapshot().host
  if (!host) return { ok: false, reason: "no-host" }
  if (host.compatible !== true) return { ok: false, reason: "unsupported" }
  const supports = (candidate: HostConfigCommand) => host.operations.includes(candidate)
  return (operation ? supports(operation) : ANY_COMMAND.some(supports))
    ? { ok: true }
    : { ok: false, reason: "unsupported" }
}

/** True when a surface should be offered at all. */
export function hostOwnsExternalAgentConfigs(): boolean {
  return hostConfigsAvailability().ok
}

/**
 * Every call to the owning host goes through here, so the handshake is checked
 * per operation and an unsupported host is a structured refusal rather than
 * whatever the transport says about an unknown command name.
 *
 * Exported because the run plane (`remote-run-client`) is a separate module by
 * concern but the same feature by capability — it must not open a second,
 * ungated path to the same host.
 */
export async function callHostConfigCommand<T>(
  operation: HostConfigCommand,
  payload?: Record<string, unknown>
): Promise<T> {
  const availability = hostConfigsAvailability(operation)
  if (!availability.ok) throw new HostConfigsUnsupportedError(availability.reason, operation)
  return deps.call<T>(operation, payload)
}

const call = callHostConfigCommand

/**
 * Mutating the host-owned configuration is always a direct user action. Mint
 * the short-lived approval at that boundary and use it immediately; a lease
 * must never be parked in a durable queue where it can expire before dispatch.
 * Local authority goes through the service plane and does not need a device
 * lease.
 */
async function callHostConfigWriteCommand<T>(
  operation: HostConfigCommand,
  payload: Record<string, unknown> = {}
): Promise<T> {
  const availability = hostConfigsAvailability(operation)
  if (!availability.ok) throw new HostConfigsUnsupportedError(availability.reason, operation)
  const localAuthority = deps.hasLocalAuthority() && !deps.isRemoteHostActive()
  if (localAuthority) return deps.call<T>(operation, payload)
  const lease = await deps.issueAdminLease([operation])
  return deps.call<T>(operation, { ...payload, adminLease: lease.token })
}

export async function listRemoteHostConfigs(): Promise<ExternalAgentConfigRecord[]> {
  const result = await call<{ configs: ExternalAgentConfigRecord[] }>(HOST_CONFIG_COMMANDS.list)
  return result.configs ?? []
}

export async function getRemoteHostConfig(
  configId: string
): Promise<ExternalAgentConfigRecord | null> {
  const result = await call<{ config: ExternalAgentConfigRecord | null }>(
    HOST_CONFIG_COMMANDS.get,
    { configId }
  )
  return result.config ?? null
}

/**
 * Create a configuration on the host.
 *
 * `fromImport` is the browser's "copy to host". The host, not this client, is
 * what strips the keyring references and consents that were granted on the
 * browser's machine — doing it here would be a courtesy the host could not
 * rely on, and the host has to be safe against a caller that does not.
 */
export async function createRemoteHostConfig(
  config: Partial<StoredExternalAgentConfig>,
  options: { fromImport?: boolean } = {}
): Promise<ExternalAgentConfigRecord> {
  const result = await callHostConfigWriteCommand<{ config: ExternalAgentConfigRecord }>(
    HOST_CONFIG_COMMANDS.create,
    {
      config,
      ...(options.fromImport ? { fromImport: true } : {}),
    }
  )
  return result.config
}

export async function updateRemoteHostConfig(input: {
  configId: string
  expectedRevision: string
  patch: Partial<StoredExternalAgentConfig>
}): Promise<ExternalAgentConfigRecord> {
  const result = await callHostConfigWriteCommand<{ config: ExternalAgentConfigRecord }>(
    HOST_CONFIG_COMMANDS.update,
    input as unknown as Record<string, unknown>
  )
  return result.config
}

export async function deleteRemoteHostConfig(configId: string): Promise<ExternalAgentConfigRecord> {
  const result = await callHostConfigWriteCommand<{ config: ExternalAgentConfigRecord }>(
    HOST_CONFIG_COMMANDS.delete,
    { configId }
  )
  return result.config
}

export interface RemoteReconcileOutcome {
  configId: string
  from: string
  to: string
  changed: boolean
}

export async function reconcileRemoteHostConfigs(): Promise<RemoteReconcileOutcome[]> {
  const result = await callHostConfigWriteCommand<{ outcomes: RemoteReconcileOutcome[] }>(
    HOST_CONFIG_COMMANDS.reconcile
  )
  return result.outcomes ?? []
}

export type RemoteRunAdmission =
  | { admitted: true; runId: string; record: ExternalAgentConfigRecord }
  | { admitted: false; refusal: RunAdmissionRefusal; record?: ExternalAgentConfigRecord }

/**
 * Ask the host whether this run may start.
 *
 * The concrete configuration the host returns is intentionally NOT surfaced:
 * the browser has no use for it — it is not the thing that spawns — and
 * handing it back would put a full configuration, including whatever the host
 * resolved, into a surface that has no business holding one.
 */
export async function admitRemoteExternalRun(
  runId: string,
  stamp: ExternalAgentConfigStamp
): Promise<RemoteRunAdmission> {
  const result = await call<{
    admitted: boolean
    record?: ExternalAgentConfigRecord
    refusal?: RunAdmissionRefusal
  }>(HOST_CONFIG_COMMANDS.admit, { runId, stamp: { ...stamp } })

  if (result.admitted && result.record) {
    return { admitted: true, runId, record: result.record }
  }
  return {
    admitted: false,
    refusal: result.refusal ?? { kind: "config", reason: "unknown-config" },
    record: result.record,
  }
}

/**
 * Drop the host-side lease.
 *
 * Best-effort by contract: this runs on the settle path of a turn that may
 * already have failed, and a browser that cannot reach the host has no way to
 * release anything. The host's own retention sweep is the backstop, which is
 * why a failure here is swallowed rather than surfaced.
 */
export async function releaseRemoteExternalRun(runId: string): Promise<void> {
  try {
    await call<{ released: boolean }>(HOST_CONFIG_COMMANDS.release, { runId })
  } catch {
    // Intentionally silent — see the docstring.
  }
}
