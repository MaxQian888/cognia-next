/**
 * Turn-completion notification — ring the terminal bell when a chat turn finishes
 * (Claude Code parity), so you can tab away during a long run and be alerted when
 * it's done. Most terminals turn a BEL received while unfocused into a visible /
 * audible notification, which is exactly the behavior we want.
 *
 * Pure + injectable (same sink/env contract as `terminal-title.ts`) so the gate
 * and the emit unit-test without a real terminal. Only fires when notifications
 * are enabled AND the turn ran long enough to be worth interrupting for — a
 * sub-second reply shouldn't beep.
 */
import type { TitleEnv, TitleStream } from "./terminal-title"

/** The ASCII bell (BEL, 0x07). */
export const BELL = "\x07"

/** Default minimum turn duration (ms) below which completion is too quick to
 * warrant a notification. */
export const NOTIFY_MIN_MS = 6000

/**
 * Whether a just-finished turn should ring the bell: notifications enabled and
 * the turn took at least `minMs`.
 */
export function shouldNotifyOnDone(
  enabled: boolean,
  elapsedMs: number,
  minMs: number = NOTIFY_MIN_MS
): boolean {
  return enabled && elapsedMs >= minMs
}

/** Whether `out`/`env` can honor a bell at all (a real TTY, not a `dumb` term). */
function bellCapable(out: TitleStream, env: TitleEnv): boolean {
  return Boolean(out.isTTY) && (env.TERM ?? "") !== "dumb"
}

/** Write the bell to the terminal. No-op on a non-TTY / dumb terminal. */
export function emitCompletionBell(
  out: TitleStream = process.stdout,
  env: TitleEnv = process.env
): void {
  if (!bellCapable(out, env)) return
  out.write(BELL)
}
