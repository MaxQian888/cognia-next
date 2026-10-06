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
import type { ExternalAgentStateIsolation } from "@/types/agent/external-agent"
import type { RunAdmissionRefusal } from "../../policy/run-admission"
import {
  isCogniaGatewayModelCatalog,
  type CogniaGatewayModelCatalog,
} from "../../config/cognia-model-options"

/** The feature id that groups every operation in this module. */
export const HOST_CONFIGS_FEATURE = "external-agent.host-configs" as const

export const HOST_CONFIG_COMMANDS = Object.freeze({
  list: "external_agent_config_list",
  get: "external_agent_config_get",
  create: "external_agent_config_create",
  update: "external_agent_config_update",
  delete: "external_agent_config_delete",
  // Copy a configuration on the Host, keyring secrets included (ADR-0216).
  // A command of its own rather than read + create on the client: the copy's
  // secrets are the source's keyring entries, which never leave the Host.
  duplicate: "external_agent_config_duplicate",
  reconcile: "external_agent_config_reconcile",
  admit: "external_agent_admit_run",
  release: "external_agent_release_run",
  // The run plane. It rides the same feature id and therefore the same
  // availability gate: a host that can store a configuration but not run one
  // is not a runnable target, and a client has to be told which of the two it
  // is looking at rather than getting "unknown command" from the transport.
  run: "external_agent_run_turn",
  sessionQuery: "external_agent_session_query",
  sessionMutate: "external_agent_session_mutate",
  cancel: "external_agent_cancel_run",
  resolve: "external_agent_resolve_decision",
  // Which Cognia models a configuration can run on through the Host's own
  // gateway (ADR-0090, 2026-10-02). A read; the Host answers from its own
  // provider settings and vault.
  cogniaModels: "external_agent_cognia_models",
} as const)

export type HostConfigCommand = (typeof HOST_CONFIG_COMMANDS)[keyof typeof HOST_CONFIG_COMMANDS]

/**
 * Advertised operations that are not commands: a change to what an existing
 * command accepts. A Host built before `external_agent_run_turn` took
 * `cogniaModel` refuses the field outright (its request schema is closed), so
 * the client has to know before it sends one rather than learn from a 422.
 */
export const HOST_CONFIG_CAPABILITIES = Object.freeze({
  runTurnCogniaModel: "external_agent_run_turn_cognia_model",
} as const)

export type HostConfigCapability =
  (typeof HOST_CONFIG_CAPABILITIES)[keyof typeof HOST_CONFIG_CAPABILITIES]

export type HostConfigOperation = HostConfigCommand | HostConfigCapability

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
  readonly operation?: HostConfigOperation

  constructor(reason: HostConfigsUnavailableReason, operation?: HostConfigOperation) {
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
  operation?: HostConfigOperation
): { ok: true } | { ok: false; reason: HostConfigsUnavailableReason } {
  if (deps.hasLocalAuthority() && !deps.isRemoteHostActive()) return { ok: true }

  if (deps.isRemoteHostActive()) {
    const manifest = deps.activeHostFeatureManifest()
    if (!manifest) return { ok: false, reason: "manifest-missing" }
    const supports = (candidate: HostConfigOperation) =>
      supportsHostFeatureOperation(manifest, HOST_CONFIGS_FEATURE, candidate)
    return (operation ? supports(operation) : ANY_COMMAND.some(supports))
      ? { ok: true }
      : { ok: false, reason: "unsupported" }
  }

  const host = deps.getRuntimeSnapshot().host
  if (!host) return { ok: false, reason: "no-host" }
  if (host.compatible !== true) return { ok: false, reason: "unsupported" }
  const supports = (candidate: HostConfigOperation) => host.operations.includes(candidate)
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
 * Every `approval: "interactive"` command on this feature: the configuration
 * writes, and the two that start a run.
 *
 * All of them are a direct user action, so the short-lived approval is minted
 * at that boundary and used immediately; a lease must never be parked in a
 * durable queue where it can expire before dispatch. Local authority goes
 * through the service plane and does not need a device lease.
 *
 * Exported because the run plane is a separate module by concern and must not
 * reach the host through an ungated path: `callHostConfigCommand` checks the
 * handshake but attaches nothing, and the host refuses an interactive command
 * that arrives without a lease.
 */
export async function callApprovedHostConfigCommand<T>(
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

/**
 * The paired Host predates per-turn Cognia model selection.
 *
 * Its own class, carrying an i18n key, because this is the one refusal a user
 * sees mid-conversation — on send — and "update the Host" is the whole fix.
 * Still a `HostConfigsUnsupportedError`, so anything already handling that
 * family keeps working.
 */
export class HostCogniaModelUpdateRequiredError extends HostConfigsUnsupportedError {
  readonly code = "host-update-required" as const
  /** `externalAgent.cogniaModel.hostUpdateRequired` in the split i18n sources. */
  readonly i18nKey = "externalAgent.cogniaModel.hostUpdateRequired" as const

  constructor() {
    super("unsupported", HOST_CONFIG_CAPABILITIES.runTurnCogniaModel)
    this.name = "HostCogniaModelUpdateRequiredError"
    this.message = "Update the Host to use Cognia models with this agent."
  }
}

/**
 * Can the active Host run a turn on a Cognia model it is handed per turn?
 * Local authority always can: the field and its handler ship together.
 */
export function hostSupportsCogniaModelTurns(): boolean {
  return hostConfigsAvailability(HOST_CONFIG_CAPABILITIES.runTurnCogniaModel).ok
}

/**
 * Which Cognia models `configId` can run on through the active Host's gateway.
 *
 * A Host that does not advertise the operation answers
 * `host-update-required` as data, because that is a state the picker renders
 * ("update the Host"), not a failure. No paired Host, or one whose manifest has
 * not arrived, is still the structured refusal every sibling call gives.
 */
export async function fetchHostCogniaModels(configId: string): Promise<CogniaGatewayModelCatalog> {
  const operation = HOST_CONFIG_COMMANDS.cogniaModels
  const availability = hostConfigsAvailability(operation)
  if (!availability.ok) {
    if (availability.reason === "unsupported") {
      return { supported: false, reason: "host-update-required" }
    }
    throw new HostConfigsUnsupportedError(availability.reason, operation)
  }
  const result = await deps.call<unknown>(operation, { configId })
  if (!isCogniaGatewayModelCatalog(result)) {
    throw new Error("The paired host returned a malformed Cognia model catalog")
  }
  return result
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
  const result = await callApprovedHostConfigCommand<{ config: ExternalAgentConfigRecord }>(
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
  const result = await callApprovedHostConfigCommand<{ config: ExternalAgentConfigRecord }>(
    HOST_CONFIG_COMMANDS.update,
    input as unknown as Record<string, unknown>
  )
  return result.config
}

export async function deleteRemoteHostConfig(configId: string): Promise<ExternalAgentConfigRecord> {
  const result = await callApprovedHostConfigCommand<{ config: ExternalAgentConfigRecord }>(
    HOST_CONFIG_COMMANDS.delete,
    { configId }
  )
  return result.config
}

/** What the person duplicating chose. Omitted fields take the Host's defaults. */
export interface RemoteHostConfigDuplicateOptions {
  name?: string
  stateIsolation?: ExternalAgentStateIsolation
  enabled?: boolean
}

/**
 * Copy a Host configuration into a new one on the same Host.
 *
 * The Host builds the copy and moves the source's secrets into the copy's own
 * keyring slots; this client only names the source and the choices. The copy
 * is never connected — it runs when a turn is admitted against it.
 */
export async function duplicateRemoteHostConfig(
  configId: string,
  options: RemoteHostConfigDuplicateOptions = {}
): Promise<ExternalAgentConfigRecord> {
  const result = await callApprovedHostConfigCommand<{ config: ExternalAgentConfigRecord }>(
    HOST_CONFIG_COMMANDS.duplicate,
    {
      configId,
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.stateIsolation !== undefined ? { stateIsolation: options.stateIsolation } : {}),
      ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
    }
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
  const result = await callApprovedHostConfigCommand<{ outcomes: RemoteReconcileOutcome[] }>(
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
  const result = await callApprovedHostConfigCommand<{
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
