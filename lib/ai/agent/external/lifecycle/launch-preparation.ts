/**
 * What every external-agent launch goes through before an adapter sees it.
 *
 * Two things make one configuration different from another of the same
 * runtime at launch time, and both used to depend on which route reached the
 * manager:
 *
 *   - **Its own credentials.** Secrets live in the keyring, referenced from the
 *     config. Only `ExternalAgentLifecycleService.register()` resolved them, so
 *     startup rehydration, `lifecycle.connect` and the Connect button launched
 *     the scrubbed store config: after a restart every configuration ran with
 *     no credential of its own and the runtime fell back to whatever the shared
 *     home or the active subscription account held.
 *   - **Its own state root** (ADR-0216). An `isolated` configuration asks its
 *     spawn backend for a private home through `COGNIA_AGENT_STATE_KEY`.
 *
 * `ExternalAgentManager.addAgent` runs this on every config, so there is one
 * route, and re-running it on an already-prepared config changes nothing.
 */

import type { KeyringStore } from "@/lib/credentials/keyring-store"
import { ExternalAgentLifecycleError } from "@/types/agent/external-agent-lifecycle"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

import {
  AGENT_STATE_KEY_ENV,
  AGENT_STATE_KEY_PATTERN,
  agentStateIsolationFor,
} from "../policy/security-policy"
import {
  EXTERNAL_AGENT_KEYRING_NAMESPACE,
  applyResolvedCredentials,
  resolveCredentials,
  type LifecycleAgentConfig,
} from "./credentials"

export interface LaunchPreparationDeps {
  keyring: KeyringStore
}

/** Whether a configuration's state root is private, as configured. */
export function isStateIsolated(config: Pick<ExternalAgentConfig, "stateIsolation">): boolean {
  return config.stateIsolation === "isolated"
}

/**
 * Why an `isolated` configuration cannot be isolated, or `null` when it can
 * (or does not ask to be).
 *
 * A network agent spawns nothing here, a Cognia gateway task and a bot run
 * already get a private home of their own, and those three are not refused:
 * there is simply no local runtime state for this setting to move.
 */
export function stateIsolationBlockReason(config: ExternalAgentConfig): string | null {
  if (!isStateIsolated(config)) return null
  if (!stateIsolationApplies(config)) return null
  if (!AGENT_STATE_KEY_PATTERN.test(config.id)) {
    return `configuration id "${config.id}" cannot name a state root`
  }
  const rule = agentStateIsolationFor(config.process!.command, config.process!.args ?? [])
  if (!rule) {
    return `"${config.process!.command}" has no documented home directory to isolate`
  }
  return null
}

function stateIsolationApplies(config: ExternalAgentConfig): boolean {
  if (config.transport !== "stdio" || !config.process?.command) return false
  if (config.metadata?.cogniaGatewayTask) return false
  if (config.process.env?.COGNIA_BOT_ISOLATION === "1") return false
  return true
}

/**
 * Point an `isolated` configuration's spawn at its private root.
 *
 * Sets the key and REMOVES any env key the runtime's rule owns: the rule is
 * what maps `CODEX_HOME` & co. into the root, and a value the user typed in
 * by hand (a leftover from before isolation existed, or one carried over from
 * a source configuration) would otherwise point two configurations back at one
 * home. A `shared` configuration is returned with any stale key removed.
 */
export function applyStateIsolation<T extends ExternalAgentConfig>(config: T): T {
  if (!config.process) return config
  const env = { ...(config.process.env ?? {}) }
  delete env[AGENT_STATE_KEY_ENV]

  if (isStateIsolated(config) && stateIsolationApplies(config)) {
    const reason = stateIsolationBlockReason(config)
    if (reason) {
      throw new ExternalAgentLifecycleError("state_isolation_unsupported", reason, {
        agentId: config.id,
      })
    }
    const rule = agentStateIsolationFor(config.process.command, config.process.args ?? [])!
    for (const key of Object.keys(rule.env)) delete env[key]
    env[AGENT_STATE_KEY_ENV] = config.id
  }

  return { ...config, process: { ...config.process, env } }
}

/**
 * Resolve this configuration's own secrets and state root for one launch.
 *
 * The result is transient (it may hold resolved secrets): it goes to the
 * adapter and is never persisted, exported or logged. A reference to a keyring
 * entry that is gone throws `credential_missing` rather than launching as
 * nobody.
 */
export async function prepareExternalAgentLaunch<T extends ExternalAgentConfig>(
  config: T,
  deps: LaunchPreparationDeps
): Promise<T> {
  const refs = (config as T & Partial<LifecycleAgentConfig>).credentialRefs
  const withSecrets =
    refs && Object.keys(refs).length > 0
      ? applyResolvedCredentials(config, await resolveCredentials(refs, deps.keyring))
      : config
  return applyStateIsolation(withSecrets)
}

let defaultDeps: Promise<LaunchPreparationDeps> | null = null

/**
 * The preparer the manager installs by default. The keyring is created lazily
 * and once: the manager is constructed in contexts (tests, the web shell) that
 * never launch anything.
 */
export async function prepareExternalAgentLaunchWithDefaults<T extends ExternalAgentConfig>(
  config: T
): Promise<T> {
  const refs = (config as T & Partial<LifecycleAgentConfig>).credentialRefs
  if (!refs || Object.keys(refs).length === 0) return applyStateIsolation(config)
  defaultDeps ??= import("@/lib/credentials/keyring-store").then(({ createKeyringStore }) => ({
    keyring: createKeyringStore(EXTERNAL_AGENT_KEYRING_NAMESPACE),
  }))
  return prepareExternalAgentLaunch(config, await defaultDeps)
}

/** Forget the cached default keyring. Tests only. */
export function __resetLaunchPreparationForTests(): void {
  defaultDeps = null
}
