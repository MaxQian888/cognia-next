/**
 * The single source of truth for global developer mode (ADR-0117).
 *
 * Before this module there were two independent global signals: the persisted
 * `pluginSettings.developerModeEnabled` (read only by `managed-ide-dev-mode`)
 * and a raw `localStorage["cognia.plugins.developerMode"]` read inside the
 * devtools panel, which also treated any development build as developer mode.
 * Two switches for one concept meant the devtools panel could be open while the
 * store said developer mode was off — and Creator, which gates on this, cannot
 * afford that ambiguity.
 *
 * The per-plugin `config.debug` / `config.devMode` flag in
 * `lib/plugin/core/manager.ts` is deliberately NOT folded in here. That one
 * enables debug instrumentation for a single plugin; this one decides whether
 * developer surfaces exist at all.
 */

import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"

/**
 * The pre-unification key. Read once during migration, then never again — it is
 * intentionally not cleaned up, so downgrading to a build that still reads it
 * finds the user's setting intact.
 */
export const LEGACY_DEVELOPER_MODE_KEY = "cognia.plugins.developerMode"

/** Signals that can turn developer mode on the first time this build boots. */
export interface DeveloperModeMigrationInputs {
  /** The already-persisted store value. */
  stored: boolean
  /** `localStorage[LEGACY_DEVELOPER_MODE_KEY] === "true"`. */
  legacyFlag: boolean
  /** Whether this is a development build. */
  developmentBuild: boolean
}

/**
 * Fold the legacy signals into one boot value.
 *
 * Any signal being on wins. Migration is deliberately one-way: it can only
 * enable, never disable, because a user who turned developer mode on in an
 * older build did so on purpose and an upgrade must not silently revoke it.
 */
export function resolveInitialDeveloperMode(inputs: DeveloperModeMigrationInputs): boolean {
  return inputs.stored || inputs.legacyFlag || inputs.developmentBuild
}

/** Read the legacy flag defensively — storage can throw in private modes. */
export function readLegacyDeveloperModeFlag(): boolean {
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem(LEGACY_DEVELOPER_MODE_KEY) === "true"
  } catch {
    return false
  }
}

/** Whether developer surfaces (devtools panel, Creator) may be offered. */
export function isDeveloperModeEnabled(): boolean {
  return usePluginStore.getState().pluginSettings.developerModeEnabled === true
}

export function setDeveloperModeEnabled(enabled: boolean): void {
  usePluginStore.getState().updatePluginSettings({ developerModeEnabled: enabled })
}

/**
 * Run the one-way migration and return the resulting value.
 *
 * Idempotent: once the store says `true`, every later call is a no-op write of
 * the same value. Safe to call from a boot initializer on every start.
 */
export function migrateDeveloperMode(options: { developmentBuild?: boolean } = {}): boolean {
  const stored = isDeveloperModeEnabled()
  const resolved = resolveInitialDeveloperMode({
    stored,
    legacyFlag: readLegacyDeveloperModeFlag(),
    developmentBuild:
      options.developmentBuild ??
      (typeof process !== "undefined" && process.env.NODE_ENV === "development"),
  })
  if (resolved !== stored) setDeveloperModeEnabled(resolved)
  return resolved
}
