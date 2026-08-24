/**
 * The single classification of every `AppSettings` field for cross-device sync.
 *
 * Before this table there were two hand-maintained lists that drifted apart: the
 * Rust up-allowlist (`APP_SETTINGS_MOBILE_ALLOWED_KEYS`) and the TypeScript
 * down-mirror (`CROSS_PLATFORM_SETTING_KEYS`). ~51 fields could be written from
 * the phone but were never mirrored back, one entry named a field that no longer
 * exists, and the WebRTC/signaling fields were classified in exactly the wrong
 * direction. Every one of those was invisible because nothing checked the two
 * lists against each other.
 *
 * Now this table is the source and both lists are derived from it:
 *
 * | category               | phone → host | host → phone |
 * | ---------------------- | ------------ | ------------ |
 * | `shared`               | yes          | yes          |
 * | `server-authoritative` | no           | yes          |
 * | `device-local`         | no           | no           |
 * | `desktop-only`         | no           | no           |
 *
 * `device-local` and `desktop-only` are both "never crosses the wire", but they
 * are not the same claim: `device-local` means every device legitimately holds
 * its own answer, `desktop-only` means the field is not part of the mobile
 * contract at all (credentials, filesystem paths, desktop-only subsystems,
 * internal bookkeeping).
 *
 * The `satisfies Record<keyof AppSettings, ...>` below is the enforcement: add a
 * field to `AppSettings` without classifying it here and `pnpm typecheck` fails.
 * The Rust constant and the OpenAPI enum are generated from this file by
 * `scripts/build/gen-settings-sync.mjs`; CI runs it with `--check`.
 */

import type { AppSettings } from "./index"

export type SettingsSyncCategory =
  "shared" | "server-authoritative" | "device-local" | "desktop-only"

/**
 * A field's classification. `server-authoritative` and `device-local` carry a
 * mandatory rationale: both are deliberate asymmetries, and an unexplained
 * asymmetry is indistinguishable from a bug six months later.
 */
export type SettingsSyncEntry =
  | { category: "shared" }
  | { category: "desktop-only" }
  | { category: "server-authoritative"; rationale: string }
  | { category: "device-local"; rationale: string }

export const SETTINGS_SYNC = {
  id: { category: "desktop-only" },
  browserCookieImportEnabled: { category: "desktop-only" },
  remoteBrowserEnabled: {
    category: "server-authoritative",
    rationale:
      "The desktop owns the remote-browser gate (profiles + granted domains live there). The phone only reads it to decide whether to render the remote preview pane, so it must flow down, never up.",
  },
  updatedAt: { category: "desktop-only" },
  profile: { category: "shared" },
  ocrSettings: { category: "desktop-only" },
  storageRetention: { category: "desktop-only" },
  // A spending ceiling is about the ACCOUNT, not the device: hitting the daily
  // cap on the desktop must also stop the phone, or the limit is only a limit
  // on whichever device you happen to be holding.
  costBudget: { category: "shared" },
  providerDiagnostics: { category: "desktop-only" },
  // Host-side scheduler config: the fallback ops chat is only ever read by the
  // host that runs the scheduler and delivers its notifications. A phone never
  // fires a scheduled task, so it has nothing to do with this value.
  schedulerNotifications: { category: "desktop-only" },
  gitSettings: { category: "desktop-only" },
  // The watcher reads the desktop's own filesystem (`~/.claude/projects`,
  // `~/.codex/sessions`, the OpenCode SQLite store). A phone has none of those
  // trees, so the toggle is meaningless there and must not cross the wire.
  sessionImportWatch: { category: "desktop-only" },
  subagentNesting: { category: "desktop-only" },
  backgroundTasks: { category: "desktop-only" },
  webTools: { category: "desktop-only" },
  selfInvokeTools: { category: "desktop-only" },
  cliBridge: { category: "desktop-only" },
  updates: { category: "desktop-only" },
  mobileRuntimeMode: {
    category: "device-local",
    rationale:
      "Standalone (BYOK) vs paired (companion) is what this handset is doing right now; it has no meaning on any other device (ADR-0056).",
  },
  defaultModel: { category: "shared" },
  defaultSystemPrompt: { category: "shared" },
  defaultWorkingDir: { category: "desktop-only" },
  projectsRoot: { category: "desktop-only" },
  activeProjectId: { category: "desktop-only" },
  workspaceTrust: { category: "desktop-only" },
  permissionMode: { category: "shared" },
  pluginSecurityPosture: { category: "desktop-only" },
  defaultMaxThinkingTokens: { category: "shared" },
  defaultEffort: { category: "desktop-only" },
  // Same classification as its sibling `defaultEffort`: the thinking ladder is
  // not part of the mobile settings contract, so neither half of the pair
  // crosses the wire.
  defaultThinkingLevel: { category: "desktop-only" },
  bareMode: { category: "shared" },
  debugMode: { category: "shared" },
  briefMode: { category: "shared" },
  streamPartialMessages: { category: "shared" },
  outputStyle: { category: "desktop-only" },
  customOutputStyle: { category: "desktop-only" },
  compaction: { category: "shared" },
  instructions: { category: "shared" },
  conversationTitle: { category: "shared" },
  attentionRadar: { category: "desktop-only" },
  capture: { category: "desktop-only" },
  composerAssistance: { category: "desktop-only" },
  composerBehavior: { category: "shared" },
  agentPermissions: { category: "desktop-only" },
  conversationTimeline: { category: "shared" },
  conversationSidebar: { category: "shared" },
  runStatusBar: { category: "desktop-only" },
  steerInterruptConfirmed: { category: "desktop-only" },
  alwaysAllowTools: { category: "desktop-only" },
  builtinTools: { category: "desktop-only" },
  toolFilter: { category: "desktop-only" },
  toolSearchRuntime: { category: "desktop-only" },
  apiKey: { category: "desktop-only" },
  apiBaseUrl: { category: "desktop-only" },
  activeProviderId: { category: "desktop-only" },
  ccswitchSync: { category: "desktop-only" },
  subscriptionSettings: { category: "desktop-only" },
  codexSubscriptionSettings: { category: "desktop-only" },
  customLimitsSources: { category: "desktop-only" },
  limitsQueryEnabledAccounts: { category: "desktop-only" },
  lastUpdateCheckAt: { category: "desktop-only" },
  theme: { category: "shared" },
  fontScale: { category: "shared" },
  language: { category: "shared" },
  reduceMotion: { category: "shared" },
  workflowEditorPerformanceTier: {
    category: "device-local",
    rationale:
      "A motion/computation budget chosen for this device's GPU and CPU. A desktop's `high` tier applied to a phone is exactly the wrong answer.",
  },
  webviewZoom: { category: "desktop-only" },
  telemetryEnabled: { category: "shared" },
  behaviorTelemetry: { category: "desktop-only" },
  terminal: { category: "desktop-only" },
  sttLanguage: { category: "shared" },
  selectedMicId: {
    category: "device-local",
    rationale:
      "An OS-issued input-device identifier. The desktop's microphone id addresses nothing on the phone.",
  },
  skillsShToken: { category: "desktop-only" },
  skillBundleMirrors: { category: "desktop-only" },
  skillPanelPrefs: { category: "desktop-only" },
  lastSkillView: { category: "desktop-only" },
  pinnedWorkflowIds: { category: "shared" },
  pinnedMeRowIds: {
    category: "device-local",
    rationale:
      "Favourites of the mobile `/me` list. The desktop has no `/me` surface, so there is nothing on the other side to mirror to or from.",
  },
  sidebarLayout: { category: "shared" },
  sidebarSide: { category: "desktop-only" },
  workbenchRail: { category: "desktop-only" },
  workbenchRailPersistent: { category: "desktop-only" },
  workbenchRailPerProject: { category: "desktop-only" },
  workbenchPanels: { category: "desktop-only" },
  titleBarLayout: { category: "desktop-only" },
  statusBarLayout: { category: "desktop-only" },
  mobileHomeLayout: { category: "desktop-only" },
  mobileTabLayout: { category: "desktop-only" },
  mobileWorkflowView: { category: "desktop-only" },
  discoverLayout: { category: "desktop-only" },
  discoverViewByCategory: { category: "desktop-only" },
  discoverFavorites: { category: "desktop-only" },
  discoverDefaults: { category: "desktop-only" },
  executionMonitorPrefs: { category: "desktop-only" },
  schedulerDashboardView: { category: "desktop-only" },
  goalConsoleView: { category: "desktop-only" },
  goalConsolePrefs: { category: "desktop-only" },
  notificationPreferences: { category: "shared" },
  userName: { category: "desktop-only" },
  welcomeStyle: { category: "desktop-only" },
  welcomeHidden: { category: "desktop-only" },
  welcomeStats: { category: "desktop-only" },
  mcpPanel: { category: "desktop-only" },
  settingsSidebarCollapsedGroups: { category: "desktop-only" },
  memory: { category: "desktop-only" },
  memoryView: { category: "desktop-only" },
  lastInboxViewedAt: { category: "shared" },
  ttsProvider: { category: "shared" },
  systemVoice: { category: "shared" },
  openaiVoice: { category: "shared" },
  openaiModel: { category: "desktop-only" },
  openaiSpeed: { category: "desktop-only" },
  openaiInstructions: { category: "desktop-only" },
  openaiResponseFormat: { category: "desktop-only" },
  localOpenaiBaseUrl: { category: "desktop-only" },
  localOpenaiModel: { category: "desktop-only" },
  localOpenaiVoice: { category: "desktop-only" },
  localOpenaiSpeed: { category: "desktop-only" },
  localOpenaiResponseFormat: { category: "desktop-only" },
  localOpenaiTimeoutMs: { category: "desktop-only" },
  geminiVoice: { category: "shared" },
  geminiModel: { category: "desktop-only" },
  edgeVoice: { category: "shared" },
  edgeRate: { category: "desktop-only" },
  edgePitch: { category: "desktop-only" },
  elevenlabsVoice: { category: "shared" },
  elevenlabsModel: { category: "desktop-only" },
  elevenlabsStability: { category: "desktop-only" },
  elevenlabsSimilarityBoost: { category: "desktop-only" },
  lmntVoice: { category: "shared" },
  lmntSpeed: { category: "desktop-only" },
  humeVoice: { category: "shared" },
  cartesiaVoice: { category: "shared" },
  cartesiaModel: { category: "desktop-only" },
  cartesiaLanguage: { category: "desktop-only" },
  cartesiaSpeed: { category: "desktop-only" },
  cartesiaEmotion: { category: "desktop-only" },
  deepgramVoice: { category: "shared" },
  xiaomiVoice: { category: "shared" },
  xiaomiModel: { category: "desktop-only" },
  xiaomiStyle: { category: "desktop-only" },
  xiaomiDialect: { category: "desktop-only" },
  mistralVoiceId: { category: "shared" },
  mistralModel: { category: "desktop-only" },
  mistralResponseFormat: { category: "desktop-only" },
  realtimeVoice: { category: "desktop-only" },
  realtimeModel: { category: "desktop-only" },
  realtimeInstructions: { category: "desktop-only" },
  // Live voice is desktop-first: the CN providers need the native relay, and
  // token minting depends on the host keyring. A phone has neither, so syncing
  // deployments to it would advertise sessions it cannot open.
  liveVoice: { category: "desktop-only" },
  ttsEnabled: { category: "shared" },
  ttsRate: { category: "shared" },
  ttsPitch: { category: "shared" },
  ttsVolume: { category: "shared" },
  ttsAutoPlay: { category: "shared" },
  ttsCacheEnabled: { category: "desktop-only" },
  ttsStreamingEnabled: { category: "desktop-only" },
  ttsFallbackEnabled: { category: "desktop-only" },
  ttsCustomSSMLEnabled: { category: "desktop-only" },
  ttsCustomSSML: { category: "desktop-only" },
  ttsPronunciationDictionary: { category: "desktop-only" },
  searchEnabled: { category: "shared" },
  searchMaxResults: { category: "shared" },
  searchFallbackEnabled: { category: "shared" },
  searchMaxRetries: { category: "desktop-only" },
  defaultSearchProvider: { category: "shared" },
  searchProviders: { category: "desktop-only" },
  defaultSearchType: { category: "desktop-only" },
  defaultSearchDepth: { category: "desktop-only" },
  defaultSearchRecency: { category: "desktop-only" },
  defaultSearchCountry: { category: "desktop-only" },
  defaultSearchLanguage: { category: "desktop-only" },
  defaultIncludeDomains: { category: "desktop-only" },
  defaultExcludeDomains: { category: "desktop-only" },
  defaultIncludeAnswer: { category: "desktop-only" },
  defaultIncludeRawContent: { category: "desktop-only" },
  searchCacheEnabled: { category: "desktop-only" },
  searchCacheTTL: { category: "desktop-only" },
  searchCacheMaxEntries: { category: "desktop-only" },
  searchSafeSearchEnabled: { category: "desktop-only" },
  searchSafeSearchLevel: { category: "desktop-only" },
  sourceVerificationSettings: { category: "desktop-only" },
  searchUsageStats: { category: "desktop-only" },
  customSearchSources: { category: "desktop-only" },
  defaultSearchSources: { category: "desktop-only" },
  artifacts: { category: "desktop-only" },
  // `shared`, not `desktop-only`: `/me/eval` renders the desktop eval settings
  // section whole, so the phone both shows and edits this field. Classified
  // `desktop-only` it crossed the wire in neither direction, which meant the
  // phone displayed built-in defaults rather than the host's real eval config
  // and every edit made there stayed on the handset — while the runs those
  // defaults govern execute on the desktop.
  evalSettings: { category: "shared" },
  backupReminderDays: { category: "desktop-only" },
  backupReminderDismissedAt: { category: "desktop-only" },
  backupAutoSchedule: { category: "desktop-only" },
  backupDestinations: { category: "desktop-only" },
  // Same shape as `backupDestinations`: non-secret config here, the OAuth
  // client secret and tokens in the host keyring, and a loopback callback
  // (`/oauth/docs/{provider}/callback`) only the desktop can serve.
  docsProviders: { category: "desktop-only" },
  a2uiDefaultEnabled: { category: "desktop-only" },
  a2uiDefaultCatalogId: { category: "desktop-only" },
  a2uiDefaultHostStrategy: { category: "desktop-only" },
  a2uiDefaultTheme: { category: "desktop-only" },
  a2uiPersistenceLimit: { category: "desktop-only" },
  colorTheme: { category: "shared" },
  customThemes: { category: "shared" },
  activeCustomThemeId: { category: "shared" },
  activePluginThemeId: { category: "shared" },
  accentColor: { category: "shared" },
  defaultProvider: { category: "desktop-only" },
  defaultAccountIds: { category: "desktop-only" },
  defaultAccountId: { category: "desktop-only" },
  petSettings: { category: "desktop-only" },
  installUuid: { category: "desktop-only" },
  sandboxDefaultEnabled: { category: "desktop-only" },
  workspaceConfinementEnabled: { category: "desktop-only" },
  canvasCodeSandboxEnabled: { category: "desktop-only" },
  sandboxTier: { category: "desktop-only" },
  sandboxPolicy: { category: "desktop-only" },
  cacheOptimizationEnabled: { category: "desktop-only" },
  surfaceSkillsEnabled: { category: "shared" },
  planSettings: { category: "desktop-only" },
  providerSettings: { category: "desktop-only" },
  customProviders: { category: "desktop-only" },
  providerUsageStats: { category: "desktop-only" },
  providerUIPreferences: { category: "desktop-only" },
  providerOnboardingDismissed: { category: "desktop-only" },
  onboardingDismissedAt: { category: "desktop-only" },
  onboardingProgress: {
    category: "device-local",
    rationale:
      "Every device legitimately completes onboarding once on its own: a phone's onboarding is substantially the pairing flow, and pairing is per-device. Syncing this would let a desktop completion mark an unpaired phone as onboarded, stranding it in a state that is simultaneously 'done' and unusable.",
  },
  onboardingProfile: { category: "shared" },
  modelMappings: { category: "desktop-only" },
  routingConfig: { category: "desktop-only" },
  semanticToolRouting: { category: "desktop-only" },
  difficultyRouting: { category: "desktop-only" },
  autoRouting: { category: "desktop-only" },
  routingFallbackEnabled: { category: "desktop-only" },
  routingPresets: { category: "desktop-only" },
  background: { category: "desktop-only" },
  wallpapers: { category: "shared" },
  customCss: { category: "shared" },
  customCssEnabled: { category: "shared" },
  importedVscodeThemes: { category: "shared" },
  density: { category: "shared" },
  radius: { category: "shared" },
  motion: { category: "shared" },
  agentFlowMode: { category: "desktop-only" },
  messageDisplay: { category: "shared" },
  usageDisplayMode: { category: "desktop-only" },
  typographyExt: { category: "shared" },
  a11y: { category: "shared" },
  autoMode: { category: "shared" },
  monacoLink: { category: "desktop-only" },
  activeThemePackId: { category: "desktop-only" },
  customCssScope: { category: "desktop-only" },
  componentStyles: { category: "desktop-only" },
  // Pointer art and the pointer-effect layer are inert on a touch device — the
  // applier and the effect overlay both stand down on a coarse pointer. Syncing
  // it down would mirror a preference the phone can never express.
  cursor: { category: "desktop-only" },
  webrtcEnabled: {
    category: "device-local",
    rationale:
      "Whether to attempt the WebRTC tier is a per-device transport choice — a desktop on wired ethernet and a phone on cellular want different answers. The endpoints it dials are server-authoritative; the opt-in is not.",
  },
  signalingUrl: {
    category: "server-authoritative",
    rationale:
      "Rendezvous endpoint. Both peers must dial the same server, and the desktop/cloud host is the one that knows which signaling deployment it is registered with. Mirroring it down is what makes a self-hosted signaling server reach the phone at all (previously the phone always fell back to DEFAULT_SIGNALING_URL).",
  },
  shareUrl: { category: "desktop-only" },
  webdavSync: { category: "desktop-only" },
  iceServers: {
    category: "server-authoritative",
    rationale:
      "STUN set belongs to the deployment, not the handset. A self-hosted STUN configured on the host has to reach every paired client or NAT traversal silently degrades.",
  },
  turnServers: {
    category: "server-authoritative",
    rationale:
      "Static TURN relays belong to the deployment. Without mirroring, a phone behind symmetric NAT can never use the operator's relay and WebRTC simply fails.",
  },
  // Host-local keyring reference. Paired clients receive only the short-lived
  // ICE servers the host provisions, merged into the mirrored turnServers.
  turnProvider: { category: "desktop-only" },
  externalBridge: { category: "desktop-only" },
  networkProxy: { category: "desktop-only" },
  biometricRequiredFor: {
    category: "device-local",
    rationale:
      "Gating is a property of this device's own authenticator (Face ID / Touch ID / none). Mirroring one device's policy onto another would silently weaken it, or lock out a device with no biometric hardware at all.",
  },
  accountAutoLockMinutes: { category: "desktop-only" },
  mobileComputerUseEnabled: { category: "shared" },
  automationPolicy: { category: "desktop-only" },
  lsp: { category: "desktop-only" },
  developer: { category: "desktop-only" },
} as const satisfies Record<keyof AppSettings, SettingsSyncEntry>

function keysWithCategory(...categories: SettingsSyncCategory[]): (keyof AppSettings)[] {
  const wanted = new Set<SettingsSyncCategory>(categories)
  return (Object.keys(SETTINGS_SYNC) as (keyof AppSettings)[])
    .filter((key) => wanted.has(SETTINGS_SYNC[key].category))
    .sort()
}

/**
 * Fields a paired client may write to its host via `app_settings_update`.
 * Mirrored into Rust as `APP_SETTINGS_MOBILE_ALLOWED_KEYS` by the generator —
 * the Rust constant is the enforcement point; this export exists so client code
 * can avoid enqueuing a write the host will reject.
 */
export const MOBILE_WRITABLE_SETTING_KEYS: readonly (keyof AppSettings)[] =
  keysWithCategory("shared")

/**
 * Fields the host mirrors down onto a paired client's own settings row.
 * Consumed by `lib/sync/handlers/app-settings.ts`.
 */
export const CROSS_PLATFORM_SETTING_KEYS: readonly (keyof AppSettings)[] = keysWithCategory(
  "shared",
  "server-authoritative"
)

/** Fields that deliberately never cross the wire, with the reason why. */
export const NON_SYNCED_SETTING_REASONS: Readonly<Partial<Record<keyof AppSettings, string>>> =
  Object.fromEntries(
    (Object.keys(SETTINGS_SYNC) as (keyof AppSettings)[])
      .map((key) => [key, SETTINGS_SYNC[key]] as const)
      .filter(([, entry]) => entry.category === "device-local")
      .map(([key, entry]) => [key, (entry as { rationale: string }).rationale])
  )
