/**
 * Cross-platform clipboard write for the `/copy` command. Prefers the native
 * clipboard utility (`clip` on Windows, `pbcopy` on macOS, `xclip`/`wl-copy` on
 * Linux), and falls back to an OSC 52 terminal escape so a copy still lands in
 * the *local* clipboard when running over SSH or where no native helper exists.
 * The spawner, env, and tty writer are injected so the platform selection +
 * OSC 52 path unit-test without touching a real clipboard or terminal.
 */
import { spawn as nodeSpawn } from "node:child_process"

import { DEFAULT_OSC52_MAX_BYTES } from "../config/schema"

/** Minimal surface of `child_process.spawn` the writer needs. */
export type Spawn = typeof nodeSpawn

/**
 * Outcome of a clipboard write. Success carries nothing; a failure carries WHY
 * so the caller can surface a precise notice:
 * - `"too-large"` — the only viable path was OSC 52 and the text exceeds the
 *   terminal's drop threshold (see {@link DEFAULT_OSC52_MAX_BYTES}).
 * - `"unavailable"` — no clipboard mechanism worked (no helper, helper failed,
 *   or the OSC 52 writer threw).
 */
export type CopyResult = { ok: true } | { ok: false; reason: "unavailable" | "too-large" }

/** Map a copy failure reason to a user-facing notice string. Pure so the UI
 * mapping unit-tests without React. */
export function clipboardFailureMessage(
  reason: "unavailable" | "too-large",
  notices: { clipboardUnavailable: string; clipboardTooLarge: string }
): string {
  return reason === "too-large" ? notices.clipboardTooLarge : notices.clipboardUnavailable
}

/**
 * How aggressively to use the OSC 52 terminal-clipboard escape:
 * - `"auto"`   — OSC 52 when remote (SSH) or no native helper; otherwise the
 *   native helper, falling back to OSC 52 if it fails.
 * - `"always"` — always OSC 52 (skip the native helper entirely).
 * - `"never"`  — native helper only; no OSC 52 fallback (legacy behavior).
 */
export type Osc52Mode = "auto" | "always" | "never"

/** Pick the clipboard command + args for a platform, or null if unsupported. */
export function clipboardCommand(
  platform: NodeJS.Platform
): { cmd: string; args: string[] } | null {
  if (platform === "win32") return { cmd: "clip", args: [] }
  if (platform === "darwin") return { cmd: "pbcopy", args: [] }
  if (platform === "linux") return { cmd: "xclip", args: ["-selection", "clipboard"] }
  return null
}

/** The OSC 52 escape that asks the terminal to set the system clipboard to `text`. */
export function osc52Sequence(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`
}

/**
 * Wrap an escape so it survives a terminal multiplexer. Inside tmux, OSC escapes
 * only reach the outer terminal through a DCS passthrough with the inner ESCs
 * doubled; outside tmux the sequence is returned unchanged.
 */
export function wrapForMultiplexer(seq: string, env: NodeJS.ProcessEnv): string {
  if (env.TMUX) return `\x1bPtmux;${seq.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`
  return seq
}

/** True when the process looks like it's running inside an SSH session. */
function isRemote(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.SSH_TTY || env.SSH_CONNECTION)
}

/**
 * Write `text` to the clipboard. Resolves `{ ok: true }` on success, or
 * `{ ok: false, reason }` when no mechanism is available, the chosen one fails,
 * or the text is too large for the OSC 52 escape — the caller turns the reason
 * into a user-facing notice (see {@link clipboardFailureMessage}).
 */
export function copyToClipboard(
  text: string,
  opts: {
    platform?: NodeJS.Platform
    spawn?: Spawn
    env?: NodeJS.ProcessEnv
    /** Terminal sink for the OSC 52 escape. Defaults to the process stdout. */
    write?: (data: string) => void
    /** OSC 52 strategy; defaults to `"auto"`. */
    osc52?: Osc52Mode
    /** Max raw UTF-8 bytes allowed through OSC 52; larger copies are skipped as
     * `too-large`. Absent ⇒ {@link DEFAULT_OSC52_MAX_BYTES}; `0` disables. */
    osc52MaxBytes?: number
  } = {}
): Promise<CopyResult> {
  const platform = opts.platform ?? process.platform
  const spawn = opts.spawn ?? nodeSpawn
  const env = opts.env ?? process.env
  const write = opts.write ?? ((data: string) => void process.stdout.write(data))
  const mode: Osc52Mode = opts.osc52 ?? "auto"
  const maxBytes = opts.osc52MaxBytes ?? DEFAULT_OSC52_MAX_BYTES
  const command = clipboardCommand(platform)

  // Many terminals silently DROP an over-long OSC 52 sequence, so a too-large
  // payload is a copy failure, not a no-op success — refuse before emitting.
  const osc52TooLarge = maxBytes > 0 && Buffer.byteLength(text, "utf8") > maxBytes

  const emitOsc52 = (): CopyResult => {
    if (osc52TooLarge) return { ok: false, reason: "too-large" }
    try {
      write(wrapForMultiplexer(osc52Sequence(text), env))
      return { ok: true }
    } catch {
      return { ok: false, reason: "unavailable" }
    }
  }

  if (mode === "always") return Promise.resolve(emitOsc52())

  // Auto: skip the native helper when remote or when none exists for the platform.
  if (mode === "auto" && (isRemote(env) || !command)) return Promise.resolve(emitOsc52())

  // Native-helper path. `never` with no helper is an honest failure; `auto`
  // already handled the no-helper case above.
  if (!command) return Promise.resolve({ ok: false, reason: "unavailable" })

  return new Promise<CopyResult>((resolve) => {
    // A failed helper falls back to OSC 52 in auto mode, else reports failure.
    const onFail = () =>
      resolve(mode === "auto" ? emitOsc52() : { ok: false, reason: "unavailable" })
    try {
      const child = spawn(command.cmd, command.args, { stdio: ["pipe", "ignore", "ignore"] })
      child.on("error", onFail)
      child.on("close", (code) => (code === 0 ? resolve({ ok: true }) : onFail()))
      child.stdin?.end(text)
    } catch {
      onFail()
    }
  })
}
