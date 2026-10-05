/**
 * Host-owned external-agent configurations: the layer the RPC commands call.
 *
 * The Dexie module underneath (`lib/db/external-agent-configs.ts`) knows about
 * heads, revisions and compare-and-swap. It deliberately knows nothing about
 * credentials or readiness. This layer adds the governance steps that must
 * happen on every write, and would otherwise be re-implemented (differently) by
 * each caller:
 *
 *   1. **Move inline secrets into the keyring.** An inline key, token, secret
 *      header, secret env value or OpenCode server password is written to the
 *      host keyring under THIS configuration's own slots
 *      (`credentialKeyId(configId, slot)`), `credentialRefs` is pointed at
 *      them, and the value is scrubbed from the stored config. The scrub
 *      matters more here than on the desktop store because revisions are
 *      *retained*: a secret written into a revision would outlive the edit
 *      that removed it. The keyring write matters because a scrub alone
 *      silently throws the user's credential away.
 *   2. **Refuse borrowed credentials.** Outside an import (which drops refs
 *      wholesale), a `credentialRefs` entry must name one of the
 *      configuration's own slots. A ref to another configuration's slot would
 *      let config X launch with config Y's secret, which is the sharing two
 *      configurations of one runtime exist to avoid (ADR-0216).
 *   3. **Assess readiness.** `ExternalAgentLifecycleService.assessReadiness`
 *      already decides `needs-credentials` / `needs-consent` / `needs-runtime`
 *      / `blocked`, consulting the runtime catalog, the keyring and the
 *      platform sandbox rules. Re-deriving any of that here would be a second
 *      opinion on a question that has an owner.
 *
 * Launching never reads secrets from here: the run service mounts the stored
 * config (refs only) through `ExternalAgentManager.addAgent`, whose launch
 * preparer (`lifecycle/launch-preparation.ts`) resolves the refs from the same
 * keyring namespace immediately before the spawn.
 *
 * Nothing here installs anything. An import that names a runtime this host does
 * not have is stored **disabled with a reason**, not silently repaired: pulling
 * a package down because a configuration arrived from a browser is a supply
 * chain decision, and it belongs to an operator.
 */

import {
  ExternalAgentConfigConflictError,
  ExternalAgentConfigNotFoundError,
  collectExternalAgentConfigRevisions,
  createExternalAgentConfig,
  deleteExternalAgentConfig,
  getExternalAgentConfig,
  listExternalAgentConfigs,
  updateExternalAgentConfig,
} from "@/lib/db/external-agent-configs"
import type { KeyringStore } from "@/lib/credentials/keyring-store"
import type { StoredExternalAgentConfig } from "@/stores/agent/external-agent-store/types"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"
import {
  ExternalAgentLifecycleError,
  type ExternalAgentCredentialRefs,
  type ExternalAgentCredentialSlot,
  type ExternalAgentLifecycleStatus,
} from "@/types/agent/external-agent-lifecycle"

import type { ExternalAgentConfig, ExternalAgentStateIsolation } from "@/types/agent/external-agent"
import type { AppSettings } from "@cognia/agent-config-types"
import type { SubscriptionProviderDefinition } from "@/types/subscription/provider-definition"

import type {
  CogniaGatewayModelCatalog,
  CogniaGatewayModelCatalogUnsupportedReason,
  CogniaGatewayProviderOption,
  HostGatewayCapabilities,
  HostProfileStoreDocs,
} from "./cognia-model-options"
import {
  EXTERNAL_AGENT_KEYRING_NAMESPACE,
  clearCredentials,
  credentialsRequiredByImport,
  extractInlineCredentials,
  occupiedSlots,
  persistCredentials,
  resolveCredentials,
  scrubInlineCredentials,
  type ExternalAgentSecrets,
} from "../lifecycle/credentials"
import type { LifecycleAgentConfig } from "../lifecycle/credentials"
import { stateIsolationBlockReason } from "../lifecycle/launch-preparation"
import type { ReadinessVerdict } from "../lifecycle/service"
import { AGENT_STATE_KEY_PATTERN } from "../policy/security-policy"
import { externalAgentDuplicateInput, uniqueDuplicateName } from "./duplicate-config"
import { ownCredentialRefs } from "./host-config-mount"

/** The one host fact this layer needs. Injected so it is testable without a keyring. */
export type ReadinessAssessor = (config: LifecycleAgentConfig) => Promise<ReadinessVerdict>

export interface HostConfigServiceDeps {
  assessReadiness: ReadinessAssessor
  now?: () => number
  /**
   * The host keyring, `external-agent` namespace: the one the launch preparer
   * and the lifecycle service resolve `credentialRefs` from. Created lazily
   * when absent, and only by a write that actually carries a secret.
   */
  keyring?: KeyringStore
}

/**
 * What a delete needs: the clock, and the two cleanups a deleted
 * configuration owes the host.
 *
 * Separate from {@link HostConfigServiceDeps} on purpose: a tombstone write
 * assesses nothing, and requiring the assessor would make every delete resolve
 * `lifecycle/service` — the keyring, the manager and the adapter registry. The
 * keyring here is the bare store, resolved after the tombstone is written, so
 * a locked keyring can no longer turn into a delete that did not happen.
 */
export interface HostConfigDeleteDeps {
  now?: () => number
  keyring?: KeyringStore
  /** Remove the configuration's private state root (ADR-0216). */
  removeStateRoot?: (configId: string) => Promise<void>
}

/** Thrown when a write names a keyring slot the configuration does not own. */
export class HostConfigForeignCredentialRefError extends Error {
  readonly code = "external_agent_config_foreign_credential_ref"

  constructor(
    readonly slot: string,
    readonly configId: string | null
  ) {
    super(
      configId
        ? `credentialRefs.${slot} must name one of configuration ${configId}'s own keyring slots`
        : `credentialRefs.${slot} cannot be set on create: a new configuration has no keyring slots yet; send the secret inline and the host stores it`
    )
    this.name = "HostConfigForeignCredentialRefError"
  }
}

/**
 * The configuration was deleted, but what it left on the host could not all be
 * removed. Thrown after the tombstone is written, so the caller learns the
 * delete stands and what to clean up by hand.
 */
export class HostConfigCleanupError extends Error {
  readonly code = "external_agent_config_cleanup_failed"

  constructor(
    readonly configId: string,
    readonly failures: string[]
  ) {
    super(
      `configuration ${configId} was deleted, but its host data could not all be removed: ${failures.join("; ")}`
    )
    this.name = "HostConfigCleanupError"
  }
}

let defaultKeyring: Promise<KeyringStore> | null = null

/** The deps' keyring, or the host's `external-agent` namespace (created once). */
async function keyringOf(deps: { keyring?: KeyringStore }): Promise<KeyringStore> {
  if (deps.keyring) return deps.keyring
  defaultKeyring ??= import("@/lib/credentials/keyring-store").then(({ createKeyringStore }) =>
    createKeyringStore(EXTERNAL_AGENT_KEYRING_NAMESPACE)
  )
  return defaultKeyring
}

/** Test seam. Forgets the lazily created default keyring. */
export function __resetHostConfigKeyringForTests(): void {
  defaultKeyring = null
}

/** Whether a keyring key id is one of `configId`'s own slots. */
function ownsCredentialKey(configId: string, keyId: unknown): boolean {
  return typeof keyId === "string" && keyId.startsWith(`${configId}:`)
}

/**
 * Refuse a `credentialRefs` map that names a slot this configuration does not
 * own. `configId` is `null` on a create, where no slot can be owned yet.
 */
export function assertOwnCredentialRefs(
  refs: ExternalAgentCredentialRefs | undefined | null,
  configId: string | null
): void {
  if (!refs) return
  for (const [slot, keyId] of Object.entries(refs)) {
    if (keyId === undefined) continue
    if (configId === null || !ownsCredentialKey(configId, keyId)) {
      throw new HostConfigForeignCredentialRefError(slot, configId)
    }
  }
}

/** Only the refs that name `configId`'s own slots (shared with the mount). */
const ownRefs = ownCredentialRefs

/**
 * Layer `next` over `base`. The two map slots (secret headers, secret env
 * values) merge by name, so adding one env secret does not drop the others the
 * keyring already holds; every other slot is replaced.
 */
function mergeSecrets(
  base: ExternalAgentSecrets,
  next: ExternalAgentSecrets
): ExternalAgentSecrets {
  const merged: ExternalAgentSecrets = { ...base, ...next }
  if (base.headers || next.headers) merged.headers = { ...base.headers, ...next.headers }
  if (base.processEnv || next.processEnv) {
    merged.processEnv = { ...base.processEnv, ...next.processEnv }
  }
  return merged
}

/**
 * The secrets this configuration's own slots hold, best effort: a slot whose
 * entry is gone is skipped rather than failing an edit that is about to write
 * the slots again anyway.
 */
async function readOwnSecretsLenient(
  config: StoredExternalAgentConfig,
  configId: string,
  keyring: KeyringStore
): Promise<ExternalAgentSecrets> {
  const refs = ownRefs(config.credentialRefs, configId)
  const secrets: ExternalAgentSecrets = {}
  for (const slot of Object.keys(refs) as ExternalAgentCredentialSlot[]) {
    try {
      Object.assign(secrets, await resolveCredentials({ [slot]: refs[slot] }, keyring))
    } catch (error) {
      if (!(error instanceof ExternalAgentLifecycleError)) throw error
    }
  }
  return secrets
}

/**
 * The state isolation a new configuration gets when the caller did not choose
 * one: `isolated` (ADR-0216), unless its runtime has no documented home to
 * isolate, in which case `isolated` could never launch and `shared` is the
 * only setting that runs.
 */
function defaultStateIsolation(config: StoredExternalAgentConfig): ExternalAgentStateIsolation {
  const probe = {
    ...(config as unknown as ExternalAgentConfig),
    id: "eac_probe",
    stateIsolation: "isolated" as const,
  }
  return stateIsolationBlockReason(probe) === null ? "isolated" : "shared"
}

/**
 * An `isolated` configuration its runtime cannot isolate is blocked, said at
 * write time rather than discovered as a failed mount when a run is admitted.
 */
function isolationVerdict(config: StoredExternalAgentConfig): ReadinessVerdict | null {
  const id =
    typeof config.id === "string" && AGENT_STATE_KEY_PATTERN.test(config.id)
      ? config.id
      : "eac_probe"
  const reason = stateIsolationBlockReason({
    ...(config as unknown as ExternalAgentConfig),
    id,
  })
  return reason ? { status: "blocked", reasonCode: "state_isolation_unsupported", reason } : null
}

/**
 * The real assessor, resolved lazily.
 *
 * Dynamic because `lifecycle/service` reaches the keyring, the manager and the
 * adapter registry; importing it statically would drag all three into the boot
 * graph of anything that merely lists configurations.
 */
export async function defaultReadinessAssessor(): Promise<ReadinessAssessor> {
  const { getExternalAgentLifecycleService } = await import("../lifecycle/service")
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
  const assessed = await deps.assessReadiness(scrubbed)
  const verdict =
    assessed.status === "ready"
      ? (isolationVerdict(scrubbed as unknown as StoredExternalAgentConfig) ?? assessed)
      : assessed
  return applyVerdict(scrubbed as unknown as StoredExternalAgentConfig, verdict)
}

/** What a configuration looks like while its secrets are being written. */
const STORING_CREDENTIALS: ReadinessVerdict = {
  status: "needs-credentials",
  reasonCode: "credential_missing",
  reason: "credentials are being stored on this host",
}

/**
 * Create a configuration and move `secrets` into its own keyring slots.
 *
 * The store mints the id, so the slots cannot be named before the row exists.
 * The create is therefore two writes: a first revision that is scrubbed,
 * disabled and marked `needs-credentials` (never runnable, and honest if the
 * second write never happens), then — once the secrets are in the keyring —
 * the real revision with `credentialRefs` pointing at them, assessed and
 * enabled as asked. A failure in between deletes the row and its slots rather
 * than leaving a half-made configuration behind.
 */
async function createWithSecrets(
  config: StoredExternalAgentConfig,
  secrets: ExternalAgentSecrets,
  deps: HostConfigServiceDeps
): Promise<ExternalAgentConfigRecord> {
  const scrubbed = scrubInlineCredentials(config as unknown as LifecycleAgentConfig)
  delete scrubbed.credentialRefs
  const base = scrubbed as unknown as StoredExternalAgentConfig
  if (occupiedSlots(secrets).length === 0) {
    return createExternalAgentConfig({ config: await prepare(base, deps), now: deps.now?.() })
  }

  const created = await createExternalAgentConfig({
    config: applyVerdict({ ...base, enabled: false }, STORING_CREDENTIALS),
    now: deps.now?.(),
  })
  const keyring = await keyringOf(deps)
  try {
    const credentialRefs = await persistCredentials(created.configId, secrets, keyring)
    const final = await prepare({ ...base, id: created.configId, credentialRefs }, deps)
    return await updateExternalAgentConfig({
      configId: created.configId,
      expectedRevision: created.revision,
      mutate: () => final,
      now: deps.now?.(),
    })
  } catch (error) {
    try {
      await clearCredentials(created.configId, keyring)
    } finally {
      await deleteExternalAgentConfig(created.configId, deps.now?.() ?? Date.now())
    }
    throw error
  }
}

export async function listHostExternalAgentConfigs(): Promise<ExternalAgentConfigRecord[]> {
  return listExternalAgentConfigs()
}

export async function getHostExternalAgentConfig(
  configId: string
): Promise<ExternalAgentConfigRecord | null> {
  return getExternalAgentConfig(configId)
}

/**
 * `cogniaGatewaySupport(config)`'s verdict (`./gateway-task`): whether this
 * configuration's runtime has a gateway launch contract on this Host.
 */
export type CogniaGatewaySupportVerdict =
  { supported: true; runtime: string } | { supported: false; reason: string }

/** The Host facts the Cognia model catalog is computed from. Injected for tests. */
export interface HostCogniaModelCatalogDeps {
  getConfig: (configId: string) => Promise<ExternalAgentConfigRecord | null>
  support: (config: ExternalAgentConfig) => CogniaGatewaySupportVerdict
  /** The Host's live provider settings, as the gateway route will read them. */
  readSettings: () => Pick<AppSettings, "providerSettings" | "customProviders"> | null | undefined
  /** True while the Host's Cognia account is locked (settings and vault unreadable). */
  accountLocked: () => boolean
  subscriptions?: (
    customProviders: AppSettings["customProviders"] | undefined
  ) => readonly SubscriptionProviderDefinition[]
  /**
   * Vault account ids for one API-key subscription provider. Best-effort: a
   * Host whose vault cannot be listed offers the provider default only.
   */
  listAccountIds?: (subscriptionProviderId: string) => Promise<string[]>
  /**
   * The Host's provider catalog when it does not come from renderer settings.
   * The headless brain has none: its providers live in `cognia-server`'s
   * Provider Profile Store and gateway snapshot, which is what its task route
   * (`agent_gateway_host_task_prepare`) mints against, so the catalog is read
   * from there instead.
   */
  hostProviders?: () => Promise<CogniaGatewayProviderOption[]>
}

/**
 * The headless Host's provider catalog: the redacted profile export for names,
 * the gateway snapshot for what is actually servable. Both are service-scope
 * reads of `cognia-server`; neither carries a credential.
 */
async function readHeadlessHostProviders(): Promise<CogniaGatewayProviderOption[]> {
  const [{ transport }, { listHostProfileGatewayModelOptions }] = await Promise.all([
    import("@/lib/tauri"),
    import("./cognia-model-options"),
  ])
  const [docs, capabilities] = await Promise.all([
    transport.call<HostProfileStoreDocs>("provider_profiles_list"),
    transport.call<HostGatewayCapabilities>("gateway_provider_capabilities"),
  ])
  return listHostProfileGatewayModelOptions(docs, capabilities)
}

export async function defaultHostCogniaModelCatalogDeps(): Promise<HostCogniaModelCatalogDeps> {
  const [
    { cogniaGatewaySupport },
    { useSettingsStore },
    { useAccountStore },
    { listSubscriptionProviders },
    { isHeadlessHost },
  ] = await Promise.all([
    import("./gateway-task"),
    import("@/stores/settings"),
    import("@/stores/account/account-store"),
    import("@/lib/subscription/core/provider-registry"),
    import("@/lib/platform/detect"),
  ])
  if (isHeadlessHost()) {
    return {
      getConfig: getExternalAgentConfig,
      support: (config) => cogniaGatewaySupport(config) as CogniaGatewaySupportVerdict,
      readSettings: () => null,
      accountLocked: () => useAccountStore.getState().locked === true,
      hostProviders: readHeadlessHostProviders,
    }
  }
  return {
    getConfig: getExternalAgentConfig,
    support: (config) => cogniaGatewaySupport(config) as CogniaGatewaySupportVerdict,
    readSettings: () => useSettingsStore.getState().settings,
    accountLocked: () => useAccountStore.getState().locked === true,
    subscriptions: (customProviders) => listSubscriptionProviders(customProviders ?? []),
    listAccountIds: async (subscriptionProviderId) => {
      const { listAccounts } = await import("@/lib/subscription/core/transport")
      return (await listAccounts(subscriptionProviderId)).map((account) => account.id)
    },
  }
}

function catalogReason(
  reason: string,
  known: readonly CogniaGatewayModelCatalogUnsupportedReason[]
): CogniaGatewayModelCatalogUnsupportedReason {
  return known.includes(reason as CogniaGatewayModelCatalogUnsupportedReason)
    ? (reason as CogniaGatewayModelCatalogUnsupportedReason)
    : "unsupported-runtime"
}

/**
 * Which Cognia models this Host can run `configId` on through its own gateway.
 *
 * Answered from the Host's settings and vault — the same ones
 * `prepareExternalAgentGatewayRoute` resolves a task against — so a paired
 * device is offered exactly what a turn here could launch. The catalog carries
 * identifiers and capability facts only (`listCogniaGatewayModelOptions`).
 *
 * The order of the refusals is the order a user can act on them: a runtime
 * that cannot use the gateway at all is not fixed by unlocking the account, and
 * an empty provider list means nothing until the account is readable.
 */
export async function getHostCogniaModelCatalog(
  configId: string,
  deps: HostCogniaModelCatalogDeps
): Promise<CogniaGatewayModelCatalog> {
  const record = await deps.getConfig(configId)
  if (!record || record.tombstonedAt !== undefined) {
    throw new Error(`external_agent_cognia_models: unknown configuration ${configId}`)
  }
  // Loaded on demand: the model catalog pulls in the provider registry, which
  // no other operation of this service needs.
  const { COGNIA_GATEWAY_MODEL_CATALOG_REASONS, listCogniaGatewayModelOptions } =
    await import("./cognia-model-options")
  const support = deps.support(record.config as unknown as ExternalAgentConfig)
  if (!support.supported) {
    return {
      supported: false,
      reason: catalogReason(support.reason, COGNIA_GATEWAY_MODEL_CATALOG_REASONS),
    }
  }
  if (deps.accountLocked()) return { supported: false, reason: "account-locked" }
  if (deps.hostProviders) {
    const hosted = await deps.hostProviders()
    return hosted.length > 0
      ? { supported: true, providers: hosted }
      : { supported: false, reason: "no-eligible-models" }
  }
  const settings = deps.readSettings()
  if (!settings) throw new Error("Cognia provider settings are unavailable on this host")
  const subscriptions = deps.subscriptions?.(settings.customProviders)
  const providers = listCogniaGatewayModelOptions({ settings, subscriptions })
  if (providers.length === 0) return { supported: false, reason: "no-eligible-models" }
  if (deps.listAccountIds && subscriptions) {
    await Promise.all(
      providers.map(async (provider) => {
        const definition =
          subscriptions.find((entry) => entry.id === provider.providerId) ??
          subscriptions.find((entry) =>
            entry.plans?.some((plan) => plan.chatProviderId === provider.providerId)
          )
        if (definition?.authMode !== "api-key") return
        try {
          const ids = (await deps.listAccountIds!(definition.id)).filter(
            (id) => typeof id === "string" && id.length > 0
          )
          if (ids.length > 0) provider.accountIds = [...new Set(ids)]
        } catch {
          // See `listAccountIds`: the provider default still resolves at task start.
        }
      })
    )
  }
  return { supported: true, providers }
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
  } else {
    // An ordinary create has no id yet, so no slot it could own.
    assertOwnCredentialRefs(incoming.credentialRefs, null)
    if (incoming.stateIsolation === undefined) {
      incoming = { ...incoming, stateIsolation: defaultStateIsolation(incoming) }
    }
  }
  return createWithSecrets(
    incoming,
    extractInlineCredentials(incoming as unknown as ExternalAgentConfig),
    deps
  )
}

export interface UpdateHostConfigInput {
  configId: string
  expectedRevision: string
  /**
   * A shallow patch. `id` is ignored — the store owns it. A patch crosses the
   * wire as JSON, which cannot carry `undefined`, so `null` is how a caller
   * clears one of {@link CLEARABLE_FIELDS}.
   */
  patch: Partial<StoredExternalAgentConfig>
}

/**
 * Optional fields an edit may clear by sending `null`; the stored config then
 * has no value at all, which is what "unset" means to every reader
 * (`maxConcurrentSessions` absent = no limit). `cogniaModel` and
 * `subscriptionAccountId` are not here: `null` is a stored value for them.
 */
const CLEARABLE_FIELDS = ["description", "maxConcurrentSessions", "sessionIdleTimeout"] as const

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
  if (current.tombstonedAt !== undefined) {
    throw new ExternalAgentConfigNotFoundError(input.configId)
  }
  const { id: _ignoredId, ...patch } = input.patch
  if (patch.credentialRefs !== undefined) {
    assertOwnCredentialRefs(patch.credentialRefs, input.configId)
  }
  const raw: StoredExternalAgentConfig = { ...current.config, ...patch, id: input.configId }
  for (const field of CLEARABLE_FIELDS) {
    if ((raw as unknown as Record<string, unknown>)[field] === null) delete raw[field]
  }

  const inline = extractInlineCredentials(raw as unknown as ExternalAgentConfig)
  if (occupiedSlots(inline).length > 0) {
    // The slots are deterministic per configuration, so writing one IS the
    // edit. Refuse a stale revision before touching the keyring, or a write
    // that then loses the compare-and-swap would still have changed the
    // credential the current revision launches with.
    if (current.revision !== input.expectedRevision) {
      throw new ExternalAgentConfigConflictError(current, input.expectedRevision)
    }
    const keyring = await keyringOf(deps)
    const existing = await readOwnSecretsLenient(current.config, input.configId, keyring)
    raw.credentialRefs = await persistCredentials(
      input.configId,
      mergeSecrets(existing, inline),
      keyring
    )
  }
  const merged = await prepare(raw, deps)

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
  const { revocationEffect } = await import("../policy/run-admission")
  if (revocationEffect(before, after) !== "cancel") return
  try {
    const { activeRemoteExternalRuns, cancelRemoteExternalRun } =
      await import("../runtimes/remote/remote-run-service")
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

/** The default state-root removal: the host command behind `state-root.ts`. */
async function defaultRemoveStateRoot(configId: string): Promise<void> {
  const { removeExternalAgentStateRoot } = await import("../lifecycle/state-root")
  await removeExternalAgentStateRoot(configId)
}

/**
 * Tombstone a configuration, then remove what it owned on this host.
 *
 * Order is load-bearing: the tombstone first, so no new run can be admitted;
 * the revocation next, which cancels the runs already streaming; and only then
 * its keyring slots and its private state root, which nothing is using any
 * more. Both cleanups are attempted even when one fails, and a failure is
 * reported AFTER the tombstone stands ({@link HostConfigCleanupError}).
 */
export async function deleteHostExternalAgentConfig(
  configId: string,
  deps: HostConfigDeleteDeps = {}
): Promise<ExternalAgentConfigRecord> {
  const before = await getExternalAgentConfig(configId)
  const after = await deleteExternalAgentConfig(configId, deps.now?.() ?? Date.now())
  if (before) await applyRevocation(before, after)

  const failures: string[] = []
  try {
    await clearCredentials(configId, await keyringOf(deps))
  } catch (error) {
    failures.push(`keyring: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    await (deps.removeStateRoot ?? defaultRemoveStateRoot)(configId)
  } catch (error) {
    failures.push(`state root: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (failures.length > 0) throw new HostConfigCleanupError(configId, failures)
  return after
}

export interface DuplicateHostConfigInput {
  /** The configuration to copy. */
  configId: string
  /** Defaults to the first free "<name> (copy)" among the host's configurations. */
  name?: string
  /** Defaults to `isolated`: a copy is a separate configuration (ADR-0216). */
  stateIsolation?: ExternalAgentStateIsolation
  /** Defaults to the source's state. A copy is never connected or run here. */
  enabled?: boolean
}

/** The host's own copy name when the caller sent none. The UI sends a localized one. */
function defaultCopyName(sourceName: string, index: number): string {
  return index === 1 ? `${sourceName} (copy)` : `${sourceName} (copy ${index})`
}

/**
 * Copy a host configuration, secrets included, into a new one.
 *
 * The copy is built by `externalAgentDuplicateInput` (the same rules the
 * desktop applies: lineage recorded, state-dir env and the OpenCode port and
 * password cut, isolation defaulting to `isolated`). The source's secrets —
 * resolved from its OWN slots, plus anything still inline from before slots
 * existed — are written into the copy's own slots before the copy's runnable
 * revision exists, so neither configuration ever reads the other's keyring
 * entry and removing one never breaks the other. Nothing is connected: the
 * host only spawns an agent when a run is admitted against it.
 *
 * A source ref whose keyring entry is gone fails the duplicate with
 * `credential_missing` rather than producing a copy that looks configured and
 * authenticates as nobody.
 */
export async function duplicateHostExternalAgentConfig(
  input: DuplicateHostConfigInput,
  deps: HostConfigServiceDeps
): Promise<ExternalAgentConfigRecord> {
  const record = await getExternalAgentConfig(input.configId)
  if (!record || record.tombstonedAt !== undefined) {
    throw new ExternalAgentConfigNotFoundError(input.configId)
  }
  const source = {
    ...(record.config as unknown as ExternalAgentConfig),
    id: record.configId,
  }
  const sourceName = source.name?.trim() || record.configId
  const name =
    input.name?.trim() ||
    uniqueDuplicateName(
      (await listExternalAgentConfigs()).map((row) => row.config.name ?? ""),
      (index) => defaultCopyName(sourceName, index)
    )

  const refs = ownRefs(record.config.credentialRefs, record.configId)
  const secrets = mergeSecrets(
    extractInlineCredentials(source),
    Object.keys(refs).length > 0 ? await resolveCredentials(refs, await keyringOf(deps)) : {}
  )

  const copyInput = externalAgentDuplicateInput(source, {
    name,
    stateIsolation: input.stateIsolation,
    enabled: input.enabled,
  })
  const metadata = copyInput.metadata ? { ...copyInput.metadata } : undefined
  // Provenance of the SOURCE: carried over, it would pair the copy with the
  // local agent the source was imported from, and that agent would appear to
  // run on two host rows.
  if (metadata) delete metadata.importedFromAgentId
  const now = new Date(deps.now?.() ?? Date.now()).toISOString()
  const copy: StoredExternalAgentConfig = {
    ...(copyInput as unknown as StoredExternalAgentConfig),
    id: record.configId,
    enabled: copyInput.enabled ?? record.enabled,
    ...(metadata ? { metadata } : {}),
    // The runtime the source is bound to is the runtime the copy runs; it is
    // identity, not instance state.
    ...(record.config.runtimeBinding ? { runtimeBinding: record.config.runtimeBinding } : {}),
    createdAt: now,
    updatedAt: now,
  }
  return createWithSecrets(copy, secrets, deps)
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
