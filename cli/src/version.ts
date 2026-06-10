/**
 * The single source of truth for the CLI version string. A leaf module so any
 * layer (command dispatcher, TUI footer/`/about`) can read it without pulling
 * in the command graph and risking an import cycle.
 */
export const VERSION = "0.1.0"
