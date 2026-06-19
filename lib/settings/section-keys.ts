/**
 * The authoritative "settings section → owned AppSettings keys" map.
 *
 * This is the shared backbone for three settings meta-features:
 *  - per-section reset (`resetKeysForSection` → `buildResetPatch`),
 *  - the "changed settings" review panel (group a diff-vs-defaults by section),
 *  - the control-level finder (map a found key/control back to its section).
 *
 * Only sections whose state actually lives in `AppSettings` appear here.
 * Sections backed by Dexie tables (characters, skills, mcp, plugins,
 * connections, scheduled-tasks, diagnostics, logs, data, …) own no settings
 * keys, so they intentionally have no entry — no reset button, not in the diff.
 *
 * The companion guard test (`section-keys.test.ts`) asserts every canonical
 * `DEFAULTS` key is either claimed by a section here OR listed in
 * `NON_PREFERENCE_KEYS` / the secret + identity denylists — so a newly added
 * settings key can never silently fall through the cracks.
 */

import type { AppSettings } from "@/lib/claude/types"
import type { SettingsSectionId } from "@/components/settings/settings-nav-config"
import { DEFAULTS } from "@/lib/db/settings"
import { SECRET_KEYS, NON_TRANSFERABLE_KEYS } from "./profile-transfer"

/**
 * Canonical settings keys that are runtime / UI-local state rather than
 * user-tunable preferences — usage counters, navigation cursors, pinned lists,
 * dismissed-at stamps, and account-bound metadata. Excluded from per-section
 * reset and from the changed-settings review (showing "you pinned a workflow"
 * as a changed setting is noise, not signal).
 */
export const NON_PREFERENCE_KEYS = [
  "activeProjectId",
  "activeProviderId",
  "lastUpdateCheckAt",
  "lastInboxViewedAt",
  "onboardingDismissedAt",
  "pinnedWorkflowIds",
  "pinnedMeRowIds",
  "searchUsageStats",
] as const satisfies readonly (keyof AppSettings)[]

/**
 * Section → the AppSettings keys it owns. Entries may include keys that have no
 * `DEFAULTS` entry (optional overrides like `colorTheme`, `subagentNesting`,
 * `terminal`); resetting those clears the override (→ `DEFAULTS[k]` is
 * `undefined`), which is the correct "back to default" behavior.
 */
export const SECTION_OWNED_KEYS: Partial<Record<SettingsSectionId, (keyof AppSettings)[]>> = {
  tools: ["alwaysAllowTools", "builtinTools", "webTools", "selfInvokeTools", "toolFilter"],
  providers: [
    "routingFallbackEnabled",
    "providerSettings",
    "customProviders",
    "modelMappings",
    "routingConfig",
    "routingPresets",
    "semanticToolRouting",
    "difficultyRouting",
  ],
  "agent-runtime": [
    "subagentNesting",
    // Moved here from the former standalone "general" section (their UI now
    // lives in agent-runtime → Defaults).
    "defaultModel",
    "defaultSystemPrompt",
    "defaultWorkingDir",
    "permissionMode",
    // Desktop → cognia CLI storage sync (CLI ↔ APP unification).
    "cliBridge",
  ],
  ccswitch: ["ccswitchSync"],
  about: ["updates"],
  data: ["telemetryEnabled", "storageRetention"],
  appearance: [
    "theme",
    "colorTheme",
    "customThemes",
    "activeCustomThemeId",
    "fontScale",
    "reduceMotion",
    "density",
    "radius",
    "motion",
    "a11y",
    "background",
    "wallpapers",
    "customCss",
    "customCssEnabled",
    "componentStyles",
    "importedVscodeThemes",
    // Language selector lives in the Appearance section (the former "general"
    // section owned it before the merge).
    "language",
  ],
  speech: [
    "sttLanguage",
    "selectedMicId",
    "ttsProvider",
    "systemVoice",
    "openaiVoice",
    "openaiModel",
    "openaiSpeed",
    "openaiInstructions",
    "geminiVoice",
    "edgeVoice",
    "edgeRate",
    "edgePitch",
    "elevenlabsVoice",
    "elevenlabsModel",
    "elevenlabsStability",
    "elevenlabsSimilarityBoost",
    "lmntVoice",
    "lmntSpeed",
    "humeVoice",
    "cartesiaVoice",
    "cartesiaModel",
    "cartesiaLanguage",
    "cartesiaSpeed",
    "cartesiaEmotion",
    "deepgramVoice",
    "ttsEnabled",
    "ttsRate",
    "ttsPitch",
    "ttsVolume",
    "ttsAutoPlay",
    "ttsCacheEnabled",
    "ttsStreamingEnabled",
    "ttsFallbackEnabled",
  ],
  search: [
    "searchEnabled",
    "searchMaxResults",
    "searchFallbackEnabled",
    "defaultSearchProvider",
    "searchProviders",
    "defaultSearchType",
    "defaultSearchDepth",
    "defaultSearchRecency",
    "defaultSearchCountry",
    "defaultSearchLanguage",
    "defaultIncludeDomains",
    "defaultExcludeDomains",
    "defaultIncludeAnswer",
    "defaultIncludeRawContent",
    "searchCacheEnabled",
    "searchCacheTTL",
    "searchCacheMaxEntries",
    "searchSafeSearchEnabled",
    "searchSafeSearchLevel",
    "sourceVerificationSettings",
    "customSearchSources",
    "defaultSearchSources",
  ],
  network: ["networkProxy"],
  security: ["biometricRequiredFor", "pluginSecurityPosture"],
  sandbox: ["sandboxDefaultEnabled", "sandboxTier", "automationPolicy"],
  lsp: ["lsp"],
  ocr: ["ocrSettings"],
  "source-control": ["gitSettings"],
  profile: ["profile"],
  conversation: [
    "conversationTitle",
    "conversationTimeline",
    "compaction",
    "streamPartialMessages",
  ],
  notifications: ["notificationPreferences"],
  terminal: ["terminal"],
  memory: ["memory", "memoryView"],
  artifacts: ["artifacts"],
  pet: ["petSettings"],
  sidebar: ["sidebarLayout"],
  workflows: ["workflowEditorPerformanceTier"],
}

/** Reverse index: AppSettings key → the section that owns it (first match). */
const KEY_TO_SECTION: Partial<Record<keyof AppSettings, SettingsSectionId>> = (() => {
  const out: Partial<Record<keyof AppSettings, SettingsSectionId>> = {}
  for (const [section, keys] of Object.entries(SECTION_OWNED_KEYS) as [
    SettingsSectionId,
    (keyof AppSettings)[],
  ][]) {
    for (const key of keys) {
      if (!(key in out)) out[key] = section
    }
  }
  return out
})()

/**
 * The AppSettings keys a settings section owns, for the per-section reset
 * affordance. Returns `undefined` for sections with no owned keys so the
 * `SectionResetButton` can render nothing.
 */
export function resetKeysForSection(
  sectionId: SettingsSectionId
): (keyof AppSettings)[] | undefined {
  return SECTION_OWNED_KEYS[sectionId]
}

/** Map an AppSettings key back to the section that owns it. */
export function keyToSection(key: keyof AppSettings): SettingsSectionId | undefined {
  return KEY_TO_SECTION[key]
}

/** Keys never surfaced as tunable preferences: secrets + identity + UI-local. */
export function isNonPreferenceKey(key: string): boolean {
  return (
    (SECRET_KEYS as readonly string[]).includes(key) ||
    (NON_TRANSFERABLE_KEYS as readonly string[]).includes(key) ||
    (NON_PREFERENCE_KEYS as readonly string[]).includes(key)
  )
}

/** Canonical preference keys (every `DEFAULTS` key that isn't denylisted). */
export function preferenceKeys(): (keyof AppSettings)[] {
  return (Object.keys(DEFAULTS) as (keyof AppSettings)[]).filter((k) => !isNonPreferenceKey(k))
}
