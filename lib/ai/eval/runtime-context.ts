/**
 * The two host facts an eval run cannot proceed without: the resolved
 * `AppSettings` (which carry the provider credentials, model catalog and
 * routing the run will use) and the id of the unlocked account those
 * credentials belong to.
 *
 * Neither is derivable from a plugin context. `ctx.settings` is a
 * plugin-scoped key/value store — deliberately NOT the host's settings — and
 * there is no account API at all, so the eval plugin was reading
 * `@/stores/settings/settings-store` and `@/stores/account/account-store`
 * directly. This module is the narrow accessor that replaces those two reads,
 * published to authors as `@cognia/plugin-sdk/api/eval`.
 *
 * Both stores are imported lazily: a plugin that never starts a run should not
 * pull the settings graph into its module graph, and neither store exists at
 * all outside the renderer.
 */

import type { AppSettings } from "@cognia/agent-config-types"

/** The resolved host settings, or `null` when the store has none yet. */
export async function loadEvalAppSettings(): Promise<AppSettings | null> {
  const { useSettingsStore } = await import("@/stores/settings/settings-store")
  return useSettingsStore.getState().settings ?? null
}

export interface EvalRuntimeContext {
  settings: AppSettings
  localAccountId: string
}

/**
 * Settings plus the unlocked account, or `null` when either is missing.
 *
 * `null` is the normal state before the vault is unlocked, not an error — a
 * caller should surface "unlock your account to run an eval", not a stack
 * trace.
 */
export async function loadEvalRuntimeContext(): Promise<EvalRuntimeContext | null> {
  const [{ useSettingsStore }, { useAccountStore }] = await Promise.all([
    import("@/stores/settings/settings-store"),
    import("@/stores/account/account-store"),
  ])
  const settings = useSettingsStore.getState().settings
  const localAccountId = useAccountStore.getState().unlockedAccountId
  if (!settings || !localAccountId) return null
  return { settings, localAccountId }
}
