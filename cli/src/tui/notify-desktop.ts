/**
 * Desktop notifications via OSC escape sequences — a real "you have a result"
 * popup from the terminal itself, so tabbing away during a long run gets you a
 * native notification (not just the in-terminal BEL, which a muted/unfocused
 * terminal may swallow). This mirrors how Claude Code notifies.
 *
 * Two forms are emitted for the widest coverage; a terminal ignores the one it
 * doesn't understand:
 *   • OSC 9  (`ESC ] 9 ; <text> BEL`) — iTerm2, WezTerm, Ghostty, Windows Terminal.
 *   • OSC 777 (`ESC ] 777 ; notify ; <title> ; <body> ST`) — urxvt / Kitty-style.
 *
 * Inside tmux the OSC would be intercepted, so each sequence is wrapped in the
 * DCS passthrough envelope (`ESC P tmux ; <payload, ESC-doubled> ESC \`) which
 * tmux forwards to the outer terminal (requires `set -g allow-passthrough on`).
 *
 * Pure + injectable (same `TitleStream` / `TitleEnv` contract as
 * `terminal-title.ts`), so it unit-tests without a real terminal and no-ops on a
 * non-TTY / `dumb` terminal.
 */
import { sanitize, type TitleStream, type TitleEnv } from "./terminal-title"

const ESC = "\x1b"
const BEL = "\x07"
const ST = `${ESC}\\`

/** True when running inside tmux (which needs the DCS passthrough envelope). */
function inTmux(env: TitleEnv): boolean {
  return Boolean(env.TMUX) || (env.TERM ?? "").startsWith("tmux")
}

/** Wrap a raw escape sequence in tmux's DCS passthrough envelope. Every ESC in
 * the payload is doubled, per the passthrough contract. */
function wrapTmux(seq: string): string {
  return `${ESC}Ptmux;${seq.replace(/\x1b/g, ESC + ESC)}${ESC}\\`
}

/**
 * Build the raw escape sequence(s) that pop a desktop notification with `title`
 * and optional `body`, adapted to the terminal implied by `env`. Emits both the
 * OSC 9 and OSC 777 forms (tmux-wrapped when applicable).
 */
export function buildNotificationSequence(
  title: string,
  body = "",
  env: TitleEnv = process.env
): string {
  const t = sanitize(title) || "cognia"
  const b = sanitize(body)
  // OSC 9 is a single string; fold the body in with a separator when present.
  const osc9 = `${ESC}]9;${b ? `${t}: ${b}` : t}${BEL}`
  // OSC 777 carries title + body as distinct fields.
  const osc777 = `${ESC}]777;notify;${t};${b}${ST}`
  if (inTmux(env)) return wrapTmux(osc9) + wrapTmux(osc777)
  return osc9 + osc777
}

/** Whether `out`/`env` can honor an escape at all (a real TTY, not `dumb`). */
function escapeCapable(out: TitleStream, env: TitleEnv): boolean {
  return Boolean(out.isTTY) && (env.TERM ?? "") !== "dumb"
}

/**
 * Emit a desktop notification. No-op on a non-TTY / `dumb` terminal (piped
 * stdout in CI, etc.).
 */
export function emitDesktopNotification(
  title: string,
  body = "",
  out: TitleStream = process.stdout,
  env: TitleEnv = process.env
): void {
  if (!escapeCapable(out, env)) return
  out.write(buildNotificationSequence(title, body, env))
}
