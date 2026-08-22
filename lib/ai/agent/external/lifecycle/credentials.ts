/**
 * Secret handling for external-Agent configurations.
 *
 * External Agents accept API keys, bearer tokens, authorization headers, proxy
 * credentials and process environment variables. All of them used to be
 * persisted inline on the config, which meant they lived in a localStorage
 * -backed Zustand record and travelled inside export payloads. This module
 * moves every one of them into the same host-local keyring the rest of the app
 * uses ({@link createKeyringStore}) and leaves only opaque references behind.
 *
 * Three rules the tests pin, because each is the kind of thing that silently
 * stops being true:
 *
 *  - a resolved secret is never returned as part of a config that anything
 *    persists, logs or exports — resolution happens immediately before a
 *    connect or spawn and the result is passed straight to the launcher;
 *  - a sanitized export carries a `credentials required` marker, so importing
 *    it produces an Agent that asks for its secrets rather than one that looks
 *    configured and fails at connect time;
 *  - a failed migration scrubs the plaintext anyway. Leaving the inline secret
 *    behind "so nothing breaks" would defeat the entire move.
 *
 * @see types/agent/external-agent-lifecycle.ts
 */

import { looksSecret } from "@/lib/plugin/convert/secrets"
import type { KeyringStore } from "@/lib/credentials/keyring-store"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"
import {
  EXTERNAL_AGENT_CREDENTIAL_REQUIRED_MARKER,
  EXTERNAL_AGENT_CREDENTIAL_SLOTS,
  ExternalAgentLifecycleError,
  type ExternalAgentCredentialRefs,
  type ExternalAgentCredentialSlot,
  type ExternalAgentLifecycleFields,
} from "@/types/agent/external-agent-lifecycle"

/** Keyring namespace every external-Agent secret lives under. */
export const EXTERNAL_AGENT_KEYRING_NAMESPACE = "external-agent"

/** A saved configuration plus its lifecycle fields. */
export type LifecycleAgentConfig = ExternalAgentConfig & ExternalAgentLifecycleFields

/**
 * Deterministic keyring key for one Agent's slot.
 *
 * Deterministic rather than random so a config whose refs were lost can still
 * find its secrets, and so clearing an Agent's credentials never depends on the
 * refs being intact.
 */
export function credentialKeyId(agentId: string, slot: ExternalAgentCredentialSlot): string {
  return `${agentId}:${slot}`
}

/** The secret values pulled out of a configuration. */
export interface ExternalAgentSecrets {
  apiKey?: string
  bearerToken?: string
  /** Only the header entries whose NAME marks them as a credential. */
  headers?: Record<string, string>
  proxyAuth?: { username: string; password: string }
  /** Only the process env entries whose NAME marks them as a credential. */
  processEnv?: Record<string, string>
}

function pickSecretEntries(source: Record<string, string> | undefined): {
  secret: Record<string, string>
  plain: Record<string, string>
} {
  const secret: Record<string, string> = {}
  const plain: Record<string, string> = {}
  for (const [name, value] of Object.entries(source ?? {})) {
    if (looksSecret(name)) secret[name] = value
    else plain[name] = value
  }
  return { secret, plain }
}

function hasEntries(value: Record<string, string> | undefined): boolean {
  return Boolean(value && Object.keys(value).length > 0)
}

/**
 * Every secret currently sitting inline on a configuration.
 *
 * Header and env maps are split by NAME, not by value: a non-secret header is
 * part of how the Agent is addressed and belongs in the config, while
 * `Authorization` never does. `looksSecret` is the app's existing heuristic —
 * reused rather than re-derived so the two never disagree about what counts.
 */
export function extractInlineCredentials(config: ExternalAgentConfig): ExternalAgentSecrets {
  const secrets: ExternalAgentSecrets = {}

  const network = config.network
  if (network?.apiKey) secrets.apiKey = network.apiKey
  if (network?.bearerToken) secrets.bearerToken = network.bearerToken

  const headers = pickSecretEntries(network?.headers).secret
  if (hasEntries(headers)) secrets.headers = headers

  if (network?.proxy?.auth) secrets.proxyAuth = { ...network.proxy.auth }

  const env = pickSecretEntries(config.process?.env).secret
  if (hasEntries(env)) secrets.processEnv = env

  return secrets
}

/** Which slots does this configuration actually populate? */
export function occupiedSlots(secrets: ExternalAgentSecrets): ExternalAgentCredentialSlot[] {
  return EXTERNAL_AGENT_CREDENTIAL_SLOTS.filter((slot) => {
    const value = secrets[slot]
    if (value === undefined) return false
    return typeof value === "string" ? value.length > 0 : Object.keys(value).length > 0
  })
}

/**
 * Return the configuration with every inline secret removed.
 *
 * Structure is preserved: a proxy keeps its host and port, a header map keeps
 * its non-secret entries, and an env map keeps everything that is not a
 * credential. Only the secret values go.
 */
export function scrubInlineCredentials<T extends ExternalAgentConfig>(config: T): T {
  const next = { ...config } as T

  if (config.network) {
    const { plain: plainHeaders } = pickSecretEntries(config.network.headers)
    const network = { ...config.network }
    delete network.apiKey
    delete network.bearerToken
    if (config.network.headers) {
      network.headers = plainHeaders
    }
    if (network.proxy?.auth) {
      network.proxy = { host: network.proxy.host, port: network.proxy.port }
    }
    next.network = network
  }

  if (config.process) {
    const process = { ...config.process }
    if (config.process.env) {
      process.env = pickSecretEntries(config.process.env).plain
    }
    next.process = process
  }

  return next
}

/** A configuration prepared for export, with what the importer must supply. */
export interface SanitizedExport {
  config: LifecycleAgentConfig
  /** Slots the importer must fill before the Agent can connect. */
  credentialsRequired: ExternalAgentCredentialSlot[]
}

/**
 * Prepare a configuration for export.
 *
 * Secrets are removed and each occupied slot is replaced by a marker, so the
 * importing side can tell "this Agent needs a bearer token" from "this Agent
 * needs nothing". Keyring references are dropped as well: they name entries in
 * a keyring the importing host does not have, and carrying them would produce
 * an Agent that looks credentialled and is not.
 */
export function sanitizeConfigForExport(config: LifecycleAgentConfig): SanitizedExport {
  const inline = extractInlineCredentials(config)
  const refSlots = Object.keys(config.credentialRefs ?? {}) as ExternalAgentCredentialSlot[]
  const required = Array.from(new Set([...occupiedSlots(inline), ...refSlots])).sort()

  const sanitized = scrubInlineCredentials(config) as LifecycleAgentConfig
  delete sanitized.credentialRefs

  if (required.length > 0) {
    sanitized.metadata = {
      ...sanitized.metadata,
      [EXTERNAL_AGENT_CREDENTIAL_REQUIRED_MARKER]: required,
    }
  }

  return { config: sanitized, credentialsRequired: required }
}

/** Which slots does an imported configuration say it still needs? */
export function credentialsRequiredByImport(
  config: LifecycleAgentConfig
): ExternalAgentCredentialSlot[] {
  const marker = config.metadata?.[EXTERNAL_AGENT_CREDENTIAL_REQUIRED_MARKER]
  if (!Array.isArray(marker)) return []
  return marker.filter((slot): slot is ExternalAgentCredentialSlot =>
    (EXTERNAL_AGENT_CREDENTIAL_SLOTS as readonly string[]).includes(slot as string)
  )
}

/**
 * A logging-safe view of a configuration.
 *
 * Returns the scrubbed config plus the slot NAMES that were populated, never
 * their values. Callers that want to say "this Agent has a bearer token" get
 * to; callers that would have logged the token do not.
 */
export function redactConfigForLogging(config: LifecycleAgentConfig): {
  config: LifecycleAgentConfig
  populatedSlots: ExternalAgentCredentialSlot[]
} {
  const populated = Array.from(
    new Set([
      ...occupiedSlots(extractInlineCredentials(config)),
      ...(Object.keys(config.credentialRefs ?? {}) as ExternalAgentCredentialSlot[]),
    ])
  ).sort()
  const scrubbed = scrubInlineCredentials(config) as LifecycleAgentConfig
  delete scrubbed.credentialRefs
  return { config: scrubbed, populatedSlots: populated }
}

// ============================================================================
// Keyring persistence
// ============================================================================

function serializeSlot(slot: ExternalAgentCredentialSlot, secrets: ExternalAgentSecrets): string {
  const value = secrets[slot]
  return typeof value === "string" ? value : JSON.stringify(value)
}

function deserializeSlot(
  slot: ExternalAgentCredentialSlot,
  raw: string
): ExternalAgentSecrets[ExternalAgentCredentialSlot] {
  if (slot === "apiKey" || slot === "bearerToken") return raw
  return JSON.parse(raw) as Record<string, string>
}

/**
 * Write an Agent's secrets to the keyring and return the references.
 *
 * A slot the caller did not supply is deleted rather than left behind, so
 * clearing a bearer token in the UI actually removes it from the keyring
 * instead of orphaning it there forever.
 */
export async function persistCredentials(
  agentId: string,
  secrets: ExternalAgentSecrets,
  store: KeyringStore
): Promise<ExternalAgentCredentialRefs> {
  const refs: ExternalAgentCredentialRefs = {}
  const populated = new Set(occupiedSlots(secrets))

  for (const slot of EXTERNAL_AGENT_CREDENTIAL_SLOTS) {
    const keyId = credentialKeyId(agentId, slot)
    if (populated.has(slot)) {
      await store.save(keyId, serializeSlot(slot, secrets))
      refs[slot] = keyId
    } else {
      await store.delete(keyId)
    }
  }

  return refs
}

/** Remove every secret belonging to one Agent. */
export async function clearCredentials(agentId: string, store: KeyringStore): Promise<void> {
  for (const slot of EXTERNAL_AGENT_CREDENTIAL_SLOTS) {
    await store.delete(credentialKeyId(agentId, slot))
  }
}

/**
 * Resolve an Agent's secrets immediately before a connect or spawn.
 *
 * Throws `credential_missing` naming the SLOT — never the value — when a
 * reference points at a keyring entry that is gone. That is a real state: the
 * OS keyring can be cleared independently of the config store, and failing
 * loudly here is what stops a launch that would have authenticated as nobody.
 */
export async function resolveCredentials(
  refs: ExternalAgentCredentialRefs | undefined,
  store: KeyringStore
): Promise<ExternalAgentSecrets> {
  const resolved: ExternalAgentSecrets = {}
  if (!refs) return resolved

  for (const slot of EXTERNAL_AGENT_CREDENTIAL_SLOTS) {
    const keyId = refs[slot]
    if (!keyId) continue
    const raw = await store.load(keyId)
    if (raw === null) {
      throw new ExternalAgentLifecycleError(
        "credential_missing",
        `no keyring entry for credential slot "${slot}"`,
        { slot }
      )
    }
    Object.assign(resolved, { [slot]: deserializeSlot(slot, raw) })
  }

  return resolved
}

/**
 * Merge resolved secrets back into a configuration for one launch.
 *
 * The result is deliberately transient: it is handed to the adapter and dropped.
 * Nothing in the lifecycle plane persists, exports or logs the value this
 * returns.
 */
export function applyResolvedCredentials<T extends ExternalAgentConfig>(
  config: T,
  secrets: ExternalAgentSecrets
): T {
  const next = { ...config } as T

  if (config.network) {
    const network = { ...config.network }
    if (secrets.apiKey !== undefined) network.apiKey = secrets.apiKey
    if (secrets.bearerToken !== undefined) network.bearerToken = secrets.bearerToken
    if (secrets.headers) network.headers = { ...network.headers, ...secrets.headers }
    if (secrets.proxyAuth && network.proxy) {
      network.proxy = { ...network.proxy, auth: { ...secrets.proxyAuth } }
    }
    next.network = network
  }

  if (secrets.processEnv) {
    next.process = {
      ...(config.process ?? { command: "" }),
      env: { ...(config.process?.env ?? {}), ...secrets.processEnv },
    }
  }

  return next
}

// ============================================================================
// Migration
// ============================================================================

export interface CredentialMigrationResult {
  /** The configuration to persist. */
  config: LifecycleAgentConfig
  /** Slots successfully moved into the keyring. */
  migrated: ExternalAgentCredentialSlot[]
  /**
   * Set when the keyring write failed. The plaintext is scrubbed regardless and
   * the Agent is disabled, so the user re-enters the secret rather than running
   * with it still sitting in localStorage.
   */
  failure?: { slots: ExternalAgentCredentialSlot[]; reason: string }
}

/**
 * Move a legacy configuration's inline secrets into the keyring.
 *
 * Runs before Agent rehydration so no adapter is ever constructed from a config
 * that still carries plaintext. On a keyring failure the config is scrubbed and
 * disabled anyway: an Agent that cannot connect is a smaller problem than a
 * token that stays in localStorage because the migration was polite about it.
 */
export async function migrateInlineCredentials(
  config: LifecycleAgentConfig,
  store: KeyringStore
): Promise<CredentialMigrationResult> {
  const inline = extractInlineCredentials(config)
  const slots = occupiedSlots(inline)
  if (slots.length === 0) {
    return { config, migrated: [] }
  }

  const scrubbed = scrubInlineCredentials(config) as LifecycleAgentConfig

  try {
    const refs = await persistCredentials(config.id, inline, store)
    return {
      config: { ...scrubbed, credentialRefs: { ...config.credentialRefs, ...refs } },
      migrated: slots,
    }
  } catch (error) {
    return {
      config: {
        ...scrubbed,
        enabled: false,
        lifecycleStatus: "needs-credentials",
        lifecycleReasonCode: "credential_missing",
        lifecycleReason: "inline credentials could not be moved to the keyring",
      },
      migrated: [],
      failure: {
        slots,
        reason: error instanceof Error ? error.message : String(error),
      },
    }
  }
}
