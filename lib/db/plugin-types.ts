// Dexie row shapes for the plugin tables added in schema v15.
//
// Kept minimal here so the Dexie schema bump can land before the full
// `types/plugin/plugin.ts` port (Task #9): each row carries only the
// columns its index references plus a free-form `manifest`/`payload`
// blob for everything else. The plugin runtime treats these rows as
// authoritative; Cognia's full PluginManifest type will be re-imposed
// at the CRUD layer once it's ported, which is structurally compatible
// with these shapes.
//
// Why row types live here instead of `types/plugin/`:
//   * matches the convention set by `lib/db/canvas-types.ts` and
//     `lib/db/a2ui-types.ts` — Dexie row shapes co-locate with the
//     schema, full domain types live elsewhere
//   * keeps `lib/db/schema.ts` from depending on `types/plugin/*` until
//     those types are ported in Task #9

/**
 * One row per installed plugin (built-in or user-installed). Mirrors the
 * `Plugin` aggregate type that the Cognia plugin manager owns; the
 * `manifest` blob is the parsed `plugin.json` and `runtimeState` carries
 * the lifecycle status the manager needs to restore on next launch.
 */
export interface PluginRow {
  id: string
  name: string
  version: string
  /**
   * Lifecycle status — values match Cognia's `PluginStatus` (discovered /
   * installed / loaded / enabled / disabled / error / etc.). Kept as a
   * loose string so we don't need to import the full enum here.
   */
  status: string
  /** "builtin" | "local" | "marketplace" | "git" | "dev". */
  source: string
  /** "frontend" | "python" | "hybrid". */
  type: string
  /** Whether the user currently has the plugin enabled. */
  enabled: boolean
  /** Capabilities the plugin declares (multi-entry index). */
  capabilities: string[]
  /** Resolved on-disk path (Tauri builds) or pseudo-path for builtins. */
  path: string
  /** Parsed `plugin.json` payload. Treated opaquely by Dexie. */
  manifest: Record<string, unknown>
  /** Persisted plugin configuration (the user's settings). */
  config?: Record<string, unknown>
  /**
   * Raw README markdown captured at install time (GitHub installs read the
   * repo's `README.md`). Rendered in the detail view. Non-indexed.
   */
  readme?: string
  /** Raw LICENSE file text captured at install time. Non-indexed. */
  licenseText?: string
  /**
   * Canonical source URL the plugin was installed from (e.g. a GitHub
   * `…/tree/<ref>` URL). Surfaced as a link in the detail view. Non-indexed.
   */
  sourceUrl?: string
  /** Last manager-reported error message, if any. */
  error?: string
  /** Wall-clock ms of the most recent tool/command invocation. */
  lastUsedAt?: number
  createdAt: number
  updatedAt: number
}

/**
 * One row per added GitHub "marketplace repo" (Claude-Code-style plugin
 * dispatch). The repo ships a `marketplace.json` catalog; its listed plugins
 * surface in the browse grid. Added in Dexie v59.
 */
export interface PluginMarketplaceSourceRow {
  /** Canonical `owner/repo` (+ optional `@ref`) reference; primary key. */
  id: string
  /** The raw reference the user entered (URL or shorthand). */
  repoRef: string
  /** Catalog `name` (from marketplace.json), or the repo for display. */
  name: string
  /** Wall-clock ms the source was added. */
  addedAt: number
}

/**
 * One row per (plugin, permission) pair. Stores remembered grant/deny
 * decisions so the runtime doesn't re-prompt on every invocation.
 */
export interface PluginPermissionRow {
  pluginId: string
  permission: string
  /** "allow" | "deny" | "ask" (defaults to ask if absent). */
  decision: string
  /** Optional millisecond expiry — `undefined` means "remember forever". */
  expiresAt?: number
  grantedBy?: string
  grantedAt: number
}

/**
 * One row per user review. Mirrored from the marketplace; cached locally so
 * the marketplace tab can render offline.
 */
export interface PluginReviewRow {
  id: string
  pluginId: string
  /** 1..5 inclusive. */
  rating: number
  title?: string
  body?: string
  authorName?: string
  createdAt: number
}

/**
 * One row per (plugin, analytics-key) pair. Tracks usage counters so the
 * Health / Analytics tabs can show "X invocations this week" without a
 * separate event-log table.
 */
export interface PluginAnalyticsRow {
  pluginId: string
  key: string
  count: number
  lastEventAt: number
}

/**
 * One row per scheduled task contributed by a plugin. The scheduler executor
 * (`lib/scheduler/executors/plugin-executor.ts`) pulls these rows on tick.
 */
export interface PluginScheduledJobRow {
  id: string
  pluginId: string
  /** Cron expression or interval description. */
  cron: string
  /** Plugin-side handler name to invoke. */
  handler: string
  /** Free-form arguments passed to the handler. */
  args?: Record<string, unknown>
  /** "active" | "paused" | "error". */
  status: string
  lastRunAt?: number
  nextRunAt?: number
  createdAt: number
  updatedAt: number
}

/**
 * Registry entry for a plugin's declared Dexie tables (schema v27). Written by
 * `applyPluginTables`; read on launch to restore the plugin table set.
 */
export interface PluginDexieMeta {
  /** Primary key — the plugin's id. */
  pluginId: string
  /** Namespaced table names currently registered for this plugin. */
  tableNames: string[]
  /** The Dexie db version at which these tables were last registered. */
  dexieVersion: number
  appliedAt: number
}
