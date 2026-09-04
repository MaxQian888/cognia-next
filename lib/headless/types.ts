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
 * `{ listen, invoke }`; headless it is the `BridgeClient` over `/internal/bridge`.
 */
export interface RuntimeBridge {
  listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>
  invoke(name: string, args: Record<string, unknown>): Promise<unknown>
  /**
   * Answer a pending `companion://session-media-request` with raw bytes.
   *
   * Separate from `invoke` on purpose, and required rather than optional.
   * `respondSessionMedia` used to call `invoke(name, bytes, { headers })`
   * against a locally-declared three-parameter interface, and TypeScript
   * happily accepts a two-parameter function there: the bytes landed in the
   * `args` slot, the headers were dropped, and the frame reached a
   * `route_respond` that had no arm for it, so every attachment read on a
   * headless host ended in a thirty-second timeout. A distinct method name is
   * what makes that unrepresentable, because a two-parameter `invoke` is not
   * assignable to a missing method. Optional would reintroduce it in new
   * clothes, since `?.()` fails silently in exactly the same way.
   *
   * On desktop this maps onto Tauri's raw invoke body plus `InvokeOptions`
   * headers. Over the WS bridge it becomes a typed `respond` payload, since
   * the frame set is newline-delimited JSON text with no binary variant.
   */
  respondMedia(response: MediaResponse): Promise<void>
}

/** One answer to a session-media read. `error` and `bytes` are exclusive. */
export interface MediaResponse {
  requestId: string
  bytes: Uint8Array
  /** MIME type of `bytes`; ignored when `error` is set. */
  mediaType: string
  /** Strong validator the Host echoes back to the device. */
  etag?: string | null
  /** `INVALID_PARAMS` / `MEDIA_NOT_FOUND` / `MEDIA_TOO_LARGE`, else absent. */
  error?: string | null
}

/**
 * Ceiling on a single media answer, mirroring `MAX_MEDIA_BYTES` on the Rust
 * side. Checked before the bytes are encoded so an oversized blob is refused
 * with a named error instead of being dropped into a timeout.
 */
export const MAX_MEDIA_RESPONSE_BYTES = 10 * 1024 * 1024

/** Which host processes a runtime is meant to run on. */
export type HeadlessHost = "brain"

/** Teardown returned by a started runtime. */
export type HeadlessTeardown = () => void | Promise<void>

export interface HeadlessRuntimeContext {
  /** The hosting process kind. */
  host: HeadlessHost
  /** The unlocked local account this brain serves. */
  localAccountId: string
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
