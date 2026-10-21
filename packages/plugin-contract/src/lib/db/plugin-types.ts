/**
 * The plugin contract's share of `lib/db/plugin-types.ts`, which re-exports these.
 */
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
  /**
   * Non-indexed lifecycle control-plane state. Added without a Dexie version
   * bump because the plugins table already stores arbitrary object fields.
   */
  lifecycle?: {
    intent: "auto" | "enabled" | "disabled"
    actual: "inactive" | "activating" | "active" | "waiting" | "stopping" | "error" | "dirty"
    revision: number
    generation?: number
    dirty?: {
      runtime: "frontend" | "node" | "python" | "wasm" | "vscode" | "native"
      reason: "timeout" | "error" | "unconfirmed"
      at: number
      message: string
      labels?: string[]
    }
    lastError?: string
    updatedAt: number
  }
  /** Capabilities the plugin declares (multi-entry index). */
  capabilities: string[]
  /** Resolved on-disk path (Tauri builds) or pseudo-path for builtins. */
  path: string
  /** Parsed `plugin.json` payload. Treated opaquely by Dexie. */
  manifest: Record<string, unknown>
  /** Persisted plugin configuration (the user's settings). */
  config?: Record<string, unknown>
  /** Host-owned JSON strings for ctx.storage; excluded from plugin configuration. */
  storage?: Record<string, string>
  /**
   * Host-level python runtime settings (python/hybrid plugins only).
   * Structurally identical to `types/plugin/plugin.ts:PythonHostSettings`
   * (kept dependency-free here per this file's convention). Non-indexed.
   */
  pythonHostSettings?: {
    interpreterPath?: string
    env?: Record<string, string>
    callTimeoutMs?: number
    useVenv?: boolean
    idleShutdownMin?: number
    maxConcurrentCalls?: number
    /** ADR-0145 — cap on concurrent plugin -> host RPC calls. */
    maxOutboundHostCalls?: number
    /** ADR-0145 — which tool creates the environment and installs packages. */
    installer?: {
      kind?: "auto" | "uv" | "pip" | "custom"
      path?: string
      createArgs?: string[]
      installArgs?: string[]
    }
    /** ADR-0145 — overrides the manifest's `pythonVenv`. */
    venvScope?: "shared" | "isolated"
    sandboxed?: boolean
  }
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
  /**
   * Wall-clock ms the `onInstall` lifecycle hook fired. Set once, on the first
   * successful load after install, so the host never re-fires it. Non-indexed.
   */
  installHookFiredAt?: number
  /**
   * The manifest `version` the host last activated. Compared on each load to
   * decide whether to fire `onUpdate`. Non-indexed.
   */
  lastActivatedVersion?: string
  createdAt: number
  updatedAt: number
}
