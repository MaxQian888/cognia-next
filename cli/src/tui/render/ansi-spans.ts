/**
 * Parse an already-ANSI-coloured string into styled {@link TerminalSpan}s.
 *
 * The syntax highlighter (`markdown/highlight.ts`, via cli-highlight) and the
 * diff tinter both emit SGR escape sequences, which the Ink card path prints
 * verbatim inside a `<Text>`. The virtualized fullscreen renderer cannot: it
 * measures every row in grapheme cells and sanitizes control sequences out, so
 * an ANSI body reached it as flat, uncoloured text. Converting the escapes into
 * spans up front lets that renderer show the same colours while keeping its
 * width accounting exact.
 *
 * Only foreground colour and the bold / italic / underline attributes are read.
 * Background colour has no place in a transcript row, and anything else in the
 * sequence is dropped rather than guessed at.
 */
import type { TerminalSpan, TerminalStyle } from "./terminal-block"

/** SGR foreground parameter to a colour Ink accepts on `<Text color>`. */
const BASIC_FG: Record<number, string> = {
  30: "black",
  31: "red",
  32: "green",
  33: "yellow",
  34: "blue",
  35: "magenta",
  36: "cyan",
  37: "white",
  90: "gray",
  91: "redBright",
  92: "greenBright",
  93: "yellowBright",
  94: "blueBright",
  95: "magentaBright",
  96: "cyanBright",
  97: "whiteBright",
}

/** The 6-value ramp each channel of the xterm 256-colour cube steps through. */
const CUBE_STEPS = [0, 95, 135, 175, 215, 255]

function hex(r: number, g: number, b: number): string {
  const pair = (v: number) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")
  return `#${pair(r)}${pair(g)}${pair(b)}`
}

/** Resolve an xterm-256 index to a colour Ink accepts. */
export function xterm256Color(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined
  if (index < 16) return BASIC_FG[index < 8 ? 30 + index : 90 + (index - 8)]
  if (index < 232) {
    const n = index - 16
    return hex(
      CUBE_STEPS[Math.floor(n / 36) % 6],
      CUBE_STEPS[Math.floor(n / 6) % 6],
      CUBE_STEPS[n % 6]
    )
  }
  const level = 8 + (index - 232) * 10
  return hex(level, level, level)
}

interface SgrState {
  color?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
}

/** Apply one SGR sequence's parameters to the running state. */
function applySgr(state: SgrState, params: number[]): SgrState {
  let next: SgrState = { ...state }
  for (let i = 0; i < params.length; i++) {
    const code = params[i]
    if (code === 0) next = {}
    else if (code === 1) next.bold = true
    else if (code === 3) next.italic = true
    else if (code === 4) next.underline = true
    else if (code === 22) delete next.bold
    else if (code === 23) delete next.italic
    else if (code === 24) delete next.underline
    else if (code === 39) delete next.color
    else if (BASIC_FG[code]) next.color = BASIC_FG[code]
    else if (code === 38) {
      // Extended foreground: `38;5;<n>` or `38;2;<r>;<g>;<b>`.
      if (params[i + 1] === 5) {
        const resolved = xterm256Color(params[i + 2] ?? -1)
        if (resolved) next.color = resolved
        i += 2
      } else if (params[i + 1] === 2) {
        next.color = hex(params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0)
        i += 4
      }
    }
  }
  return next
}

const SGR = /\u001b\[([0-9;]*)m/g

/**
 * Split an ANSI string into spans. Text outside any colour sequence carries
 * `fallbackStyle`. A coloured run carries an explicit `color`, which the
 * renderer prefers over the style token. The text emitted here is free of the
 * SGR sequences it consumed, so the block builder measures real cells.
 */
export function ansiToSpans(text: string, fallbackStyle: TerminalStyle = "plain"): TerminalSpan[] {
  if (!text) return []
  const out: TerminalSpan[] = []
  let state: SgrState = {}
  let cursor = 0

  const push = (chunk: string) => {
    if (!chunk) return
    out.push({
      text: chunk,
      style: fallbackStyle,
      ...(state.color ? { color: state.color } : {}),
      ...(state.bold ? { bold: true } : {}),
      ...(state.italic ? { italic: true } : {}),
      ...(state.underline ? { underline: true } : {}),
    })
  }

  SGR.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SGR.exec(text))) {
    push(text.slice(cursor, match.index))
    const params = match[1]
      .split(";")
      .filter((p) => p.length > 0)
      .map((p) => Number(p))
    state = applySgr(state, params.length > 0 ? params : [0])
    cursor = match.index + match[0].length
  }
  push(text.slice(cursor))
  return out
}
