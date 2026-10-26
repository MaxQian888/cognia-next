/**
 * The plugin contract's share of `lib/plugin/api/terminal-api.ts`, which re-exports these.
 */
import type { CommandVerdict } from "../../claude/permissions/command-safety"
import type { PluginTerminalCompletionProvider } from "../../../types/plugin/plugin-terminal-completion"
import type { ScriptType } from "../../terminal/script-runner"

/** A plugin-contributed command-safety rule (`command-glob → verdict`). */
export interface PluginCommandRule {
  /** Command glob; author with a trailing `*`, e.g. `"deploy-prod*"`. */
  pattern: string
  /** Verdict applied when a command segment matches the glob. */
  verdict: CommandVerdict
}

/** Result of `ctx.terminal.classifyCommand`. */
export interface PluginCommandClassification {
  verdict: CommandVerdict
  /** Short English rationale for the most severe finding. */
  reason: string
  /** Head command that drove the verdict, when known. */
  matched?: string
}

export interface PluginTerminalSpawnOptions {
  /** Shell binary (absolute path or PATH name). Empty → host shell-detect. */
  shell?: string
  /** Initial working directory. */
  cwd?: string
  /** Project the tab belongs to (drives dock filtering). */
  projectId?: string
  /** Extra environment variables. */
  env?: Record<string, string>
  rows?: number
  cols?: number
  /** OSC-633 shell integration. Default true. */
  enableShellIntegration?: boolean
}

export interface PluginTerminalInfo {
  id: string
  shell: string
  cwd: string | null
  status: "idle" | "running" | "exited"
}

export interface PluginTerminalCommandRecord {
  cmd: string
  exitCode: number | null
  endedAt: number
}

/** Options for `ctx.terminal.runScript`. */
export interface PluginRunScriptOptions {
  /** Explicit interpreter override (bypasses extension/shebang detection). */
  interpreter?: string
  /** Initial working directory. */
  cwd?: string
  /** Arguments passed to the script (after its path). */
  args?: string[]
  /** Extra environment variables. */
  env?: Record<string, string>
  rows?: number
  cols?: number
  /** Project the tab belongs to. */
  projectId?: string
  /** First line of the file, if known — a `#!` shebang wins over the ext. */
  shebang?: string
}

export interface PluginTerminalAPI {
  /** Spawn a PTY in the dock, tagged to this plugin. Returns its id + shell. */
  spawn(options?: PluginTerminalSpawnOptions): Promise<{ id: string; shell: string }>
  /**
   * Spawn a PTY that runs a script file under the correct interpreter
   * (`.sh`→bash, `.ps1`→pwsh -File, `.py`→python3, …). Tagged to this
   * plugin like `spawn`. Throws if the type can't be determined and no
   * `interpreter` override is given.
   */
  runScript(
    scriptPath: string,
    options?: PluginRunScriptOptions
  ): Promise<{ id: string; shell: string }>
  /** Resolve how a script path would be run, without spawning. */
  detectScriptType(scriptPath: string, shebang?: string): ScriptType | null
  /** Pipe input into a session this plugin owns. */
  write(id: string, data: string | Uint8Array): Promise<void>
  /** Terminate a session this plugin owns. */
  kill(id: string): Promise<void>
  /** Subscribe to raw output bytes from a session this plugin owns. */
  onData(id: string, handler: (data: Uint8Array) => void): () => void
  /** Recent command records for a session this plugin owns (default 10). */
  readRecent(id: string, lineLimit?: number): PluginTerminalCommandRecord[]
  /** List the sessions this plugin currently owns. */
  list(): PluginTerminalInfo[]
  /**
   * Contribute Copilot-style inline command suggestions to the integrated
   * terminal. The provider is namespaced with this plugin's id and tagged
   * as `plugin`-sourced. Returns a disposer; also auto-removed on plugin
   * disable. Requires `terminal:completion`.
   */
  registerCompletionProvider(provider: PluginTerminalCompletionProvider): () => void
  /**
   * Contribute command-safety rules consulted by the agent's shell Auto-mode
   * (`lib/claude/permissions/auto-mode.ts`). Each rule maps a command glob to
   * an allow/ask/deny verdict; they sit BELOW the user's own
   * `agentPermissions.commandRules` in precedence, so a plugin can tighten or
   * loosen the policy for its own commands without overriding the user. The
   * rules merge across calls; returns a disposer (also dropped on plugin
   * disable). Requires `terminal:safety`.
   */
  registerCommandSafetyRule(rules: PluginCommandRule | PluginCommandRule[]): () => void
  /**
   * Classify how risky a shell command is, using the same deterministic engine
   * Auto-mode uses (`classifyCommand`). Pure / read-only. Requires
   * `terminal:safety`.
   */
  classifyCommand(command: string): PluginCommandClassification
}
