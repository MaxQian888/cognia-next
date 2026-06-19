/**
 * Terminal inline-image capability detection and escape-sequence builders.
 *
 * Two widely-supported protocols are covered:
 *  - iTerm2's proprietary inline-image sequence (also implemented by WezTerm).
 *  - the kitty graphics protocol (APC-wrapped, also supported by some others).
 *
 * This module is the pure core: it only detects capability and produces the
 * raw escape strings. Writing them to a stream and the React rendering layer
 * live elsewhere.
 */

/** Supported inline-image transport protocols, or "none" when unavailable. */
export type GraphicsProtocol = "iterm2" | "kitty" | "none"

/**
 * Detect which inline-image protocol the current terminal supports.
 *
 * Detection order (kitty wins when both are signalled, because kitty's
 * protocol is richer and its terminals do not implement the iTerm2 one):
 *  1. kitty — `TERM` contains "kitty", or `KITTY_WINDOW_ID` is set.
 *  2. iterm2 — `TERM_PROGRAM` is "iTerm.app" or "WezTerm" (case-insensitive).
 *  3. none — anything else.
 *
 * @param env Environment to inspect (e.g. `process.env`).
 * @returns The detected protocol.
 */
export function detectGraphics(env: Record<string, string | undefined>): GraphicsProtocol {
  const term = env.TERM ?? ""
  if (term.toLowerCase().includes("kitty") || env.KITTY_WINDOW_ID) {
    return "kitty"
  }

  const program = (env.TERM_PROGRAM ?? "").toLowerCase()
  if (program === "iterm.app" || program === "wezterm") {
    return "iterm2"
  }

  return "none"
}

/** Optional cell-based sizing for the iTerm2 inline-image sequence. */
export interface Iterm2EscapeOptions {
  /** Width spec (e.g. "40" cells, "100px", or "50%"). */
  width?: string
  /** Height spec (e.g. "20" cells, "100px", or "50%"). */
  height?: string
}

/**
 * Build an iTerm2 inline-image escape sequence.
 *
 * Format: `\x1b]1337;File=name=<b64name>;size=<bytes>;inline=1[;width=..;height=..]:<b64data>\x07`
 *
 * @param data Raw image bytes (e.g. a PNG buffer).
 * @param name File name shown by iTerm2; base64-encoded into the sequence.
 * @param opts Optional `width`/`height` sizing.
 * @returns The complete escape string, terminated by BEL (`\x07`).
 */
export function iterm2Escape(data: Buffer, name: string, opts: Iterm2EscapeOptions = {}): string {
  const b64Name = Buffer.from(name).toString("base64")
  const b64Data = data.toString("base64")

  const args = [`name=${b64Name}`, `size=${data.length}`, "inline=1"]
  if (opts.width !== undefined) args.push(`width=${opts.width}`)
  if (opts.height !== undefined) args.push(`height=${opts.height}`)

  return `\x1b]1337;File=${args.join(";")}:${b64Data}\x07`
}

/**
 * Build a kitty graphics protocol escape sequence (single chunk).
 *
 * Format: `\x1b_Ga=T,f=100,...;<b64data>\x1b\\`
 *  - `a=T` — transmit and immediately display.
 *  - `f=100` — payload is PNG (kitty auto-detects dimensions from the PNG).
 *
 * Caveat — chunking: the kitty protocol requires payloads larger than 4096
 * base64 bytes to be split across multiple APC escapes, with `m=1` on every
 * chunk except the last (`m=0`). This builder emits a single chunk, which is
 * correct only for small images. The chunking variant is intentionally left to
 * the writer layer that consumes this module.
 *
 * @param data Raw PNG bytes.
 * @param name Unused by the wire format (kitty has no name field); accepted for
 *   API symmetry with {@link iterm2Escape} and possible future use.
 * @returns The complete APC escape string, terminated by `\x1b\\` (ST).
 */
export function kittyEscape(data: Buffer, name: string): string {
  void name
  const b64Data = data.toString("base64")
  const controls = "a=T,f=100"
  return `\x1b_G${controls};${b64Data}\x1b\\`
}
