/**
 * Declarative CLI completion specs (ADR-0039 phase 2).
 *
 * A deliberately tiny, in-repo format — NOT Fig's autocomplete-spec
 * runtime (600+ specs coupled to async generators) and NOT carapace
 * (Go-coupled). Each spec describes a CLI's subcommand tree and common
 * flags; `resolve.ts` walks the typed tokens to the deepest node and
 * surfaces the matching candidates. Plugins that want richer/dynamic
 * completion register their own providers via `terminal:completion`.
 */

export interface CliOption {
  /** Canonical form, e.g. `--message`. */
  name: string
  /** Short/alternate forms, e.g. `["-m"]`. */
  aliases?: string[]
  description?: string
  /** The option consumes the next token as its value. */
  takesValue?: boolean
}

export interface CliSubcommand {
  name: string
  aliases?: string[]
  description?: string
  subcommands?: CliSubcommand[]
  options?: CliOption[]
}

export interface CliSpec {
  /** The executable name the spec matches (head word, case-insensitive). */
  name: string
  description?: string
  subcommands?: CliSubcommand[]
  /** Global options, valid at any depth. */
  options?: CliOption[]
}
