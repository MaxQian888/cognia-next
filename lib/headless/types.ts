/**
 * Headless runtime registry — shared types (ADR-0059 W2 / T-A1).
 *
 * The desktop boots its long-running side-effects (sync sources, schedulers,
 * connector runtime, initializers) through React provider effects. A headless
 * brain (`cognia-agent serve`) has no React tree, so every such runtime is
 * extracted into a plain-TS `HeadlessRuntime` and registered in
 * `lib/headless/registry.ts`; the provider becomes a thin wrapper on desktop
 * and `bootstrapHeadlessRuntimes()` starts the same code in Node.
 *
 * HARD RULE (enforced by the wiring auditor): new runtime side-effects must
 * register here — a raw provider effect is desktop-only by construction and
 * silently missing from cloud installs.
 */

/**
 * The bridge shape the three data-plane installers already accept (previously
 * triplicated as a local `TauriBridge` interface in desktop-sync-source /
 * desktop-message-source / desktop-write-source). On desktop this is Tauri's
 * `{ listen, invoke }`; headless it is the `BridgeClient` over `/ws/v1/bridge`.
 */
export interface RuntimeBridge {
  listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>
  invoke(name: string, args: Record<string, unknown>): Promise<unknown>
}

/** Which host processes a runtime is meant to run on. */
export type HeadlessHost = "brain"

/** Teardown returned by a started runtime. */
export type HeadlessTeardown = () => void | Promise<void>

export interface HeadlessRuntimeContext {
  /** The hosting process kind. */
  host: HeadlessHost
  /** The unlocked local account this brain serves. */
  accountId: string
  /** Data-plane bridge (request/respond) for the three installers. */
  bridge: RuntimeBridge
  /**
   * Signal that a Dexie mutation happened so the durability layer can
   * schedule a snapshot flush.
   */
  notifyDbWrite: () => void
  /** Host filesystem adapter for scheduled encrypted backups. */
  backupFilesystem?: import("@/lib/data/backup-scheduler").BackupFilesystem
  /** Node plugin host adapter; native disk lifecycle stays in cognia-server. */
  pluginRuntime?: HeadlessPluginRuntimeAdapter
  /**
   * Resolve a user-facing message key (both locales live in `i18n/messages`)
   * — the headless stand-in for `useTranslations()`.
   */
  resolveMessage: (key: string, params?: Record<string, string | number>) => string
  /** Structured logging into the serve process's logger. */
  log: (level: "info" | "warn" | "error", message: string) => void
}

export interface HeadlessPluginChange {
  action: "installed" | "restored" | "uninstalled"
  pluginId: string
  accountId?: string | null
}

export interface HeadlessPluginRuntimeAdapter {
  start(): Promise<void>
  reconcile(change: HeadlessPluginChange): Promise<void>
  stop?(): Promise<void> | void
}

export interface HeadlessRuntime {
  /** Unique name (kebab-case), e.g. `"desktop-sync-source"`. */
  name: string
  /** Hosts this runtime starts on. */
  hosts: HeadlessHost[]
  /**
   * Start the runtime. May return a teardown; runtimes without cleanup can
   * return nothing.
   */
  start(ctx: HeadlessRuntimeContext): HeadlessTeardown | void | Promise<HeadlessTeardown | void>
}
