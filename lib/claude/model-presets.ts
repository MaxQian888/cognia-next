// Shared enum values for the Claude model picker and permission-mode picker
// used across settings sections (general, characters, presets/preset-editor).
// Permission-mode labels are sourced from i18n (`settings.general.permission.*`);
// model labels are not — see below.

import type { AppSettings } from "@cognia/agent-config-types"
import { getBuiltInProviderCatalogEntry } from "@cognia/provider-types/built-in-provider-catalog"

/**
 * The Anthropic models offered in the settings pickers, derived from the
 * catalog rather than maintained by hand.
 *
 * The hand-maintained list had gone stale in every direction at once:
 * `claude-opus-4-8` and `claude-sonnet-4-6` rendered with no label because
 * their i18n keys were never added; `claude-opus-4-5` and `claude-sonnet-4-5`
 * were orphaned keys with no entry; `claude-haiku-4-5` was not a catalog id at
 * all (the catalog uses the dated `claude-haiku-4-5-20251001`), so picking it
 * resolved no metadata; and there was no Claude-5 entry even though the
 * catalog's own default is one.
 *
 * Labels come from the catalog's `name` — a proper noun that reads identically
 * in both locales — so the four `settings.general.model.*` keys are gone. An
 * i18n key per model id is a maintenance burden that buys nothing: nobody
 * translates "Claude Sonnet 5".
 *
 * The default is hoisted to the front so the picker leads with what a new
 * session would actually use.
 */
export function modelPresetOptions(): Array<{ id: string; name: string }> {
  const anthropic = getBuiltInProviderCatalogEntry("anthropic")
  if (!anthropic) return []
  const options = (anthropic.models ?? []).map((model) => ({ id: model.id, name: model.name }))
  const defaultIndex = options.findIndex((option) => option.id === anthropic.defaultModel)
  if (defaultIndex > 0) {
    const [preferred] = options.splice(defaultIndex, 1)
    options.unshift(preferred)
  }
  return options
}

/** Ids only, for consumers that just need the value set. */
export const MODEL_PRESET_VALUES: readonly string[] = modelPresetOptions().map(
  (option) => option.id
)

export type ModelPresetValue = string

// Mirrors the Claude Agent SDK's `PermissionMode` union (sdk 0.3.x:
// 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto').
// `dontAsk` denies anything not pre-approved without prompting; `auto` uses the
// SDK's model classifier to approve/deny permission prompts.
export const PERMISSION_MODE_VALUES: NonNullable<AppSettings["permissionMode"]>[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "auto",
]

export type PermissionModeValue = (typeof PERMISSION_MODE_VALUES)[number]
