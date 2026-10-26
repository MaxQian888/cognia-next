/**
 * The plugin contract's share of `lib/terminal/profiles.ts`, which re-exports these.
 */
export interface TerminalProfile {
  /** Stable id (used as React key + `defaultProfileId` reference). */
  id: string
  /** User-facing label shown in the picker + settings list. */
  name: string
  /** Shell binary — absolute path or PATH-resolvable name. */
  shell: string
  /** Optional initial working directory. */
  cwd?: string
  /** Optional extra argv passed after the shell. */
  args?: string[]
  /** Optional extra environment variables. */
  env?: Record<string, string>
  /**
   * Commands to run automatically after the shell initializes.
   * Executed sequentially — each command is sent to the PTY with a trailing
   * `\r`. The session waits for a prompt (OSC 633 prompt_start) or a short
   * fallback delay between commands.
   */
  startupCommands?: string[]
}
