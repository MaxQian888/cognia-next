/**
 * Plugin-contributed terminal completion providers (ADR-0039).
 *
 * A plugin can contribute Copilot-style command suggestions to the
 * integrated terminal in two ways:
 *
 *  1. **Declarative (manifest)** — `manifest.terminalCompletionProviders`
 *     lists lazy `{ id, label, entry, export }` factories. The
 *     `terminal-completion-bridge` imports each on plugin enable and
 *     registers the produced provider into the host completion registry.
 *
 *  2. **Imperative (runtime)** — `ctx.terminal.registerCompletionProvider(...)`
 *     (gated by `terminal:completion`) registers a provider on the fly.
 *
 * Both paths funnel through the same adapter so a plugin sees one provider
 * shape regardless of how it registered.
 */

import type { PluginContributionBackend } from "@/types/plugin/plugin"

/** Read-only context handed to a plugin completion provider. */
export interface PluginTerminalCompletionContext {
  /** Shell family — `bash` | `zsh` | `pwsh` | `powershell` | `cmd` | `fish` | `nu` | `sh` | `unknown`. */
  shell: string
  /** Raw shell binary path/name. */
  shellPath: string
  /** Working directory, or null if unknown. */
  cwd: string | null
  /** The partial command typed so far. */
  input: string
  /** Recent command lines, oldest → newest. */
  recentCommands: string[]
  /** Platform hint. */
  platform: "windows" | "macos" | "linux" | "other"
}

/** A single suggestion from a plugin provider. `text` is the FULL line. */
export interface PluginTerminalCompletionItem {
  /** Full suggested command line (should start with the context input). */
  text: string
  /** Short label shown beside the ghost text (e.g. "git", "npm"). */
  detail?: string
  /** Optional confidence in [0,1]; defaults to 0.5 when omitted. */
  score?: number
}

/** The provider object a plugin registers (runtime form). */
export interface PluginTerminalCompletionProvider {
  /** Unique id within the plugin (namespaced with the plugin id by the host). */
  id: string
  /** Human label for settings / source badge. */
  label: string
  /** Lower runs first; default 100. */
  priority?: number
  getCompletions(
    context: PluginTerminalCompletionContext,
    signal: AbortSignal
  ): Promise<PluginTerminalCompletionItem[]> | PluginTerminalCompletionItem[]
}

/** Manifest declaration for a lazy completion provider. */
export interface PluginTerminalCompletionProviderDef {
  /** Unique id within the plugin. */
  id: string
  /** Human label. */
  label: string
  /** Module path (relative to the plugin install root). */
  /**
   * Which runtime owns this factory. Omit to inherit the plugin type
   * (`python` plugins default to `"python"`); declaring `entry` pins it to
   * `"js"`. See {@link PluginContributionBackend}.
   */
  backend?: PluginContributionBackend
  entry?: string
  /** Named export = factory returning a `PluginTerminalCompletionProvider`. */
  export?: string
  /** Lower runs first; default 100. */
  priority?: number
}

/** The factory signature a declarative provider's `export` must satisfy. */
export type PluginTerminalCompletionFactory = (ctx: {
  pluginId: string
  providerId: string
  getConfig: <T = unknown>(key: string) => T | undefined
}) => PluginTerminalCompletionProvider | Promise<PluginTerminalCompletionProvider>
