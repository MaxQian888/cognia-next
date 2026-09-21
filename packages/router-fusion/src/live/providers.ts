/**
 * The providers a live smoke may call (ADR-0188 D20).
 *
 * The provider list is the user's own configuration, read from a settings
 * export; the export never carries a key, so credentials come from the
 * environment, one explicitly named variable per provider. A key in the
 * user's shell under a conventional name (`OPENAI_API_KEY`) is deliberately
 * NOT picked up: spending money on a provider takes a variable that exists
 * only for this harness.
 *
 * The run is then fenced to the confirmed providers: every other provider is
 * switched off in the harness's private copy of the settings, so the router
 * cannot resolve a role to anything the user did not confirm. The user's own
 * settings are never written.
 */

export const LIVE_SMOKE_KEY_ENV_PREFIX = "COGNIA_LIVE_SMOKE_KEY_"

/**
 * Anthropic is a routing candidate even without a settings row (the provider
 * catalog adds it unless a row switches it off), so it is always listed.
 */
export const IMPLICIT_PROVIDER_IDS: readonly string[] = ["anthropic"]

/** The slice of the app settings this module reads and writes. */
export interface ProviderSettingsLike {
  providerSettings?: Record<string, ProviderRowLike | undefined>
  customProviders?: CustomProviderRowLike[]
}

export interface ProviderRowLike {
  providerId?: string
  enabled?: boolean
  apiKey?: string
  defaultModel?: string
  [key: string]: unknown
}

export interface CustomProviderRowLike {
  id: string
  enabled?: boolean
  apiKey?: string
  customName?: string
  name?: string
  [key: string]: unknown
}

export interface LiveProviderListing {
  id: string
  name: string
  kind: "builtin" | "custom"
  /** Enabled in the user's settings (a missing row counts as enabled, as the router reads it). */
  enabled: boolean
  /** The environment variable the harness reads the key from; empty when none is needed. */
  credentialEnv: string
  credentialFound: boolean
  /** The run may call this provider. */
  selected: boolean
}

export function credentialEnvName(providerId: string): string {
  return `${LIVE_SMOKE_KEY_ENV_PREFIX}${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`
}

function credentialOf(
  env: Readonly<Record<string, string | undefined>>,
  providerId: string
): string | null {
  const value = env[credentialEnvName(providerId)]?.trim()
  return value ? value : null
}

/**
 * Every provider the settings configure, with whether it may be called. With
 * `requested`, exactly those (each must be configured and enabled); without,
 * every enabled provider whose key is in the environment.
 */
export function listLiveProviders(
  settings: ProviderSettingsLike,
  env: Readonly<Record<string, string | undefined>>,
  requested: readonly string[] | null
): { providers: LiveProviderListing[]; unknownRequested: string[] } {
  const rows = new Map<string, Omit<LiveProviderListing, "selected">>()
  const builtinIds = [...IMPLICIT_PROVIDER_IDS, ...Object.keys(settings.providerSettings ?? {})]
  for (const id of builtinIds) {
    if (rows.has(id)) continue
    const row = settings.providerSettings?.[id]
    rows.set(id, {
      id,
      name: id,
      kind: "builtin",
      enabled: row?.enabled !== false,
      credentialEnv: credentialEnvName(id),
      credentialFound: credentialOf(env, id) !== null,
    })
  }
  for (const custom of settings.customProviders ?? []) {
    rows.set(custom.id, {
      id: custom.id,
      name: custom.customName ?? custom.name ?? custom.id,
      kind: "custom",
      enabled: custom.enabled !== false,
      credentialEnv: credentialEnvName(custom.id),
      credentialFound: credentialOf(env, custom.id) !== null,
    })
  }
  const wanted = requested ? new Set(requested) : null
  const unknownRequested = requested ? requested.filter((id) => !rows.has(id)) : []
  const providers = [...rows.values()]
    .map((row) => ({
      ...row,
      selected: row.enabled && (wanted ? wanted.has(row.id) : row.credentialFound),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return { providers, unknownRequested }
}

/**
 * A copy of the settings in which only `selected` providers can be reached:
 * their keys come from the environment, and every other provider — every
 * catalog provider in `knownBuiltinIds`, every configured row, every custom
 * provider — is switched off. The input is never modified.
 */
export function restrictToProviders<T extends ProviderSettingsLike>(
  settings: T,
  input: {
    selected: readonly string[]
    env: Readonly<Record<string, string | undefined>>
    knownBuiltinIds: readonly string[]
  }
): T {
  const selected = new Set(input.selected)
  const copy = structuredClone(settings)
  const providerSettings: Record<string, ProviderRowLike | undefined> = {
    ...(copy.providerSettings ?? {}),
  }
  const builtinIds = new Set([
    ...IMPLICIT_PROVIDER_IDS,
    ...input.knownBuiltinIds,
    ...Object.keys(providerSettings),
  ])
  const customIds = new Set((copy.customProviders ?? []).map((row) => row.id))
  for (const id of new Set([...builtinIds, ...customIds])) {
    const row = providerSettings[id]
    if (!selected.has(id)) {
      // A custom provider is switched off here too: the router's availability
      // check reads this row before the custom one, and a missing row counts
      // as enabled.
      providerSettings[id] = { ...(row ?? { providerId: id, defaultModel: "" }), enabled: false }
      continue
    }
    // A confirmed custom provider keeps its own row as the source of truth.
    if (customIds.has(id)) continue
    const key = credentialOf(input.env, id)
    providerSettings[id] = {
      ...(row ?? { providerId: id, defaultModel: "" }),
      enabled: true,
      ...(key ? { apiKey: key } : {}),
    }
  }
  copy.providerSettings = providerSettings
  copy.customProviders = (copy.customProviders ?? []).map((row) => {
    if (!selected.has(row.id)) return { ...row, enabled: false }
    const key = credentialOf(input.env, row.id)
    return { ...row, enabled: true, ...(key ? { apiKey: key } : {}) }
  })
  return copy
}

/** The provider part of a `providerId::modelId` deployment id. */
export function providerOfDeployment(deploymentId: string): string {
  const separator = deploymentId.indexOf("::")
  return separator > 0 ? deploymentId.slice(0, separator) : deploymentId
}

/** Deployments a route pinned that the user did not confirm; empty when the fence held. */
export function unconfirmedDeployments(
  roles: Readonly<Record<string, string | undefined>>,
  allowedProviderIds: readonly string[]
): string[] {
  const allowed = new Set(allowedProviderIds)
  return [
    ...new Set(
      Object.values(roles).filter(
        (id): id is string => typeof id === "string" && !allowed.has(providerOfDeployment(id))
      )
    ),
  ]
}
