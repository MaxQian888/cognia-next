/**
 * Plugin-contributed external-agent SESSION IMPORTERS
 * (`manifest.sessionImporters`, ADR-0062).
 *
 * The host ships first-party importers for Claude Code / Codex / OpenCode /
 * Gemini CLI / Continue / Aider. A `sessionImporter` contribution lets a plugin
 * add a NEW agent (Cursor, Cline, Windsurf, Zed, …) with no host change — the
 * exact escape valve for the fragile, undocumented on-disk formats the host
 * deliberately does not want to own/maintain.
 *
 * A session importer is CODE: the plugin ships a factory that returns an
 * `AgentSessionSourceAdapter` (with `scanRoots` / `detect` / `listSessions` /
 * `parseSession`). The factory module is lazy-imported on plugin enable in the
 * RENDERER and registered into the session-source registry under the namespaced
 * id `${pluginId}:${id}`, so a plugin can never shadow a built-in source.
 * Disabling the plugin unregisters every source it contributed. Mirrors the
 * ADR-0051 `externalAgentAdapters` shape 1:1.
 */

/** One session-importer contribution inside `PluginManifest.sessionImporters`. */
export interface PluginSessionImporterDef {
  /**
   * Source id. Registered as the namespaced `${pluginId}:${id}`, so a bare id
   * like `"cursor"` never shadows a built-in source such as `"claude-code"`.
   */
  id: string
  /** Human-readable label for diagnostics and the contributed-capability tab. */
  label: string
  /** Optional one-line description of the agent whose history this imports. */
  description?: string
  /**
   * Relative module path (lazy-imported on enable, renderer-side). REQUIRED —
   * an importer is always code.
   */
  entry: string
  /**
   * Export name of the factory in `entry`. The export must be a
   * `() => AgentSessionSourceAdapter` function. REQUIRED.
   */
  export: string
}
