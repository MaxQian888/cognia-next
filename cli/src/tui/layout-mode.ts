/**
 * Resolve the EFFECTIVE TUI layout from the configured preference plus terminal
 * capability.
 *
 * The fixed-region "fullscreen" layout takes over the terminal's alternate
 * screen buffer and manages its own scroll viewport. That only works on an
 * interactive TTY: a piped stdout (CI, `cognia-agent … | tee`), a non-TTY stdin,
 * or a `TERM=dumb` terminal can't honor the escape sequences or report a size,
 * so we transparently fall back to the historic `<Static>` / native-scrollback
 * model. Keeping this a pure function (no `process` reads) lets it unit-test and
 * lets the App inject the capability snapshot for the fixed-layout tests.
 */
import type { LayoutMode } from "../config/schema"

/** The terminal capabilities that gate the fullscreen layout. */
export interface LayoutCapability {
  /** Is stdout an interactive terminal? (`process.stdout.isTTY`) */
  stdoutIsTTY: boolean
  /** Is stdin an interactive terminal? (`process.stdin.isTTY`) */
  stdinIsTTY: boolean
  /** The `TERM` env value, if any — `"dumb"` disables fullscreen. */
  term?: string
}

/** The default layout when the user hasn't configured one. */
export const DEFAULT_LAYOUT: LayoutMode = "fullscreen"

/**
 * Resolve the effective layout. `configured` is `config.layout` (may be
 * undefined ⇒ {@link DEFAULT_LAYOUT}); the result is forced to `"scrollback"`
 * whenever the terminal can't support the alternate-screen fullscreen layout.
 */
export function resolveLayoutMode(
  configured: LayoutMode | undefined,
  cap: LayoutCapability
): LayoutMode {
  const want: LayoutMode = configured ?? DEFAULT_LAYOUT
  if (want === "scrollback") return "scrollback"
  // Fullscreen requested — only honor it on a fully interactive, non-dumb TTY.
  if (!cap.stdoutIsTTY || !cap.stdinIsTTY) return "scrollback"
  if ((cap.term ?? "").toLowerCase() === "dumb") return "scrollback"
  return "fullscreen"
}

/** The slice of `process` {@link readLayoutCapability} reads — kept structural so
 * tests can pass a plain object without the full `NodeJS.Process` surface. */
export interface LayoutProcessLike {
  stdout: { isTTY?: boolean }
  stdin: { isTTY?: boolean }
  env: { TERM?: string }
}

/** Read the live terminal capability from the process (the production source). */
export function readLayoutCapability(
  proc: LayoutProcessLike = process as unknown as LayoutProcessLike
): LayoutCapability {
  return {
    stdoutIsTTY: Boolean(proc.stdout.isTTY),
    stdinIsTTY: Boolean(proc.stdin.isTTY),
    term: proc.env.TERM,
  }
}
