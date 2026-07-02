/**
 * Dynamic terminal title (the window / tab caption) reflecting the TUI's live
 * state. A glance at the tab tells you whether the agent is working, waiting on
 * you, or idle — without the window in focus.
 *
 * Terminal-type adaptation is the whole point of this module:
 *   • OSC 0 (`ESC ] 0 ; <text> BEL`) sets BOTH the icon name and the window
 *     title and is the single most widely honored form — xterm, iTerm2, GNOME
 *     Terminal, Konsole, Alacritty, kitty, WezTerm, ConEmu, and Windows Terminal
 *     all obey it. The BEL terminator is honored more broadly across legacy
 *     terminals than the ST (`ESC \`) form, so it is the default.
 *   • Inside a terminal multiplexer (tmux / GNU screen) the OSC is intercepted by
 *     the multiplexer, so we ALSO emit the screen window-rename sequence
 *     (`ESC k <name> ESC \`). With `set-titles on` the multiplexer then derives
 *     the outer terminal's real title from that window name.
 *   • A `dumb` terminal (`TERM=dumb`) and any non-TTY stream (piped stdout in CI)
 *     get nothing — they can't honor the escape.
 *
 * Every writer takes an injectable sink + env so the lifecycle is unit-testable
 * without a real terminal, and is idempotent at the terminal level (writing the
 * same title twice is harmless).
 */

/** Control bytes used to frame the title-setting escape sequences. */
const ESC = "\x1b"
const BEL = "\x07"
const ST = `${ESC}\\`

/** Hard cap on the emitted title length. Terminals truncate long titles anyway,
 * and an unbounded string (e.g. a deep cwd) just wastes bytes every keystroke. */
export const MAX_TITLE_LEN = 256

/** A stdout-like sink we can write escapes to and check for TTY-ness. Mirrors
 * `screen.ScreenStream` so callers can pass the same Ink stdout. */
export interface TitleStream {
  isTTY?: boolean
  write: (data: string) => unknown
}

/** The slice of `process.env` that steers terminal-type adaptation. The index
 * signature lets `process.env` (a `ProcessEnv`) be passed directly as the env. */
export interface TitleEnv {
  TERM?: string | undefined
  TMUX?: string | undefined
  STY?: string | undefined
  [key: string]: string | undefined
}

/**
 * Live state snapshot the title reflects. Kept deliberately tiny (and decoupled
 * from `TuiState`) so {@link computeTitle} is a pure, trivially-tested function.
 */
export interface TitlePhase {
  /** A chat turn is streaming / aborting. */
  busy: boolean
  /** Blocked on the user — a permission prompt or `ask_user` elicitation is open. */
  awaitingInput: boolean
  /** Background runtime activity kind (goal / workflow / agent / team / loop),
   * when one is running outside the normal turn. */
  activity?: string | undefined
  /** Working-directory basename — the project the session is anchored to. */
  dir?: string | undefined
  /** Branding label. Absent ⇒ `"cognia"`. */
  app?: string | undefined
}

/**
 * Render the {@link TitlePhase} to a title string. Pure ASCII by design: some
 * terminals draw the title bar in a system font with poor Unicode coverage, so a
 * status word in brackets is more robust across terminal types than a glyph. The
 * `dir` is user-supplied and may contain non-ASCII (a Chinese folder name) — that
 * is unavoidable and rendered as-is for terminals that support it.
 */
export function computeTitle(phase: TitlePhase): string {
  const app = (phase.app ?? "cognia").trim() || "cognia"
  const dir = phase.dir?.trim()
  const suffix = dir ? ` - ${dir}` : ""
  let lead = app
  if (phase.awaitingInput) lead = `${app} [needs input]`
  else if (phase.busy) lead = `${app} [working]`
  else if (phase.activity && phase.activity.trim()) lead = `${app} [${phase.activity.trim()}]`
  return `${lead}${suffix}`
}

/**
 * Strip anything that would terminate or corrupt the OSC string (control chars
 * incl. ESC/BEL, newlines), collapse runs of whitespace, and cap the length.
 * Exported for reuse by other OSC emitters (e.g. desktop notifications).
 */
export function sanitize(text: string): string {
  const cleaned = text
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned.length > MAX_TITLE_LEN ? cleaned.slice(0, MAX_TITLE_LEN) : cleaned
}

/** True when running inside tmux or GNU screen (which intercept OSC titles). */
function inMultiplexer(env: TitleEnv): boolean {
  const term = env.TERM ?? ""
  return (
    Boolean(env.TMUX) || Boolean(env.STY) || term.startsWith("tmux") || term.startsWith("screen")
  )
}

/**
 * Build the raw escape sequence that sets the terminal title to `title`, adapted
 * to the terminal type implied by `env`. See the module header for the rationale.
 */
export function buildTitleSequence(title: string, env: TitleEnv = process.env): string {
  const t = sanitize(title)
  // OSC 0 sets both the icon name and the window title — the broadest-coverage form.
  const osc = `${ESC}]0;${t}${BEL}`
  if (inMultiplexer(env)) {
    // Also rename the multiplexer window so the caption tracks state even when
    // the multiplexer swallows the OSC; `set-titles on` then propagates it out.
    return `${ESC}k${t}${ST}${osc}`
  }
  return osc
}

/** Whether `out`/`env` can honor a title escape at all. */
function titleCapable(out: TitleStream, env: TitleEnv): boolean {
  return Boolean(out.isTTY) && (env.TERM ?? "") !== "dumb"
}

/**
 * Write the title for `title` to the terminal. No-op on a non-TTY / dumb terminal.
 */
export function applyTerminalTitle(
  title: string,
  out: TitleStream = process.stdout,
  env: TitleEnv = process.env
): void {
  if (!titleCapable(out, env)) return
  out.write(buildTitleSequence(title, env))
}

/**
 * Restore the terminal's default title on exit by clearing it — the shell's
 * prompt (or the terminal itself) then re-establishes its own caption. No-op on
 * a non-TTY / dumb terminal.
 */
export function resetTerminalTitle(
  out: TitleStream = process.stdout,
  env: TitleEnv = process.env
): void {
  if (!titleCapable(out, env)) return
  out.write(buildTitleSequence("", env))
}
