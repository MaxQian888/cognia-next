/**
 * Unified Language Server Protocol (LSP) configuration types.
 *
 * This is the single authoritative shape for an LSP server across BOTH
 * subsystems that previously each owned a divergent copy:
 *
 *   - the agent runtime LSP (`sidecar/lsp/*`), which previously hard-coded
 *     its server list, and
 *   - the editor LSP (`lib/plugin/lsp/*` + `lib/plugin/vscode-shim/*`),
 *     which carried `UserLspServerEntry` (settings) and `PluginLspServerDef`
 *     (plugin manifest) as two near-identical interfaces.
 *
 * `UserLspServerEntry` (`lib/claude/types.ts`) and `PluginLspServerDef`
 * (`types/plugin/plugin.ts`) are now aliases of {@link LspServerConfig} so the
 * shape lives in exactly one place. The resolver in
 * `lib/lsp/resolve-config.ts` layers builtin defaults ← user global settings ←
 * project-local `.cognia/lsp.json` into {@link ResolvedLspServer}[], and that
 * single resolved list drives both the agent sidecar (via `sendOptions.lsp`)
 * and the editor registry.
 */

/** Where a resolved server entry originated, in increasing override priority. */
export type LspServerSource = "builtin" | "plugin" | "user" | "project"

/** Transport for talking to the spawned server. Only stdio today. */
export type LspTransport = "stdio"

/**
 * One declarative Language Server definition. The same shape is authored by
 * builtin defaults, plugin manifests, user settings, and project-local
 * config files — the resolver merges them by `id`.
 */
export interface LspServerConfig {
  /**
   * Stable id. Builtin ids (`"typescript"`, `"pyright"`, `"rust-analyzer"`,
   * `"gopls"`) can be re-declared by a higher layer to override/extend the
   * default; otherwise an id is unique within its layer.
   */
  id: string
  /** Display name shown in Settings → Language Servers. */
  name: string
  /**
   * Monaco language ids this server handles (e.g. `["typescript"]`). Used by
   * the editor LSP registry to select a provider for a model.
   */
  languages: string[]
  /**
   * File extensions (with leading dot, e.g. `".ts"`) the agent runtime LSP
   * matches a file against. Required on builtin entries; optional on user
   * entries that only target the editor.
   */
  extensions?: string[]
  /** Exact file-name matches (e.g. `["Dockerfile"]`), agent-side. */
  filenames?: string[]
  /**
   * Binary to spawn. Relative paths resolve against the install dir (plugin)
   * or are PATH-probed (builtin). Supports `${workspaceFolder}` substitution.
   */
  command: string
  /** CLI arguments. Supports `${workspaceFolder}` substitution. */
  args?: string[]
  /** Environment variables merged onto the spawned process env. */
  env?: Record<string, string>
  /**
   * Project-root marker files. The agent runtime walks up from a touched
   * file toward cwd and starts the server at the nearest directory holding
   * one of these (e.g. `["Cargo.toml"]`).
   */
  rootMarkers?: string[]
  /**
   * Markers that, when found closer to the file, disable this server for
   * that tree (e.g. `["deno.json"]` lets the Deno toolchain win over
   * tsserver).
   */
  excludeRootMarkers?: string[]
  /** Transport. Stdio is the only supported value today. */
  transport?: LspTransport
  /** Forwarded verbatim as LSP `initializationOptions`. */
  initializationOptions?: Record<string, unknown>
  /**
   * Server-specific configuration returned for `workspace/configuration`
   * pull requests and pushed via `workspace/didChangeConfiguration`
   * (e.g. `{ "rust-analyzer": { "cargo": { "features": "all" } } }`).
   */
  settings?: Record<string, unknown>
  /**
   * When `true`, the editor registry materialises a real on-disk workspace
   * (via `lsp-workspace-manager`) before spawning. Required for servers that
   * read the filesystem (rust-analyzer, gopls, pylsp).
   */
  workspaceFolderRequired?: boolean
  /** When `false`, the resolver drops this entry (and any same-id default). Default true. */
  enabled?: boolean
}

/**
 * A {@link LspServerConfig} after the resolver merges every layer, tagged
 * with provenance for the UI and audit log.
 */
export interface ResolvedLspServer extends LspServerConfig {
  /** The highest-priority layer that contributed to this entry. */
  source: LspServerSource
  /**
   * When a lower-priority layer was overridden by `source`, the lower
   * layer's source (e.g. a `"user"` entry overriding a `"builtin"` default
   * records `overriddenBy: "user"` on the surviving entry). Used by the
   * settings UI to show "overrides builtin".
   */
  overriddenBy?: LspServerSource
}

/**
 * First-class `AppSettings.lsp` slice. Replaces the former
 * `DeveloperSettings.userLspServers` / `DeveloperSettings.unsignedLspAllowed`
 * fields (migrated in `lib/lsp/migrate-settings.ts`).
 */
export interface LspSettings {
  /** User-authored servers, including overrides of builtin defaults by id. */
  servers: LspServerConfig[]
  /**
   * Master toggle for the whole LSP subsystem (agent tools + editor).
   * Defaults to the legacy `builtinTools.lsp` semantics when undefined.
   */
  enabled?: boolean
  /**
   * Dev-only: allow unsigned plugin LSP binaries to spawn after a single
   * in-session consent prompt. Migrated from `developer.unsignedLspAllowed`.
   */
  unsignedAllowed?: boolean
}

/**
 * The LSP slice attached to `SendOptions.lsp` and consumed by the agent
 * sidecar (`sidecar/lsp/*`). The sidecar is a separate Node project that
 * cannot import `lib/` or `@/types`, so the renderer resolves the merged
 * server list and serialises it here.
 */
export interface LspSendOptions {
  enabled: boolean
  servers: ResolvedLspServer[]
}

/** Shape of a project-local `.cognia/lsp.json` file. */
export interface LspProjectFile {
  servers?: LspServerConfig[]
}
