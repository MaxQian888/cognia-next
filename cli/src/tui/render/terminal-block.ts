import { stringWidth } from "../markdown/width"

export type TerminalStyle = "plain" | "muted" | "accent" | "success" | "warning" | "danger" | "code"

export interface TerminalSpan {
  text: string
  style: TerminalStyle
  /** An explicit colour that wins over `style`, for runs whose colour comes from
   * a syntax highlighter rather than from the theme's semantic tokens. */
  color?: string
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

/**
 * Hard-wrap a styled run at exact terminal-cell boundaries, preserving each
 * span's style across the wrap. The same grapheme accounting as
 * {@link wrapTerminalText}, but a physical row can now carry several styles, so
 * a tool header can tint its status glyph, its name and its result chip
 * differently while the row-count math stays identical.
 *
 * Newlines inside a span's text break the row exactly as they do in plain text.
 * Adjacent graphemes sharing a style are re-joined into one span, so a row is
 * never fragmented per character.
 */
export function wrapTerminalSpans(spans: TerminalSpan[], width: number): TerminalLine[] {
  const columns = Math.max(1, Math.floor(width))
  const lines: TerminalLine[] = []
  let current: TerminalSpan[] = []
  let used = 0

  const push = () => {
    lines.push({ spans: current, plain: current.map((span) => span.text).join("") })
    current = []
    used = 0
  }
  const append = (grapheme: string, source: TerminalSpan) => {
    const last = current[current.length - 1]
    if (last && sameStyle(last, source)) last.text += grapheme
    else current.push({ ...source, text: grapheme })
  }

  for (const span of spans) {
    const text = sanitizeTerminalText(span.text)
    const physicals = text.split("\n")
    physicals.forEach((physical, index) => {
      if (index > 0) push()
      for (const grapheme of graphemes(physical)) {
        const cellWidth = graphemeWidth(grapheme)
        if (used > 0 && used + cellWidth > columns) push()
        append(grapheme, span)
        used += cellWidth
      }
    })
  }
  push()
  return lines
}

/** Two spans render identically when their style and text decorations match. */
function sameStyle(a: TerminalSpan, b: TerminalSpan): boolean {
  return (
    a.style === b.style &&
    a.color === b.color &&
    Boolean(a.bold) === Boolean(b.bold) &&
    Boolean(a.italic) === Boolean(b.italic) &&
    Boolean(a.underline) === Boolean(b.underline)
  )
}

/**
 * Build a block from either a single-styled `text` or a styled `spans` run.
 * `spans` is the richer form used by the transcript cells that carry more than
 * one colour (a tool header, a diff body, a bash cell); `text` stays for the
 * cells that genuinely are one colour end to end.
 */
export function buildTerminalBlock(options: {
  id: string
  text?: string
  spans?: TerminalSpan[]
  width: number
  style?: TerminalStyle
  target?: string
}): TerminalBlock {
  const style = options.style ?? "plain"
  const source: TerminalSpan[] = options.spans ?? [{ text: options.text ?? "", style }]
  const plainText = source.map((span) => sanitizeTerminalText(span.text)).join("")
  const lines = wrapTerminalSpans(source, options.width)
  return {
    id: options.id,
    lines,
    plainText,
    rowCount: lines.length,
    ...(options.target ? { target: options.target } : {}),
  }
}
