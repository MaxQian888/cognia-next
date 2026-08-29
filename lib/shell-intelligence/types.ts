/**
 * Contracts for the chat composer's `!` shell intelligence (ADR-0039,
 * composer surface).
 *
 * The composer's `!` mode used to be a `textarea` that showed the typed line
 * back to you and ran it. This layer adds the three things a shell prompt has
 * and it did not: completion, validation, and an honest answer about whether
 * the command can run at all on the client you are using.
 *
 * Everything here is renderer-pure — no React, no Tauri, no `textarea` — so the
 * ranking, the commitment rules, and the argv construction are unit-testable
 * without rendering a composer.
 */

import type { ShellKind } from "@/lib/terminal/shell-detect"

/**
 * The shell the `!` line will actually run under, already resolved against the
 * selected Host.
 *
 * Carries `path` AND `kind` because both are load-bearing and neither derives
 * the other reliably: the host spawns `path`, while `kind` picks the argv form
 * and the builtin list — and a host-reported family (`/bin/ash` → `sh`) is a
 * better answer than re-classifying the path here would be.
 */
export interface ResolvedShell {
  /** Spawnable path or PATH-resolvable name (`/bin/zsh`, `pwsh.exe`). */
  path: string
  /** Shell family, in the `ShellKind` vocabulary. */
  kind: ShellKind
  /**
   * Where the choice came from. Surfaced so the "shell unavailable" message can
   * say whether the user picked this shell or inherited it.
   */
  source: "setting" | "host-default" | "platform-default"
}

/**
 * What the client can do with a shell line right now.
 *
 *  - `"full"` — a Host is reachable: filesystem and `$PATH` completion work,
 *    and the command can run.
 *  - `"static-only"` — no Host: builtins and the in-repo CLI specs still
 *    complete (they are static data), but nothing can be inspected or run.
 *  - `"shell-unavailable"` — a Host is there, but the configured shell is not
 *    on it. Completion still works; execution is refused rather than silently
 *    retargeted at a different shell.
 */
export type ShellAvailability = "full" | "static-only" | "shell-unavailable"

/** One completion request — everything a provider needs, and nothing more. */
export interface ShellIntelligenceRequest {
  /** The shell line (the `!` already stripped). */
  line: string
  /** Cursor offset within `line`. */
  cursor: number
  /** Effective working directory the line will run in. */
  cwd: string
  shell: ResolvedShell
  availability: ShellAvailability
}

/** One completion candidate. */
export interface ShellCompletion {
  /** What the list shows. */
  label: string
  /** What acceptance writes over `[from, to)`. */
  insertText: string
  /** Inclusive start of the replaced span, in `line` coordinates. */
  from: number
  /** Exclusive end of the replaced span. */
  to: number
  kind: "command" | "builtin" | "path" | "directory" | "option" | "argument"
  /** Short secondary text (a spec description, `dir`, the owning CLI). */
  detail?: string
  /**
   * True when accepting should immediately ask for the next segment — set on
   * directories, so `./sr` → `./src/` keeps completing inside `src/`.
   */
  continues?: boolean
}

/** One advisory problem with the line. Never blocks execution. */
export interface ShellDiagnostic {
  /** Inclusive start of the underlined span. */
  from: number
  /** Exclusive end. */
  to: number
  severity: "warning" | "error"
  code: "command-not-found" | "incomplete-syntax" | "shell-unavailable"
  /** Already-translated, user-facing text. */
  message: string
}

/** Ranking weight by candidate kind — semantic answers before raw filesystem. */
export const COMPLETION_KIND_PRIORITY: Record<ShellCompletion["kind"], number> = {
  builtin: 5,
  command: 4,
  option: 3,
  argument: 2,
  directory: 1,
  path: 0,
}

/** Hard cap on candidates handed to the UI. */
export const MAX_COMPLETIONS = 50

/** Debounce before a completion query, ms. */
export const COMPLETION_DEBOUNCE_MS = 80

/**
 * Idle delay before an uncommitted head word is called unknown.
 *
 * A command is "committed" the moment whitespace, an operator, or Enter says
 * the user is done typing it. Short of that, `k` on the way to `kubectl` must
 * not be underlined — so an uncommitted word is only judged after the user
 * stops typing.
 */
export const DIAGNOSTIC_IDLE_MS = 200

/** Below this length an uncommitted word is never called unknown. */
export const DIAGNOSTIC_MIN_LENGTH = 2
