/**
 * Host-owned external-agent configurations: the layer the RPC commands call.
 *
 * The Dexie module underneath (`lib/db/external-agent-configs.ts`) knows about
 * heads, revisions and compare-and-swap. It deliberately knows nothing about
 * credentials or readiness. This layer adds the two governance steps that must
 * happen on every write, and would otherwise be re-implemented (differently) by
 * each caller:
 *
 *   1. **Scrub inline secrets.** `scrubInlineCredentials` moves an inline key
 *      into `credentialRefs`. It matters more here than on the desktop store
 *      because revisions are *retained*: a secret written into a revision would
 *      outlive the edit that removed it.
 *   2. **Assess readiness.** `ExternalAgentLifecycleService.assessReadiness`
 *      already decides `needs-credentials` / `needs-consent` / `needs-runtime`
 *      / `blocked`, consulting the runtime catalog, the keyring and the
 *      platform sandbox rules. Re-deriving any of that here would be a second
 *      opinion on a question that has an owner.
 *
 * Nothing here installs anything. An import that names a runtime this host does
 * not have is stored **disabled with a reason**, not silently repaired: pulling
 * a package down because a configuration arrived from a browser is a supply
 * chain decision, and it belongs to an operator.
 */

import {
  collectExternalAgentConfigRevisions,
  createExternalAgentConfig,
  deleteExternalAgentConfig,
  getExternalAgentConfig,
  listExternalAgentConfigs,
  updateExternalAgentConfig,
} from "@/lib/db/external-agent-configs"
import type { StoredExternalAgentConfig } from "@/stores/agent/external-agent-store/types"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"
import type {
  ExternalAgentCredentialSlot,
  ExternalAgentLifecycleStatus,
} from "@/types/agent/external-agent-lifecycle"

import { credentialsRequiredByImport, scrubInlineCredentials } from "./lifecycle/credentials"
import type { LifecycleAgentConfig } from "./lifecycle/credentials"
import type { ReadinessVerdict } from "./lifecycle/service"

/** The one host fact this layer needs. Injected so it is testable without a keyring. */
export type ReadinessAssessor = (config: LifecycleAgentConfig) => Promise<ReadinessVerdict>

export interface HostConfigServiceDeps {
  assessReadiness: ReadinessAssessor
  now?: () => number
}

/**
 * What a delete needs, which is only the clock.
 *
 * Separate from {@link HostConfigServiceDeps} on purpose: a tombstone write
 * assesses nothing, and requiring the assessor would make every delete resolve
 * `lifecycle/service` — the keyring, the manager and the adapter registry —
 * turning a locked keyring into a failed delete.
 */
export interface HostConfigDeleteDeps {
  now?: () => number
}

/**
 * The real assessor, resolved lazily.
 *
 * Dynamic because `lifecycle/service` reaches the keyring, the manager and the
 * adapter registry; importing it statically would drag all three into the boot
 * graph of anything that merely lists configurations.
 */
export async function defaultReadinessAssessor(): Promise<ReadinessAssessor> {
  const { getExternalAgentLifecycleService } = await import("./lifecycle/service")
  const service = await getExternalAgentLifecycleService()
  return (config) => service.assessReadiness(config)
}

/**
 * Apply a readiness verdict to a config.
 *
 * A configuration that is not `ready` is also forced **disabled**. The two are
 * separable in principle — "the user wants this on" versus "it can run" — but
 * keeping an unrunnable config enabled means every turn that selects it fails
 * at spawn time instead of being refused at admission, which is both later and
 * harder to explain.
 */
export function applyVerdict(
  config: StoredExternalAgentConfig,
  verdict: ReadinessVerdict
): StoredExternalAgentConfig {
  const next: StoredExternalAgentConfig = {
    ...config,
    lifecycleStatus: verdict.status,
    lifecycleReasonCode: verdict.reasonCode,
    lifecycleReason: verdict.reason,
  }
  if (verdict.status !== "ready") next.enabled = false
  return next
}

/**
 * Prepare an incoming configuration for storage: scrub, then assess.
 *
 * Order matters. Assessing before scrubbing would let an inline secret satisfy
 * the credential check and then be removed on the way to disk, storing a
 * config marked `ready` that has no credential at all.
 */
async function prepare(
  config: StoredExternalAgentConfig,
  deps: HostConfigServiceDeps
): Promise<StoredExternalAgentConfig> {
  const scrubbed = scrubInlineCredentials(config as unknown as LifecycleAgentConfig)
  const verdict = await deps.assessReadiness(scrubbed)
  return applyVerdict(scrubbed as unknown as StoredExternalAgentConfig, verdict)
}

export async function listHostExternalAgentConfigs(): Promise<ExternalAgentConfigRecord[]> {
  return listExternalAgentConfigs()
}

export async function getHostExternalAgentConfig(
  configId: string
): Promise<ExternalAgentConfigRecord | null> {
  return getExternalAgentConfig(configId)
}

export interface CreateHostConfigInput {
  config: StoredExternalAgentConfig
  /**
   * The configuration came from a browser's "copy to host" export. Its
   * `credentialRefs` name keys in a keyring this host does not have, and its
   * consent records were granted for a different machine, so both are dropped
   * rather than trusted — the operator re-provisions them here.
   */
  fromImport?: boolean
}

export async function createHostExternalAgentConfig(
  input: CreateHostConfigInput,
  deps: HostConfigServiceDeps
): Promise<ExternalAgentConfigRecord> {
  let incoming = input.config
  if (input.fromImport) {
    incoming = {
      ...incoming,
      credentialRefs: undefined,
      unsandboxedConsent: undefined,
      // An import is never trusted to arrive enabled: it has, by construction,
      // no credentials on this host yet.
      enabled: false,
      // Where the copy came from, so the two records can be recognised as one
      // agent later. The store mints its own `eac_*` id, which is why the
      // sending id has to be recorded as provenance rather than kept: without
      // it the only key left is the name, and a rename on either side turns
      // one agent back into two rows in the runtime picker. Provenance only
      // ever feeds that join, never admission or readiness.
      ...(incoming.id
        ? { metadata: { ...incoming.metadata, importedFromAgentId: incoming.id } }
        : {}),
    }
  }
  const prepared = await prepare(incoming, deps)
  return createExternalAgentConfig({ config: prepared, now: deps.now?.() })
}

export interface UpdateHostConfigInput {
  configId: string
  expectedRevision: string
  /** A shallow patch. `id` is ignored — the store owns it. */
  patch: Partial<StoredExternalAgentConfig>
}

export async function updateHostExternalAgentConfig(
  input: UpdateHostConfigInput,
  deps: HostConfigServiceDeps
): Promise<ExternalAgentConfigRecord> {
  // Readiness is assessed against the MERGED config, which is only knowable
  // once the current revision is read. The store's `mutate` runs inside the
  // transaction, so the merge is computed here from a pre-read and re-verified
  // by the CAS — an edit that raced loses on the revision check, not on a
  // stale assessment.
  const current = await getExternalAgentConfig(input.configId)
  if (!current) {
    const { ExternalAgentConfigNotFoundError } = await import("@/lib/db/external-agent-configs")
    throw new ExternalAgentConfigNotFoundError(input.configId)
  }
  const { id: _ignoredId, ...patch } = input.patch
  const merged = await prepare({ ...current.config, ...patch }, deps)

  const next = await updateExternalAgentConfig({
    configId: input.configId,
    expectedRevision: input.expectedRevision,
    mutate: () => merged,
    now: deps.now?.(),
  })
  await applyRevocation(current, next)
  return next
}

/**
 * Act on what a configuration change did to runs already admitted against it.
 *
 * `revocationEffect` owns the distinction; this only carries it out. A `drain`
 * is deliberately nothing: the run holds a lease on an immutable revision, so
 * what it is executing is still exactly what was approved and killing it would
 * lose work for a bookkeeping change. A `cancel` means the authority the run
 * is executing under is gone — a credential revoked, a consent withdrawn — so
 * it stops now.
 *
 * Imported dynamically because `remote-run-service` reaches back into this
 * module through `run-admission`; a static import would close the cycle.
 * Failures are swallowed: the configuration write has already happened, and
 * refusing it after the fact would leave the caller with neither the edit nor
 * an accurate error.
 */
async function applyRevocation(
  before: ExternalAgentConfigRecord,
  after: ExternalAgentConfigRecord
): Promise<void> {
  const { revocationEffect } = await import("./run-admission")
  if (revocationEffect(before, after) !== "cancel") return
  try {
    const { activeRemoteExternalRuns, cancelRemoteExternalRun } =
      await import("./remote-run-service")
    // The manager's agent id IS the configuration id, so this is every run
    // currently streaming against the configuration that just changed.
    for (const run of activeRemoteExternalRuns()) {
      if (run.agentId === after.configId) await cancelRemoteExternalRun(run.runId)
    }
  } catch {
    // No run plane on this host, or it failed to stop a run that had already
    // ended. Either way the configuration change itself stands.
  }
}

export async function deleteHostExternalAgentConfig(
  configId: string,
  deps: HostConfigDeleteDeps = {}
): Promise<ExternalAgentConfigRecord> {
  const before = await getExternalAgentConfig(configId)
  const after = await deleteExternalAgentConfig(configId, deps.now?.() ?? Date.now())
  if (before) await applyRevocation(before, after)
  return after
}

/** What one configuration's reconciliation did. */
export interface ReconcileOutcome {
  configId: string
  from: ExternalAgentLifecycleStatus
  to: ExternalAgentLifecycleStatus
  changed: boolean
}

/**
 * Re-assess every live configuration.
 *
 * Run at host startup and after a credential change: readiness is a statement
 * about the host, and the host moves underneath a stored verdict (a key is
 * revoked, a runtime is uninstalled). A configuration whose verdict is
 * unchanged is NOT rewritten — an unconditional write would append a revision
 * per startup and move `lifecycleGeneration`, cancelling in-flight runs for
 * nothing.
 */
export async function reconcileHostExternalAgentConfigs(
  deps: HostConfigServiceDeps
): Promise<ReconcileOutcome[]> {
  const records = await listExternalAgentConfigs()
  const outcomes: ReconcileOutcome[] = []

  for (const record of records) {
    const from = record.lifecycleStatus
    const verdict = await deps.assessReadiness(record.config as unknown as LifecycleAgentConfig)
    if (
      verdict.status === from &&
      verdict.reasonCode === record.config.lifecycleReasonCode &&
      verdict.reason === record.config.lifecycleReason
    ) {
      outcomes.push({ configId: record.configId, from, to: from, changed: false })
      continue
    }
    const next = await updateExternalAgentConfig({
      configId: record.configId,
      expectedRevision: record.revision,
      mutate: (config) => applyVerdict(config, verdict),
      now: deps.now?.(),
    })
    // A verdict that moved off `ready` is a revocation, not a rename: this is
    // the path a deleted keyring entry or an uninstalled runtime arrives on,
    // and a run still executing under that authority has to stop.
    await applyRevocation(record, next)
    outcomes.push({ configId: record.configId, from, to: verdict.status, changed: true })
  }

  // Reconciliation is the maintenance pass, so it is also where the retention
  // sweep belongs: every changed verdict above appended a revision, and
  // without a caller `collectExternalAgentConfigRevisions` never runs for a
  // host whose configurations are edited but rarely executed.
  try {
    await collectExternalAgentConfigRevisions()
  } catch {
    // Best effort — the next reconciliation (or run release) sweeps again.
  }
  return outcomes
}

/**
 * Which credential slots an imported configuration still needs.
 *
 * Delegates to the lifecycle module's reader so the marker written by
 * `sanitizeConfigForExport` is interpreted in exactly one place.
 */
export function importedConfigCredentialGaps(
  config: StoredExternalAgentConfig
): ExternalAgentCredentialSlot[] {
  return credentialsRequiredByImport(config as unknown as LifecycleAgentConfig)
}
