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

import type { AppSettings } from "@cognia/agent-config-types"
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
  "onboardingProgress",
  "onboardingProfile",
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
  // `updates` is the Update Center's channel and per-asset snapshots. The
  // desktop updater's own scheduling stays under `about`, where its card is.
  updates: ["updateCenter"],
  tools: ["alwaysAllowTools", "builtinTools", "webTools", "selfInvokeTools", "toolFilter"],
  // Keyed on the id the NAV uses. The standalone `providers` / `profile`
  // sections were merged into `ai-connections` / `account`, and this map kept
  // the retired ids — so `resetKeysForSection("ai-connections")` answered
  // `undefined` and the most-visited settings page (it is also
  // `DEFAULT_SECTION`) silently had no reset button at all, while
  // `keyToSection` handed the finder a section id the sidebar cannot show.
  // `SECTION_ID_ALIASES` below keeps the old ids resolving.
  "ai-connections": [
    "routingFallbackEnabled",
    "providerSettings",
    "customProviders",
    "modelMappings",
    "routingConfig",
    "routingPresets",
    "semanticToolRouting",
    "difficultyRouting",
    "autoRouting",
    // Provider diagnostics tab preferences (`provider-diagnostics-tab.tsx`);
    // was in DEFAULTS but unclaimed, which is exactly the class the
    // completeness guard exists to catch.
    "providerDiagnostics",
  ],
  "agent-runtime": [
    "subagentNesting",
    // Moved here from the former standalone "general" section (their UI now
    // lives in agent-runtime → Defaults).
    "defaultModel",
    "defaultSystemPrompt",
    "defaultWorkingDir",
    "projectsRoot",
    "permissionMode",
    "cacheOptimizationEnabled",
    // Desktop → cognia CLI storage sync (CLI ↔ APP unification).
    "cliBridge",
  ],
  ccswitch: ["ccswitchSync"],
  // The limits panel's two settings-backed knobs: the per-account opt-in for
  // quota queries (network access) and the user-defined custom sources. Their
  // bearer tokens are stripped on profile export by `deepStripSecrets`.
  subscription: ["limitsQueryEnabledAccounts", "customLimitsSources"],
  about: ["updates"],
  desktop: ["browserCookieImportEnabled"],
  // The WebRTC card lives in this section too, and its five keys were missing
  // from every section — so "reset this section" skipped them and the
  // changed-settings review never listed them, even though the card writes
  // them like any other control.
  companion: [
    "remoteBrowserEnabled",
    "webrtcEnabled",
    "signalingUrl",
    "iceServers",
    "turnServers",
    "turnProvider",
  ],
  data: ["telemetryEnabled", "behaviorTelemetry", "storageRetention", "sessionImportWatch"],
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
    "cursor",
    // ADR-0148 — the style pack (radius / pills / elevation / border tone /
    // density / micro-labels). Owned here so it resets with the section and
    // shows up in the changed-settings review like every other appearance key.
    "stylePack",
    "importedVscodeThemes",
    // v47+ appearance behaviors now wired into the UI (auto light/dark
    // switching, editor theme linking, custom-CSS scope). Owned here so they
    // reset with the section and surface in the changed-settings review.
    "autoMode",
    "monacoLink",
    "customCssScope",
    // Language selector lives in the Appearance section (the former "general"
    // section owned it before the merge).
    "language",
    // ADR-0127: message presentation + typography + usage display were
    // defined/edited under Appearance but never claimed here, so "reset this
    // section", the changed-settings review, and appearance export all skipped
    // them. `agentFlowMode` is the legacy read-only fallback for
    // `messageDisplay` (ADR-0114) — claimed so a reset clears it too.
    "messageDisplay",
    "agentFlowMode",
    "typographyExt",
    "usageDisplayMode",
    "activeThemePackId",
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
    "openaiResponseFormat",
    "localOpenaiBaseUrl",
    "localOpenaiModel",
    "localOpenaiVoice",
    "localOpenaiSpeed",
    "localOpenaiResponseFormat",
    "localOpenaiTimeoutMs",
    "geminiVoice",
    "geminiModel",
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
    "xiaomiVoice",
    "xiaomiModel",
    "xiaomiStyle",
    "xiaomiDialect",
    "mistralVoiceId",
    "mistralModel",
    "mistralResponseFormat",
    "realtimeVoice",
    "realtimeModel",
    "realtimeInstructions",
    "liveVoice",
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
    "searchMaxRetries",
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
  security: ["biometricRequiredFor", "pluginSecurityPosture", "accountAutoLockMinutes"],
  sandbox: ["sandboxDefaultEnabled", "canvasCodeSandboxEnabled", "sandboxTier", "automationPolicy"],
  lsp: ["lsp"],
  ocr: ["ocrSettings"],
  "source-control": ["gitSettings"],
  account: ["profile"],
  conversation: [
    "conversationTitle",
    "conversationTimeline",
    "compaction",
    "streamPartialMessages",
    "conversationSidebar",
    // ADR-0127: run-status-bar metrics and composer behavior/assistance are
    // edited in the Conversation section (`run-status-bar-card`,
    // `composer-behavior-card`, `composer-assistance-card`).
    "runStatusBar",
    "composerBehavior",
    "composerAssistance",
  ],
  notifications: ["notificationPreferences"],
  terminal: ["terminal"],
  memory: ["memory", "memoryView"],
  artifacts: ["artifacts"],
  pet: ["petSettings"],
  eval: ["evalSettings"],
  // `workbenchRailPersistent` belongs here with `workbenchRail`: the workbench
  // customizer writes both, so leaving it out made "reset this section" skip
  // it and the changed-settings review never list it.
  sidebar: [
    "sidebarLayout",
    "sidebarSide",
    "workbenchRail",
    "workbenchRailPersistent",
    "workbenchRailPerProject",
    "workbenchPanels",
    "titleBarLayout",
    "statusBarLayout",
  ],
  workflows: ["workflowEditorPerformanceTier"],
}

/** Reverse index: AppSettings key → the section that owns it (first match). */
/**
 * Retired section ids → the section that absorbed them. `?section=` is a public
 * deep-link contract (`DEPRECATED_REDIRECT` in `settings-shell.tsx` rewrites
 * the URL), so a caller holding an old id still resolves here rather than
 * falling through to "this section owns nothing".
 */
export const SECTION_ID_ALIASES: Record<string, SettingsSectionId> = {
  providers: "ai-connections",
  "api-key": "ai-connections",
  profile: "account",
  general: "agent-runtime",
}

/** Resolve a possibly-retired section id to the one that owns its keys. */
function canonicalSection(sectionId: SettingsSectionId): SettingsSectionId {
  return SECTION_ID_ALIASES[sectionId] ?? sectionId
}

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
 * Owned keys a section should NOT reset, even though it owns them for the
 * changed-settings review and the completeness guard. The canonical case:
 * `wallpapers` holds binary content the user uploaded — "reset appearance to
 * defaults" should restore theme/layout settings without destroying the user's
 * image library (they can delete individual wallpapers from the Wallpaper tab).
 */
export const RESET_EXCLUDE: Partial<Record<SettingsSectionId, (keyof AppSettings)[]>> = {
  appearance: ["wallpapers"],
}

/**
 * The AppSettings keys a settings section resets, for the per-section reset
 * affordance. Returns `undefined` for sections with no owned keys so the
 * `SectionResetButton` can render nothing. Keys listed in `RESET_EXCLUDE` are
 * dropped so they survive a reset while remaining owned for other uses.
 */
export function resetKeysForSection(
  sectionId: SettingsSectionId
): (keyof AppSettings)[] | undefined {
  const canonical = canonicalSection(sectionId)
  const owned = SECTION_OWNED_KEYS[canonical]
  if (!owned) return undefined
  const excluded = RESET_EXCLUDE[canonical]
  if (!excluded || excluded.length === 0) return owned
  const filtered = owned.filter((k) => !excluded.includes(k))
  return filtered.length > 0 ? filtered : undefined
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
