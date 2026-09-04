/**
 * Update Center contract: the vocabulary every updatable asset in Cognia
 * shares, regardless of who actually performs the installation.
 *
 * The distinction this file exists to keep honest: Cognia *discovers* an
 * update for every asset kind, but it only *installs* the ones whose executor
 * it owns. A Chrome extension update is discovered here and installed by
 * Chrome. An App Store build is discovered here and installed by the App
 * Store. Collapsing those into one "Update" button is the defect this
 * vocabulary prevents, see `UpdateExecutor` and `UpdateAction`.
 *
 * Zero `@/` imports: this package is built standalone by `pnpm build:packages`
 * and consumed by the app, the CLI, and the update Worker.
 */

/** What kind of thing is being updated. */
export type UpdateAssetKind =
  | "desktop"
  | "mobile-ios"
  | "mobile-android"
  | "browser-chrome"
  | "browser-edge"
  | "cli"
  | "plugin"
  | "skill"
  | "character-pack"

export const UPDATE_ASSET_KINDS: readonly UpdateAssetKind[] = [
  "desktop",
  "mobile-ios",
  "mobile-android",
  "browser-chrome",
  "browser-edge",
  "cli",
  "plugin",
  "skill",
  "character-pack",
]

/** Who performs the installation. Never assume it is Cognia. */
export type UpdateExecutor =
  | "tauri"
  | "app-store"
  | "google-play"
  | "browser-store"
  | "package-manager"
  | "plugin-runtime"
  | "skill-runtime"
  | "character-pack-runtime"

export const UPDATE_EXECUTORS: readonly UpdateExecutor[] = [
  "tauri",
  "app-store",
  "google-play",
  "browser-store",
  "package-manager",
  "plugin-runtime",
  "skill-runtime",
  "character-pack-runtime",
]

/**
 * Executors Cognia itself can drive to completion in-process. Everything else
 * hands off to a store, a browser, or a package manager, and the Update Center
 * must say so instead of showing an "Install" button it cannot honor.
 */
export const IN_APP_EXECUTORS: readonly UpdateExecutor[] = [
  "tauri",
  "plugin-runtime",
  "skill-runtime",
  "character-pack-runtime",
]

export function isInAppExecutor(executor: UpdateExecutor): boolean {
  return IN_APP_EXECUTORS.includes(executor)
}

/**
 * Lifecycle of one asset's update. Every terminal-looking state that is not
 * actually terminal is named for what it is waiting on, because "installing"
 * that never resolves is the failure mode users report as a hang.
 */
export type UpdateState =
  | "current"
  | "checking"
  | "available"
  | "deferred"
  | "downloading"
  | "awaiting-consent"
  | "awaiting-store"
  | "awaiting-reload"
  | "awaiting-restart"
  | "installing"
  | "verified"
  | "failed"
  | "cancelled"

export const UPDATE_STATES: readonly UpdateState[] = [
  "current",
  "checking",
  "available",
  "deferred",
  "downloading",
  "awaiting-consent",
  "awaiting-store",
  "awaiting-reload",
  "awaiting-restart",
  "installing",
  "verified",
  "failed",
  "cancelled",
]

/** States in which no further work is pending on our side. */
export const RESTING_UPDATE_STATES: readonly UpdateState[] = [
  "current",
  "available",
  "deferred",
  "verified",
  "failed",
  "cancelled",
]

/** Release channels. `canary` is internal-only and never offered in the UI. */
export type UpdateChannel = "stable" | "beta" | "canary"

export const USER_SELECTABLE_CHANNELS: readonly UpdateChannel[] = ["stable", "beta"]

/**
 * How badly the update is needed. `critical` may be deferred but never
 * permanently skipped, and is never allowed to block normal use of the app.
 */
export type UpdateCriticality = "routine" | "recommended" | "critical"

/** Where a candidate's version information came from. */
export type UpdateSource =
  "catalog" | "tauri-endpoint" | "registry" | "store" | "marketplace" | "plugin-host" | "local"

/** Result of verifying the metadata that produced a candidate. */
export type UpdateProvenanceStatus = "verified" | "unsigned" | "untrusted" | "revoked" | "expired"

/** Compatibility constraints a candidate declares against its host. */
export interface UpdateCompatibility {
  /** Minimum app version this candidate can be installed onto. */
  minAppVersion?: string
  /** Maximum app version, set when a candidate is pinned to a host line. */
  maxAppVersion?: string
  /** Minimum OS version, formatted per platform (for example "13.0" on macOS). */
  minOsVersion?: string
  /** Runtime API or contract version required (plugins, skills, SDK). */
  minRuntimeVersion?: string
  /**
   * Set when installing this candidate cannot be undone by installing the
   * previous version. Surfaced before consent, not after.
   */
  breaking?: boolean
}

/** Staged-rollout window a candidate is currently inside. */
export interface UpdateRollout {
  /** 0 to 100. A device is offered the candidate when its bucket falls under it. */
  percentage: number
  /** Operator-controlled hold. A paused rollout offers nobody. */
  paused?: boolean
  /** Set when the release was pulled. Overrides everything, including a manual check. */
  revoked?: boolean
}

/** One concrete update a given asset could move to. */
export interface UpdateCandidate {
  /** Stable identity of the asset within its kind (plugin id, "app", "cli"). */
  assetId: string
  kind: UpdateAssetKind
  executor: UpdateExecutor
  /** Version currently installed, or null when nothing is installed locally. */
  currentVersion: string | null
  targetVersion: string
  channel: UpdateChannel
  criticality: UpdateCriticality
  compatibility?: UpdateCompatibility
  /** Human release notes. Never logged, see the telemetry contract. */
  releaseNotes?: string
  releasedAt?: string
  rollout?: UpdateRollout
  source: UpdateSource
  provenance: UpdateProvenanceStatus
  /** Package size in bytes when the executor knows it up front. */
  sizeBytes?: number
  /**
   * Set when applying this candidate widens what the asset is allowed to do.
   * Forces explicit consent even when the asset would otherwise auto-apply.
   */
  permissionsExpanded?: boolean
  /** Where a store or registry executor should send the user. */
  externalUrl?: string
  /**
   * Action offered for this specific candidate, overriding the executor
   * default. macOS desktop uses it to hand off to a signed, notarized DMG
   * rather than claiming an in-app install it deliberately does not perform.
   */
  action?: UpdateAction
}

/** Error families that survive as stable codes in logs and telemetry. */
export type UpdateErrorKind =
  | "network"
  | "timeout"
  | "signature"
  | "expired"
  | "rollback"
  | "revoked"
  | "incompatible"
  | "permission"
  | "disk"
  | "cancelled"
  | "store"
  | "package-manager"
  | "unsupported"
  | "unknown"

export interface UpdateFailure {
  kind: UpdateErrorKind
  /** Stable, non-localized code. Never contains user content or URLs. */
  code: string
  /** Localization key for what the user should do next. */
  recoveryActionKey?: string
}

/**
 * Everything about one asset that must survive a process restart. This is the
 * reason a desktop install that crashed halfway can be recognised as such on
 * the next launch instead of silently re-offering the same version.
 */
export interface UpdateSnapshot {
  assetId: string
  kind: UpdateAssetKind
  state: UpdateState
  /** Epoch ms of the last completed check, successful or not. */
  lastCheckedAt?: number
  /** Epoch ms the coordinator is allowed to check again (backoff or Retry-After). */
  nextCheckAt?: number
  /** Version the user chose to never be told about again. Never set for critical. */
  skippedVersion?: string
  /** Version the user postponed, with the epoch ms it may be raised again. */
  deferredVersion?: string
  deferredUntil?: number
  /** Correlates the phases of one install across restarts. */
  attemptId?: string
  /** Version the in-flight attempt is moving away from. */
  fromVersion?: string
  /** Version the in-flight attempt is moving to. */
  targetVersion?: string
  /** Epoch ms the current attempt began. */
  startedAt?: number
  /** Consecutive failed checks, which drives exponential backoff. */
  consecutiveFailures?: number
  failure?: UpdateFailure
}

/** The single next thing the user can do about an asset. */
export type UpdateAction =
  | "install-in-app"
  | "open-store"
  | "reload-extension"
  | "run-package-manager"
  | "restart-desktop"
  | "review-permissions"
  | "open-pack-diff"

export const UPDATE_ACTIONS: readonly UpdateAction[] = [
  "install-in-app",
  "open-store",
  "reload-extension",
  "run-package-manager",
  "restart-desktop",
  "review-permissions",
  "open-pack-diff",
]

/** The action each executor offers when a candidate is ready to apply. */
export const EXECUTOR_PRIMARY_ACTION: Record<UpdateExecutor, UpdateAction> = {
  tauri: "install-in-app",
  "app-store": "open-store",
  "google-play": "open-store",
  "browser-store": "reload-extension",
  "package-manager": "run-package-manager",
  "plugin-runtime": "install-in-app",
  "skill-runtime": "install-in-app",
  "character-pack-runtime": "open-pack-diff",
}

/** Display grouping used by the Update Center. */
export type UpdateGroup = "apps-and-runtimes" | "extensions" | "plugins-and-content"

export const UPDATE_GROUP_ORDER: readonly UpdateGroup[] = [
  "apps-and-runtimes",
  "extensions",
  "plugins-and-content",
]

export const ASSET_KIND_GROUP: Record<UpdateAssetKind, UpdateGroup> = {
  desktop: "apps-and-runtimes",
  "mobile-ios": "apps-and-runtimes",
  "mobile-android": "apps-and-runtimes",
  cli: "apps-and-runtimes",
  "browser-chrome": "extensions",
  "browser-edge": "extensions",
  plugin: "plugins-and-content",
  skill: "plugins-and-content",
  "character-pack": "plugins-and-content",
}

/** Persisted Update Center preferences. */
export interface UpdateCenterSettings {
  /** Release channel the device follows. `canary` is never set from the UI. */
  channel: UpdateChannel
  /** Signed catalog control plane. Empty means use the compiled-in default. */
  catalogUrl?: string
  /**
   * Background download is permitted for first-party desktop packages only.
   * Every other executor requires explicit consent regardless of this flag.
   */
  backgroundDownloadDesktop: boolean
  /** Surface critical updates on launch even when auto-check is off. */
  notifyCritical: boolean
  /** Per-asset snapshots, keyed `${kind}:${assetId}`. */
  snapshots?: Record<string, UpdateSnapshot>
  /**
   * Stable 0 to 9999 rollout bucket. Generated once per device from local
   * randomness, never derived from an account, device or diagnostics id.
   */
  rolloutBucket?: number
}

export const DEFAULT_UPDATE_CENTER_SETTINGS: UpdateCenterSettings = {
  channel: "stable",
  backgroundDownloadDesktop: false,
  notifyCritical: true,
}

/** Key an asset takes in `UpdateCenterSettings.snapshots`. */
export function updateSnapshotKey(kind: UpdateAssetKind, assetId: string): string {
  return `${kind}:${assetId}`
}

/**
 * Legal state transitions. Anything not listed is a bug in an adapter, and the
 * coordinator refuses it rather than letting a row show an impossible state.
 */
export const UPDATE_STATE_TRANSITIONS: Record<UpdateState, readonly UpdateState[]> = {
  // A check that finds something goes straight from current to available:
  // `checking` is a visible phase, not a mandatory one, and requiring it made
  // every discovered update illegal.
  current: ["checking", "available", "deferred", "failed"],
  checking: ["current", "available", "deferred", "failed", "cancelled"],
  available: [
    "checking",
    "downloading",
    "awaiting-consent",
    "awaiting-store",
    "awaiting-reload",
    "deferred",
    "installing",
    "current",
    "failed",
    "cancelled",
  ],
  deferred: ["checking", "available", "current", "failed"],
  downloading: ["awaiting-consent", "installing", "failed", "cancelled"],
  "awaiting-consent": ["installing", "downloading", "deferred", "cancelled", "failed"],
  "awaiting-store": ["checking", "verified", "current", "available", "deferred", "failed"],
  "awaiting-reload": ["checking", "verified", "current", "available", "deferred", "failed"],
  "awaiting-restart": ["verified", "failed", "checking", "available", "current"],
  installing: ["awaiting-restart", "awaiting-reload", "verified", "failed", "cancelled"],
  verified: ["checking", "current", "available"],
  failed: ["checking", "available", "deferred", "cancelled", "installing", "downloading"],
  cancelled: ["checking", "available", "deferred", "current"],
}

export function canTransitionUpdateState(from: UpdateState, to: UpdateState): boolean {
  if (from === to) return true
  return UPDATE_STATE_TRANSITIONS[from].includes(to)
}
