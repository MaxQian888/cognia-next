import { stringWidth } from "../markdown/width"

export type TerminalStyle = "plain" | "muted" | "accent" | "success" | "warning" | "danger" | "code"

export interface TerminalSpan {
  text: string
  style: TerminalStyle
  bold?: boolean
  italic?: boolean
  underline?: boolean
}

export interface TerminalLine {
  spans: TerminalSpan[]
  plain: string
}

/** Width-dependent, renderer-independent transcript unit. */
export interface TerminalBlock {
  id: string
  lines: TerminalLine[]
  plainText: string
  rowCount: number
  target?: string
}

const OSC = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g
const STRING_ESCAPE = /\u001b[P_^][\s\S]*?(?:\u0007|\u001b\\)/g
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
const ESCAPE = /\u001b(?:[@-_]|[ -/]+[@-~])/g
const C0 = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g

/** Remove every terminal control sequence from untrusted model/tool text. */
export function sanitizeTerminalText(text: string): string {
  return text
    .replace(OSC, "")
    .replace(STRING_ESCAPE, "")
    .replace(CSI, "")
    .replace(ESCAPE, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(C0, "")
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (item) => item.segment)
}

function graphemeWidth(grapheme: string): number {
  if (
    grapheme.includes("\u200d") ||
    grapheme.includes("\ufe0f") ||
    (/\p{Extended_Pictographic}/u.test(grapheme) && Array.from(grapheme).length > 1) ||
    /^\p{Regional_Indicator}{2}$/u.test(grapheme)
  ) {
    return 2
  }
  return stringWidth(grapheme)
}

/** Display width after control sequences are removed, measured by grapheme. */
export function terminalStringWidth(text: string): number {
  return graphemes(sanitizeTerminalText(text)).reduce(
    (width, item) => width + graphemeWidth(item),
    0
  )
}

/** Hard-wrap sanitized text at exact terminal-cell boundaries. */
export function wrapTerminalText(text: string, width: number): string[] {
  const columns = Math.max(1, Math.floor(width))
  const source = sanitizeTerminalText(text)
  const output: string[] = []
  for (const physical of source.split("\n")) {
    let line = ""
    let used = 0
    for (const grapheme of graphemes(physical)) {
      const cellWidth = graphemeWidth(grapheme)
      if (line && used + cellWidth > columns) {
        output.push(line)
        line = ""
        used = 0
      }
      // A single unusual grapheme wider than the viewport still occupies one
      // physical row; never emit a phantom empty row before it.
      line += grapheme
      used += cellWidth
    }
    output.push(line)
  }
  return output.length > 0 ? output : [""]
}

export function buildTerminalBlock(options: {
  id: string
  text: string
  width: number
  style?: TerminalStyle
  target?: string
}): TerminalBlock {
  const plainText = sanitizeTerminalText(options.text)
  const style = options.style ?? "plain"
  const lines = wrapTerminalText(plainText, options.width).map((plain) => ({
    plain,
    spans: [{ text: plain, style }],
  }))
  return {
    id: options.id,
    lines,
    plainText,
    rowCount: lines.length,
    ...(options.target ? { target: options.target } : {}),
  }
}
