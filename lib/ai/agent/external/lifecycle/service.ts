/**
 * The one mutation interface for external-Agent lifecycle.
 *
 * Before this existed, "lifecycle" was whatever each caller happened to do.
 * Settings wrote straight to the Zustand store, so an Agent added there was not
 * registered with the runtime manager until the next app restart, an edit left
 * the manager holding the previous config, and a delete could leave the child
 * process running. The Companion write path did the same thing from a paired
 * device. The manager, meanwhile, had no idea any of it had happened.
 *
 * Everything now routes through {@link ExternalAgentLifecycleService}: Settings,
 * the chat manager, Companion writes, startup rehydration, plugin teardown and
 * the CLI. Direct store mutation is internal persistence only.
 *
 * Dependencies are injected as ports so the service is testable without a
 * browser, a keyring or a child process — and
 * {@link createDefaultLifecycleDependencies} is exercised by its own test,
 * because an injected-deps module whose default wiring is never run is a module
 * whose production path is untested.
 *
 * @see types/agent/external-agent-lifecycle.ts
 */

import type { KeyringStore } from "@/lib/credentials/keyring-store"
import type {
  CreateExternalAgentInput,
  ExternalAgentConfig,
  ExternalAgentConnectionStatus,
  UpdateExternalAgentInput,
} from "@/types/agent/external-agent"
import {
  ExternalAgentLifecycleError,
  type ExternalAgentCredentialRefs,
  type ExternalAgentLifecycleErrorCode,
  type ExternalAgentLifecycleFields,
  type ExternalAgentLifecycleStatus,
  type ExternalAgentRuntimeCatalogEntry,
  type ExternalAgentRuntimeReceipt,
  type ExternalAgentRuntimeStatus,
  type ExternalAgentUpdateCandidate,
  type ExternalAgentVersionAssessment,
  type UnsandboxedLaunchConsent,
  type UnsandboxedLaunchIdentity,
  assessUnsandboxedConsent,
} from "@/types/agent/external-agent-lifecycle"

import {
  canonicalLaunchCommandString,
  deriveRuntimeBinding,
  findRuntimeById,
  isWindowsExceptionEligible,
  normalizePlatform,
  runtimeSupportsPlatform,
} from "../runtime-catalog"
// Type-only: importing this module for real pulls the registry client, and
// through it proxy-fetch and the settings store, into the boot graph. Startup
// rehydration imports this service, so a static import would make every launch
// pay for a listing most users never open.
import type { RegistryDiscoveryResult } from "./registry-discovery"
import { externalAgentSandboxSupportsPlatform } from "../security-policy"
import {
  EXTERNAL_AGENT_KEYRING_NAMESPACE,
  applyResolvedCredentials,
  clearCredentials,
  extractInlineCredentials,
  migrateInlineCredentials,
  occupiedSlots,
  persistCredentials,
  resolveCredentials,
  scrubInlineCredentials,
  type ExternalAgentSecrets,
  type LifecycleAgentConfig,
} from "./credentials"

// ============================================================================
// Ports
// ============================================================================

/** The persistence face. Implemented by the external-agent Zustand store. */
export interface LifecycleConfigStore {
  getAgent(id: string): LifecycleAgentConfig | undefined
  getAllAgents(): LifecycleAgentConfig[]
  addAgent(input: CreateExternalAgentInput): string
  updateAgent(id: string, updates: UpdateExternalAgentInput): void
  removeAgent(id: string): void
  /** Replace a stored config wholesale. The only way to REMOVE a field. */
  replaceAgentConfig(id: string, config: LifecycleAgentConfig): void
  /** Persist lifecycle-plane fields that are not part of the edit surface. */
  patchLifecycle(id: string, fields: ExternalAgentLifecycleFields): void
  setConnectionStatus(id: string, status: ExternalAgentConnectionStatus): void
}

/** The live-runtime face. Implemented by `ExternalAgentManager`. */
export interface LifecycleRuntimeManager {
  addAgent(config: ExternalAgentConfig): Promise<unknown>
  removeAgent(id: string): Promise<void>
  connect(id: string): Promise<void>
  disconnect(id: string): Promise<void>
  getAgent(id: string): { sessions: Map<string, unknown> } | undefined
  closeSession(agentId: string, sessionId: string): Promise<void>
}

/** Whether a protocol adapter is registered right now (plugins come and go). */
export interface LifecycleAdapterRegistry {
  isProtocolAvailable(protocol: string): boolean
}

/**
 * Install-side operations, which only exist on a host with a filesystem.
 *
 * Absent on the web shell and on any host that cannot own a managed root; every
 * call site treats absence as "this host does not install runtimes", not as an
 * error to swallow.
 */
export interface LifecycleRuntimeHost {
  inspect(runtimeId: string): Promise<{
    assessment: ExternalAgentVersionAssessment
    receipt?: ExternalAgentRuntimeReceipt
  }>
  install(runtimeId: string, version?: string): Promise<ExternalAgentRuntimeReceipt>
  checkForUpdate(runtimeId: string): Promise<ExternalAgentUpdateCandidate | null>
  update(runtimeId: string, toVersion: string): Promise<ExternalAgentRuntimeReceipt>
  rollback(runtimeId: string): Promise<ExternalAgentRuntimeReceipt>
  uninstall(runtimeId: string): Promise<void>
}

export interface LifecycleDependencies {
  store: LifecycleConfigStore
  manager: LifecycleRuntimeManager
  adapters: LifecycleAdapterRegistry
  keyring: KeyringStore
  runtimeHost?: LifecycleRuntimeHost
  /** Node-style platform id of this host. */
  platform: string
  /** Stable host identifier, so consent never travels between machines. */
  hostId: string
  /** Security-policy revision consent is bound to. */
  policyRevision: number
  now: () => Date
}

// ============================================================================
// Readiness
// ============================================================================

export interface ReadinessVerdict {
  status: ExternalAgentLifecycleStatus
  reasonCode?: ExternalAgentLifecycleErrorCode
  reason?: string
}

const READY: ReadinessVerdict = { status: "ready" }

/**
 * Fields whose change alters what would actually be launched or connected to.
 *
 * An edit to any of these has to tear the runtime down and rebuild it; an edit
 * to a label or a tag must not. Getting this wrong in the permissive direction
 * is what left the manager running the previous config after a Settings edit.
 */
const RUNTIME_AFFECTING_KEYS = [
  "process",
  "network",
  "codexOptions",
  "timeout",
  "retryConfig",
] as const satisfies readonly (keyof UpdateExternalAgentInput)[]

export function isRuntimeAffectingUpdate(updates: UpdateExternalAgentInput): boolean {
  return RUNTIME_AFFECTING_KEYS.some((key) => Object.prototype.hasOwnProperty.call(updates, key))
}

// ============================================================================
// Service
// ============================================================================

export class ExternalAgentLifecycleService {
  /**
   * Registry entries discovered this session.
   *
   * Session-scoped on purpose: a registry listing is a snapshot of a remote
   * document, and persisting it would create a second, staler catalog nobody
   * updates.
   */
  private readonly discoveredRuntimes = new Map<string, ExternalAgentRuntimeCatalogEntry>()

  constructor(private readonly deps: LifecycleDependencies) {}

  // --------------------------------------------------------------------
  // Configuration
  // --------------------------------------------------------------------

  /**
   * Create a configuration and register it with the runtime immediately.
   *
   * Any inline secret in the input goes to the keyring before the config is
   * persisted, so a plaintext token never reaches the store even transiently.
   */
  async createConfig(
    input: CreateExternalAgentInput & Partial<ExternalAgentLifecycleFields>
  ): Promise<string> {
    const secrets = extractInlineCredentials(input as ExternalAgentConfig)
    const sanitized = scrubInlineCredentials(input as ExternalAgentConfig)
    const id = this.deps.store.addAgent(sanitized as CreateExternalAgentInput)

    let credentialRefs: ExternalAgentCredentialRefs | undefined
    if (occupiedSlots(secrets).length > 0) {
      credentialRefs = await persistCredentials(id, secrets, this.deps.keyring)
    }

    const persisted = this.deps.store.getAgent(id)
    // Derive the binding rather than requiring every caller to know it. Without
    // one, live sessions are attributed to no runtime and an uninstall's
    // in-use guard can never fire.
    const runtimeBinding =
      input.runtimeBinding ?? (persisted ? deriveRuntimeBinding(persisted) : undefined)

    this.deps.store.patchLifecycle(id, {
      ...(runtimeBinding ? { runtimeBinding } : {}),
      ...(credentialRefs ? { credentialRefs } : {}),
    })

    const config = this.deps.store.getAgent(id)
    if (config?.enabled) {
      await this.register(config)
    } else if (config) {
      this.markVerdict(id, await this.assessReadiness(config))
    }

    return id
  }

  /**
   * Apply an edit, rebuilding the runtime only when the edit changes it.
   *
   * The rebuild order matters: tear down first, persist second, re-register
   * third. Persisting first would leave a window where the store and the live
   * adapter disagree, which is exactly the state the old Settings path was
   * permanently in.
   */
  async updateConfig(
    id: string,
    updates: UpdateExternalAgentInput & Partial<ExternalAgentLifecycleFields>
  ): Promise<void> {
    const before = this.requireConfig(id)

    const secrets = extractInlineCredentials(updates as ExternalAgentConfig)
    const hasNewSecrets = occupiedSlots(secrets).length > 0
    const sanitized = scrubInlineCredentials(updates as ExternalAgentConfig)

    const wasRegistered = Boolean(this.deps.manager.getAgent(id))
    const rebuild = isRuntimeAffectingUpdate(updates) || hasNewSecrets
    const disabling = updates.enabled === false
    const enabling = updates.enabled === true && !before.enabled

    if ((rebuild || disabling) && wasRegistered) {
      await this.unregister(id)
    }

    this.deps.store.updateAgent(id, sanitized as UpdateExternalAgentInput)

    if (hasNewSecrets) {
      const merged = { ...(await this.readSecrets(before)), ...secrets }
      const refs = await persistCredentials(id, merged, this.deps.keyring)
      this.deps.store.patchLifecycle(id, { credentialRefs: refs })
    }

    if (updates.runtimeBinding) {
      this.deps.store.patchLifecycle(id, { runtimeBinding: updates.runtimeBinding })
    }

    const after = this.deps.store.getAgent(id)
    if (!after) return

    if (disabling) {
      this.markVerdict(id, READY)
      return
    }

    if (after.enabled && (rebuild || enabling || !wasRegistered)) {
      await this.register(after)
      return
    }

    this.markVerdict(id, await this.assessReadiness(after))
  }

  /**
   * Remove a configuration.
   *
   * Order is load-bearing: stop accepting work, end the live sessions, drop the
   * manager's state (which kills the child process), and only then delete the
   * persisted record and the Agent's secrets. The old path deleted the record
   * first and left everything else running.
   */
  async removeConfig(id: string): Promise<void> {
    const config = this.deps.store.getAgent(id)

    // Block new work before tearing anything down.
    if (config?.enabled) {
      this.deps.store.updateAgent(id, { enabled: false })
    }

    await this.closeSessions(id)
    await this.unregister(id)

    this.deps.store.removeAgent(id)
    await clearCredentials(id, this.deps.keyring)
  }

  // --------------------------------------------------------------------
  // Connection
  // --------------------------------------------------------------------

  /** Connect an Agent, refusing first if it is not in a state that can run. */
  async connect(id: string): Promise<void> {
    const config = this.requireConfig(id)

    const verdict = await this.assessReadiness(config)
    if (verdict.status !== "ready") {
      this.markVerdict(id, verdict)
      throw new ExternalAgentLifecycleError(
        verdict.reasonCode ?? "runtime_missing",
        verdict.reason ?? `agent ${id} is not ready to connect`,
        { agentId: id }
      )
    }

    if (!this.deps.manager.getAgent(id)) {
      await this.deps.manager.addAgent(config)
      // `addAgent` already connects an enabled config; connecting again would
      // tear down the session it just created.
      if (config.enabled) {
        this.markVerdict(id, READY)
        return
      }
    }

    await this.deps.manager.connect(id)
    this.markVerdict(id, READY)
  }

  async disconnect(id: string): Promise<void> {
    await this.deps.manager.disconnect(id)
  }

  /**
   * Bring the runtime back in line with what is persisted.
   *
   * Runs at startup and after any change that could invalidate an Agent from
   * outside — a plugin being disabled, a keyring being cleared, a policy
   * revision. An Agent that cannot be honestly started is left disabled with a
   * structured reason rather than auto-connected into a failure.
   */
  async reconcile(): Promise<Map<string, ReadinessVerdict>> {
    const verdicts = await this.reviewAll()

    for (const config of this.deps.store.getAllAgents()) {
      if (verdicts.get(config.id)?.status !== "ready") continue
      if (config.enabled && !this.deps.manager.getAgent(config.id)) {
        await this.register(config)
      }
    }

    return verdicts
  }

  /**
   * Judge every saved Agent and stop the ones that cannot run, without
   * connecting anything.
   *
   * Split out of {@link reconcile} because startup rehydration already owns
   * registration and connection (with its own timeout and adapter-registry
   * subscription). It needs the verdicts as a gate in front of that work, not a
   * second path that would register each Agent twice.
   */
  async reviewAll(): Promise<Map<string, ReadinessVerdict>> {
    const verdicts = new Map<string, ReadinessVerdict>()

    this.backfillRuntimeBindings()

    for (const config of this.deps.store.getAllAgents()) {
      const verdict = await this.assessReadiness(config)
      verdicts.set(config.id, verdict)
      this.markVerdict(config.id, verdict)

      if (verdict.status === "ready") continue

      // Stop anything that is somehow still live for a now-invalid config.
      if (this.deps.manager.getAgent(config.id)) {
        await this.unregister(config.id)
      }
      if (config.enabled) {
        this.deps.store.updateAgent(config.id, { enabled: false })
      }
    }

    return verdicts
  }

  /**
   * Give every saved Agent a runtime binding.
   *
   * Configs saved before the catalog existed have none, and a config the
   * catalog cannot match unambiguously keeps none — an incorrect binding would
   * attribute an Agent's sessions to the wrong runtime and let an uninstall
   * proceed while something was still using it. An existing binding is never
   * overwritten: the user or an install may have pinned a specific one.
   */
  backfillRuntimeBindings(): number {
    let bound = 0
    for (const config of this.deps.store.getAllAgents()) {
      if (config.runtimeBinding) continue
      const runtimeBinding = deriveRuntimeBinding(config)
      if (!runtimeBinding) continue
      this.deps.store.patchLifecycle(config.id, { runtimeBinding })
      bound += 1
    }
    return bound
  }

  /**
   * Move every legacy inline secret into the keyring.
   *
   * Must run BEFORE any adapter is constructed, so no connection is ever built
   * from a config still carrying plaintext. A keyring failure is contained to
   * the one Agent: it is scrubbed and disabled, and boot continues — a browser
   * shell with a locked vault must not be able to brick startup.
   */
  async migrateLegacyCredentials(): Promise<{
    migrated: string[]
    failed: { agentId: string; reason: string }[]
  }> {
    const migrated: string[] = []
    const failed: { agentId: string; reason: string }[] = []

    for (const config of this.deps.store.getAllAgents()) {
      if (occupiedSlots(extractInlineCredentials(config)).length === 0) continue

      try {
        const result = await migrateInlineCredentials(config, this.deps.keyring)
        this.deps.store.replaceAgentConfig(config.id, result.config)
        if (result.failure) {
          failed.push({ agentId: config.id, reason: result.failure.reason })
        } else {
          migrated.push(config.id)
        }
      } catch (error) {
        // `migrateInlineCredentials` already contains keyring failures; this
        // catches a store failure, where the plaintext is still persisted.
        failed.push({
          agentId: config.id,
          reason: error instanceof Error ? error.message : String(error),
        })
        this.deps.store.updateAgent(config.id, { enabled: false })
        this.markVerdict(config.id, {
          status: "needs-credentials",
          reasonCode: "credential_missing",
          reason: "inline credentials could not be migrated",
        })
      }
    }

    return { migrated, failed }
  }

  // --------------------------------------------------------------------
  // Credentials
  // --------------------------------------------------------------------

  async setCredentials(id: string, secrets: ExternalAgentSecrets): Promise<void> {
    const refs = await persistCredentials(id, secrets, this.deps.keyring)
    this.deps.store.patchLifecycle(id, { credentialRefs: refs })

    const config = this.deps.store.getAgent(id)
    if (config) this.markVerdict(id, await this.assessReadiness(config))
  }

  async clearCredentials(id: string): Promise<void> {
    await clearCredentials(id, this.deps.keyring)
    this.deps.store.patchLifecycle(id, { credentialRefs: {} })
  }

  /** Resolve an Agent's secrets for one launch. Never persisted or logged. */
  async readSecrets(config: LifecycleAgentConfig): Promise<ExternalAgentSecrets> {
    return resolveCredentials(config.credentialRefs, this.deps.keyring)
  }

  // --------------------------------------------------------------------
  // Windows unsandboxed consent
  // --------------------------------------------------------------------

  /**
   * Record a Windows desktop user's consent to run one Agent unsandboxed.
   *
   * Refuses outright on macOS and Linux: their sandbox is mandatory and there is
   * no path — consent or otherwise — that relaxes it. Refuses on Windows too
   * unless the catalog marks this specific runtime eligible.
   */
  /**
   * Record the user's approval to launch this Agent outside the sandbox.
   *
   * The identity is derived here rather than supplied by the caller. A UI that
   * assembled its own would be describing what it *displayed*, and the check
   * that later re-reads it describes what would *run* — the two drifting apart
   * is how an approval ends up covering a command nobody agreed to. Both sides
   * now go through {@link launchIdentity}.
   */
  async grantUnsandboxedWindowsConsent(id: string): Promise<UnsandboxedLaunchConsent> {
    if (normalizePlatform(this.deps.platform) !== "win32") {
      throw new ExternalAgentLifecycleError(
        "platform_unsupported",
        "unsandboxed launch consent exists only on Windows desktop",
        { platform: this.deps.platform }
      )
    }

    const config = this.requireConfig(id)
    const identity = this.launchIdentity(config)
    if (!identity) {
      throw new ExternalAgentLifecycleError(
        "runtime_missing",
        `agent ${id} is not bound to a catalogued runtime, so there is nothing to approve`,
        { agentId: id }
      )
    }

    const entry = findRuntimeById(identity.runtimeId)
    if (!entry || !isWindowsExceptionEligible(entry, this.deps.platform)) {
      throw new ExternalAgentLifecycleError(
        "platform_unsupported",
        `runtime ${identity.runtimeId} is not eligible for the Windows sandbox exception`,
        { runtimeId: identity.runtimeId }
      )
    }

    const consent: UnsandboxedLaunchConsent = {
      ...identity,
      confirmedAt: this.deps.now().toISOString(),
    }
    this.deps.store.patchLifecycle(id, { unsandboxedConsent: consent })
    this.markVerdict(id, await this.assessReadiness({ ...config, unsandboxedConsent: consent }))
    return consent
  }

  async revokeConsent(id: string): Promise<void> {
    this.deps.store.patchLifecycle(id, { unsandboxedConsent: undefined })
    const config = this.deps.store.getAgent(id)
    if (config?.enabled && this.deps.manager.getAgent(id)) {
      await this.unregister(id)
      this.deps.store.updateAgent(id, { enabled: false })
    }
    if (config) this.markVerdict(id, await this.assessReadiness(config))
  }

  // --------------------------------------------------------------------
  // Runtime operations
  // --------------------------------------------------------------------

  /** Live sessions for one Agent, from the manager rather than a guess. */
  activeSessionCount(id: string): number {
    return this.deps.manager.getAgent(id)?.sessions.size ?? 0
  }

  /**
   * How many live sessions exist across every Agent bound to this runtime.
   *
   * This is what a runtime uninstall must consult. The DSH removal command took
   * a session count from its caller, and the only production caller passed a
   * literal zero — so the guard could never fire.
   */
  activeSessionsForRuntime(runtimeId: string): number {
    return this.configsReferencing(runtimeId).reduce(
      (total, config) => total + this.activeSessionCount(config.id),
      0
    )
  }

  /** Agent configurations bound to this runtime. */
  configsReferencing(runtimeId: string): LifecycleAgentConfig[] {
    return this.deps.store
      .getAllAgents()
      .filter((config) => config.runtimeBinding?.runtimeId === runtimeId)
  }

  /**
   * List the ACP Registry, classified into what Cognia can install and what it
   * can only point the user at.
   *
   * The registry client was written with real care — exact versions, https
   * archives, mandatory checksums, traversal refusal — and then had no caller,
   * which made it a dormant capability rather than a lifecycle. This is the
   * production entry point.
   *
   * Discovered runtimes are remembered for this session so
   * {@link installRuntime} can resolve one; they are NOT written to the shipped
   * catalog, and a discovered id can never shadow a runtime the repo governs.
   */
  async discoverRegistryRuntimes(platformKey: string): Promise<RegistryDiscoveryResult> {
    const { discoverRegistryAgents, registryCatalogEntry } = await import("./registry-discovery")
    const result = await discoverRegistryAgents({ platformKey })
    const platform = normalizePlatform(platformKey.split("-")[0])

    for (const entry of result.entries) {
      if (entry.kind !== "managed") continue
      this.discoveredRuntimes.set(entry.runtimeId, registryCatalogEntry(entry, [platform]))
    }

    return result
  }

  /** Runtimes discovered this session, for a runtime host to resolve. */
  discoveredRuntimeEntries(): Iterable<ExternalAgentRuntimeCatalogEntry> {
    return this.discoveredRuntimes.values()
  }

  async inspectRuntime(runtimeId: string): Promise<ExternalAgentRuntimeStatus> {
    // The shipped catalog wins, so a discovered entry can never shadow a
    // runtime whose policy the repo actually governs.
    const entry = findRuntimeById(runtimeId) ?? this.discoveredRuntimes.get(runtimeId)
    if (!entry) {
      throw new ExternalAgentLifecycleError("runtime_missing", `unknown runtime: ${runtimeId}`, {
        runtimeId,
      })
    }

    const host = this.requireRuntimeHost()
    const { assessment, receipt } = await host.inspect(runtimeId)
    this.recordProbeOnBindings(runtimeId, assessment)

    return {
      runtimeId,
      ownership: entry.ownership,
      receipt,
      assessment,
      referencedBy: this.configsReferencing(runtimeId).map((config) => config.id),
      activeSessionCount: this.activeSessionsForRuntime(runtimeId),
    }
  }

  async installRuntime(runtimeId: string, version?: string): Promise<ExternalAgentRuntimeReceipt> {
    return this.requireRuntimeHost().install(runtimeId, version)
  }

  async checkForUpdate(runtimeId: string): Promise<ExternalAgentUpdateCandidate | null> {
    return this.requireRuntimeHost().checkForUpdate(runtimeId)
  }

  async updateRuntime(runtimeId: string, toVersion: string): Promise<ExternalAgentRuntimeReceipt> {
    return this.requireRuntimeHost().update(runtimeId, toVersion)
  }

  async rollbackRuntime(runtimeId: string): Promise<ExternalAgentRuntimeReceipt> {
    return this.requireRuntimeHost().rollback(runtimeId)
  }

  /**
   * Uninstall a managed runtime.
   *
   * Removing a configuration and uninstalling a runtime are separate
   * operations, and this one refuses while anything still depends on it: live
   * sessions first, then any configuration that still names it. Only
   * Cognia-owned managed roots are ever removed — a `system` runtime belongs to
   * the user's package manager and is never deleted.
   */
  async uninstallRuntime(runtimeId: string): Promise<void> {
    const entry = findRuntimeById(runtimeId)
    if (!entry) {
      throw new ExternalAgentLifecycleError("runtime_missing", `unknown runtime: ${runtimeId}`, {
        runtimeId,
      })
    }

    if (entry.ownership !== "managed") {
      throw new ExternalAgentLifecycleError(
        "runtime_referenced",
        `${runtimeId} is not Cognia-managed; Cognia never removes a runtime it did not install`,
        { runtimeId, ownership: entry.ownership }
      )
    }

    const sessions = this.activeSessionsForRuntime(runtimeId)
    if (sessions > 0) {
      throw new ExternalAgentLifecycleError(
        "active_sessions",
        `${runtimeId} still has ${sessions} live session(s)`,
        { runtimeId, sessions }
      )
    }

    const referencing = this.configsReferencing(runtimeId)
    if (referencing.length > 0) {
      throw new ExternalAgentLifecycleError(
        "runtime_referenced",
        `${referencing.length} configuration(s) still reference ${runtimeId}`,
        { runtimeId, configs: referencing.length }
      )
    }

    await this.requireRuntimeHost().uninstall(runtimeId)
  }

  // --------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------

  private requireRuntimeHost(): LifecycleRuntimeHost {
    if (!this.deps.runtimeHost) {
      throw new ExternalAgentLifecycleError(
        "platform_unsupported",
        "this host cannot install or remove external-agent runtimes"
      )
    }
    return this.deps.runtimeHost
  }

  /** Register with the manager, recording a structured reason on failure. */
  private async register(config: LifecycleAgentConfig): Promise<void> {
    const verdict = await this.assessReadiness(config)
    if (verdict.status !== "ready") {
      this.markVerdict(config.id, verdict)
      this.deps.store.updateAgent(config.id, { enabled: false })
      return
    }

    try {
      const secrets = await this.readSecrets(config)
      const launchConfig = applyResolvedCredentials(config, secrets)
      await this.deps.manager.addAgent(launchConfig)
      this.markVerdict(config.id, READY)
    } catch (error) {
      const code = error instanceof ExternalAgentLifecycleError ? error.code : "adapter_unavailable"
      this.markVerdict(config.id, {
        status: "blocked",
        reasonCode: code,
        reason: error instanceof Error ? error.message : String(error),
      })
      this.deps.store.updateAgent(config.id, { enabled: false })
      this.deps.store.setConnectionStatus(config.id, "error")
    }
  }

  /** Drop the manager's state for one Agent, killing its child process. */
  private async unregister(id: string): Promise<void> {
    if (!this.deps.manager.getAgent(id)) return
    await this.deps.manager.removeAgent(id)
    this.deps.store.setConnectionStatus(id, "disconnected")
  }

  private async closeSessions(id: string): Promise<void> {
    const instance = this.deps.manager.getAgent(id)
    if (!instance) return
    for (const sessionId of [...instance.sessions.keys()]) {
      try {
        await this.deps.manager.closeSession(id, sessionId)
      } catch {
        // A session that will not close cleanly must not block the removal;
        // `removeAgent` kills the process underneath it regardless.
      }
    }
  }

  /**
   * Write what the probe just learned onto every Agent bound to this runtime.
   *
   * Without this the binding never carries an executable digest or a version,
   * and the unsandboxed-consent check has nothing current to compare an
   * approval against — `executable-changed` and `version-changed` stay
   * unreachable no matter how many times the binary is swapped.
   *
   * `patchLifecycle` no-ops when nothing changed, so re-checking an unchanged
   * runtime does not churn the store.
   */
  private recordProbeOnBindings(
    runtimeId: string,
    assessment: ExternalAgentVersionAssessment
  ): void {
    for (const config of this.deps.store.getAllAgents()) {
      const binding = config.runtimeBinding
      if (binding?.runtimeId !== runtimeId) continue
      this.deps.store.patchLifecycle(config.id, {
        runtimeBinding: {
          ...binding,
          resolvedExecutablePath: assessment.executablePath,
          pinnedVersion: assessment.detectedVersion,
          executableDigest: assessment.executableDigest,
        },
      })
    }
  }

  /** The saved config, or a typed error naming the id that is not there. */
  private requireConfig(id: string): LifecycleAgentConfig {
    const config = this.deps.store.getAgent(id)
    if (!config) {
      throw new ExternalAgentLifecycleError("runtime_missing", `unknown agent: ${id}`, { id })
    }
    return config
  }

  private markVerdict(id: string, verdict: ReadinessVerdict): void {
    this.deps.store.patchLifecycle(id, {
      lifecycleStatus: verdict.status,
      lifecycleReasonCode: verdict.reasonCode,
      lifecycleReason: verdict.reason,
    })
  }

  /**
   * Can this configuration honestly be started right now?
   *
   * Checked in order of how fundamental the obstacle is: platform, then
   * adapter, then consent, then credentials. The first failure wins, so the
   * message names the thing the user has to fix first.
   */
  async assessReadiness(config: LifecycleAgentConfig): Promise<ReadinessVerdict> {
    const platformVerdict = this.assessPlatform(config)
    if (platformVerdict) return platformVerdict

    if (!this.deps.adapters.isProtocolAvailable(config.protocol)) {
      return {
        status: "blocked",
        reasonCode: "adapter_unavailable",
        reason: `no protocol adapter is registered for "${config.protocol}"`,
      }
    }

    const consentVerdict = this.assessConsent(config)
    if (consentVerdict) return consentVerdict

    try {
      await this.readSecrets(config)
    } catch (error) {
      if (error instanceof ExternalAgentLifecycleError) {
        return {
          status: "needs-credentials",
          reasonCode: error.code,
          reason: error.message,
        }
      }
      throw error
    }

    return READY
  }

  private assessPlatform(config: LifecycleAgentConfig): ReadinessVerdict | undefined {
    // A remote Agent spawns nothing locally, so no sandbox question arises.
    const binding = config.runtimeBinding
    const entry = binding ? findRuntimeById(binding.runtimeId) : undefined
    if (entry?.ownership === "remote") return undefined
    if (config.transport !== "stdio" && !entry) return undefined

    if (entry && !runtimeSupportsPlatform(entry, this.deps.platform)) {
      return {
        status: "blocked",
        reasonCode: "platform_unsupported",
        reason: `${entry.runtimeId} does not support ${this.deps.platform}`,
      }
    }

    if (externalAgentSandboxSupportsPlatform(this.deps.platform)) return undefined

    // Unix without a sandbox is unreachable (both supported platforms have
    // one), so this is the Windows case: allowed only with valid consent.
    if (normalizePlatform(this.deps.platform) !== "win32") {
      return {
        status: "blocked",
        reasonCode: "platform_unsupported",
        reason: `${this.deps.platform} cannot run a sandboxed external agent`,
      }
    }

    if (!entry || !isWindowsExceptionEligible(entry, this.deps.platform)) {
      return {
        status: "blocked",
        reasonCode: "platform_unsupported",
        reason: "this runtime is not eligible for the Windows sandbox exception",
      }
    }

    return undefined
  }

  /**
   * What this Agent would launch, as the consent record describes it.
   *
   * One implementation for both sides of the check. Every field comes from the
   * saved config and its runtime binding — never from the consent being
   * checked. The digest used to be read out of `config.unsandboxedConsent`,
   * which meant the executable comparison was a value against itself: the
   * `executable-changed` and `version-changed` invalidations could not fire,
   * and a swapped binary kept an old approval. The binding carries both now,
   * written by {@link inspectRuntime}.
   */
  launchIdentity(config: LifecycleAgentConfig): UnsandboxedLaunchIdentity | undefined {
    const binding = config.runtimeBinding
    const entry = binding ? findRuntimeById(binding.runtimeId) : undefined
    if (!entry || !binding) return undefined

    const launch = {
      command: config.process?.command ?? entry.systemCommand ?? "",
      args: config.process?.args ?? entry.launchArgs ?? [],
    }
    return {
      agentId: config.id,
      runtimeId: entry.runtimeId,
      executablePath: binding.resolvedExecutablePath ?? launch.command,
      executableDigest: binding.executableDigest ?? "",
      runtimeVersion: binding.pinnedVersion ?? "",
      commandDigest: canonicalLaunchCommandString(launch),
      policyRevision: this.deps.policyRevision,
      hostId: this.deps.hostId,
      provider: binding.provider,
    }
  }

  private assessConsent(config: LifecycleAgentConfig): ReadinessVerdict | undefined {
    if (externalAgentSandboxSupportsPlatform(this.deps.platform)) return undefined

    const identity = this.launchIdentity(config)
    if (!identity) return undefined

    const { valid, reasons } = assessUnsandboxedConsent(config.unsandboxedConsent, identity)
    if (valid) return undefined

    return {
      status: "needs-consent",
      reasonCode: "consent_required",
      reason:
        reasons.length > 0
          ? `unsandboxed launch consent is no longer valid: ${reasons.join(", ")}`
          : "unsandboxed launch requires explicit per-agent consent",
    }
  }
}

// ============================================================================
// Production wiring
// ============================================================================

/**
 * Build the dependency set the app actually runs with.
 *
 * Exists — and is tested — because the injected-ports pattern has a standing
 * failure mode in this codebase: every test stubs the ports, so the real
 * wiring is the one path nothing exercises. If the store ever loses
 * `patchLifecycle`, or the manager's shape drifts from
 * {@link LifecycleRuntimeManager}, this function is where it surfaces.
 */
export async function createDefaultLifecycleDependencies(): Promise<LifecycleDependencies> {
  const [{ useExternalAgentStore }, { getExternalAgentManager }, { protocolAdapterRegistry }] =
    await Promise.all([
      import("@/stores/agent/external-agent-store"),
      import("../manager"),
      import("../protocol-adapter"),
    ])
  const { createKeyringStore } = await import("@/lib/credentials/keyring-store")
  const { getDeviceId } = await import("@/lib/device/device-identity")
  const { EXTERNAL_AGENT_SECURITY_POLICY_VERSION } = await import("../security-policy")
  const { createHostRuntimeHost } = await import("./native-runtime-host")

  const state = () => useExternalAgentStore.getState()

  return {
    store: {
      getAgent: (id) => state().getAgent(id),
      getAllAgents: () => state().getAllAgents(),
      addAgent: (input) => state().addAgent(input),
      updateAgent: (id, updates) => state().updateAgent(id, updates),
      removeAgent: (id) => state().removeAgent(id),
      replaceAgentConfig: (id, config) => state().replaceAgentConfig(id, config),
      patchLifecycle: (id, fields) => state().patchLifecycle(id, fields),
      setConnectionStatus: (id, status) => state().setConnectionStatus(id, status),
    },
    manager: getExternalAgentManager(),
    adapters: {
      isProtocolAvailable: (protocol) => protocolAdapterRegistry.has(protocol),
    },
    keyring: createKeyringStore(EXTERNAL_AGENT_KEYRING_NAMESPACE),
    // Absent on a host with no processes (browser, Capacitor). The service
    // then refuses every runtime operation with `platform_unsupported`, which
    // is the truth: such a host cannot see what is installed, let alone
    // install anything.
    runtimeHost: await createHostRuntimeHost(),
    // A host with no stable device identity gets a per-process one, which makes
    // every stored consent fail its host check rather than silently apply.
    hostId: (await getDeviceId()) ?? `ephemeral:${Math.random().toString(36).slice(2)}`,
    platform: detectPlatform(),
    policyRevision: EXTERNAL_AGENT_SECURITY_POLICY_VERSION,
    now: () => new Date(),
  }
}

/**
 * This host's Node-style platform id.
 *
 * A browser renderer has no platform and no spawn path either, so it reports
 * the one platform where the sandbox is always available — the same fallback
 * `externalAgentSandboxSupportsPlatform` makes, kept consistent so the two
 * cannot disagree about whether a web shell may configure an agent.
 */
function detectPlatform(): string {
  if (typeof process !== "undefined" && typeof process.platform === "string") {
    return process.platform
  }
  return "darwin"
}

let cachedService: ExternalAgentLifecycleService | null = null

/** The process-wide lifecycle service. */
export async function getExternalAgentLifecycleService(): Promise<ExternalAgentLifecycleService> {
  if (!cachedService) {
    cachedService = new ExternalAgentLifecycleService(await createDefaultLifecycleDependencies())
  }
  return cachedService
}

/** Drop the cached service. Tests only. */
export function __resetLifecycleServiceForTests(): void {
  cachedService = null
}
