/**
 * The settings a live smoke runs with (ADR-0188 D20, B5 WP-E3).
 *
 * They start from the user's own configuration: a settings export
 * (Settings → Actions → Export settings), validated by the same importer the
 * app uses, laid over the app's defaults. The export carries no keys, so the
 * keys of the providers the user confirmed come from the environment, and
 * every other provider is switched off (`restrictToProviders`).
 *
 * Router + Fusion itself is switched on in this copy — the master switch and
 * the `gatewayRuns` surface the smoke's runs are created under — because a
 * smoke of the engine needs the engine. That is a change to a private,
 * in-memory copy: nothing here writes the user's settings.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import { getAllProviders } from "@cognia/provider-types/provider"
import {
  listLiveProviders,
  restrictToProviders,
  type LiveProviderListing,
  type ProviderSettingsLike,
} from "@cognia/router-fusion/live/providers"
import { normalizeRouterFusionSettings } from "@cognia/router-fusion/settings/settings"
import { DEFAULTS } from "@/lib/db/settings"
import {
  deepStripSecrets,
  NON_TRANSFERABLE_KEYS,
  SECRET_KEYS,
  SETTINGS_PROFILE_SCHEMA,
  SETTINGS_PROFILE_VERSION,
} from "@/lib/settings/profile-transfer"

export class LiveSmokeSettingsError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "LiveSmokeSettingsError"
    this.code = code
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const DROPPED_KEYS: ReadonlySet<string> = new Set([...SECRET_KEYS, ...NON_TRANSFERABLE_KEYS])

/**
 * A settings export as the app's full settings, laid over the app's defaults.
 * A bare settings object (the `settings` field without its envelope) is
 * accepted too.
 *
 * Not `importSettingsProfile`: that importer keeps only keys the defaults
 * declare, and the provider configuration (`providerSettings`,
 * `customProviders`, `modelMappings`) is not among them — exactly what a
 * smoke needs. The envelope is checked against the same schema and version,
 * and the same scrubber removes anything secret-shaped, so a hand-edited file
 * cannot smuggle a key in: keys come from the environment only.
 */
export function parseSettingsExport(text: string): AppSettings {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new LiveSmokeSettingsError(
      "SETTINGS_NOT_JSON",
      `the settings file is not JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!isPlainObject(parsed)) {
    throw new LiveSmokeSettingsError("SETTINGS_INVALID", "the settings file is not a JSON object")
  }
  const envelope =
    parsed.schema !== undefined
      ? parsed
      : { schema: SETTINGS_PROFILE_SCHEMA, version: SETTINGS_PROFILE_VERSION, settings: parsed }
  if (envelope.schema !== SETTINGS_PROFILE_SCHEMA) {
    throw new LiveSmokeSettingsError(
      "SETTINGS_INVALID",
      `the settings file is not a settings export (schema ${String(envelope.schema)})`
    )
  }
  if (
    typeof envelope.version !== "number" ||
    !Number.isFinite(envelope.version) ||
    envelope.version > SETTINGS_PROFILE_VERSION
  ) {
    throw new LiveSmokeSettingsError(
      "SETTINGS_INVALID",
      `the settings export version ${String(envelope.version)} is not one this build reads`
    )
  }
  if (!isPlainObject(envelope.settings)) {
    throw new LiveSmokeSettingsError("SETTINGS_INVALID", "the settings export has no settings")
  }
  const settings: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(envelope.settings)) {
    if (DROPPED_KEYS.has(key)) continue
    settings[key] = deepStripSecrets(value)
  }
  return { ...structuredClone(DEFAULTS), ...settings } as AppSettings
}

/** Router + Fusion on, with the surface the smoke's runs are created under. */
export function withHarnessSwitches(settings: AppSettings): AppSettings {
  const routerFusion = normalizeRouterFusionSettings(settings.routerFusion)
  return {
    ...settings,
    routerFusion: {
      ...routerFusion,
      enabled: true,
      surfaces: { ...routerFusion.surfaces, gatewayRuns: true },
    },
  }
}

export interface PreparedLiveSettings {
  appSettings: AppSettings
  providers: LiveProviderListing[]
  /** The providers the run may call. */
  selected: string[]
  /** Providers `--providers` named that the settings do not configure. */
  unknownRequested: string[]
}

export function prepareLiveSettings(
  base: AppSettings,
  input: {
    env: Readonly<Record<string, string | undefined>>
    requestedProviders: readonly string[] | null
  }
): PreparedLiveSettings {
  const shaped = base as unknown as ProviderSettingsLike
  const { providers, unknownRequested } = listLiveProviders(
    shaped,
    input.env,
    input.requestedProviders
  )
  const selected = providers.filter((provider) => provider.selected).map((provider) => provider.id)
  const restricted = restrictToProviders(shaped, {
    selected,
    env: input.env,
    knownBuiltinIds: Object.keys(getAllProviders()),
  }) as unknown as AppSettings
  return {
    appSettings: withHarnessSwitches(restricted),
    providers,
    selected,
    unknownRequested,
  }
}
