import type { AnsiSegment, ParsedError } from "../types"

// ANSI SGR foreground colour code → Tailwind text colour. Backgrounds and
// 256/truecolour are intentionally not mapped (just stripped) — terminal error
// output is dominated by the standard 8/16 foreground palette.
const FG: Record<number, string> = {
  30: "text-foreground/60",
  31: "text-red-500",
  32: "text-green-500",
  33: "text-yellow-500",
  34: "text-blue-500",
  35: "text-fuchsia-500",
  36: "text-cyan-500",
  37: "text-foreground",
  90: "text-foreground/50",
  91: "text-red-400",
  92: "text-green-400",
  93: "text-yellow-400",
  94: "text-blue-400",
  95: "text-fuchsia-400",
  96: "text-cyan-400",
  97: "text-foreground",
}

// The ESC byte (0x1b) built at runtime so no control char sits in the source
// (keeps eslint's no-control-regex quiet without inline disables).
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
// CSI: ESC [ <params> <final-byte>. SGR uses final byte `m`; other finals
// (cursor moves, erases) are matched so we can strip them too.
const CSI_RE = new RegExp(`${ESC}\\[([0-9;]*)([A-Za-z])`, "g")
// OSC (e.g. window title): ESC ] … terminated by BEL or ST. Stripped wholesale.
const OSC_RE = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g")
const HAS_CSI = new RegExp(`${ESC}\\[`)

/**
 * Parse ANSI-coloured terminal output into a single `ansi` node whose
 * `segments` carry the (stripped) text plus a Tailwind colour class per run.
 * Returns `null` when the text contains no CSI escape — so non-ANSI errors fall
 * through to the other parsers untouched. Unmappable styles (backgrounds,
 * 256/truecolour, cursor moves) are stripped so nothing leaks as raw escapes.
 */
export const ansiParser = {
  name: "ansi",

  parse(text: string): ParsedError | null {
    if (!HAS_CSI.test(text)) return null

    const cleaned = text.replace(OSC_RE, "")
    const segments: AnsiSegment[] = []
    let fg: string | undefined
    let bold = false
    let lastIndex = 0

    const pushRun = (str: string) => {
      if (!str) return
      const className = [fg, bold ? "font-bold" : null].filter(Boolean).join(" ") || undefined
      const prev = segments[segments.length - 1]
      // Merge adjacent runs that share a style to keep the node compact.
      if (prev && prev.className === className) {
        prev.text += str
      } else {
        segments.push({ text: str, className })
      }
    }

    const applySgr = (params: number[]): void => {
      let i = 0
      while (i < params.length) {
        const p = params[i]
        if (p === 38 || p === 48) {
          // Extended colour selector — skip its operands so a 256-index value
          // (e.g. 31) is not misread as a standard colour code.
          if (params[i + 1] === 5) i += 3
          else if (params[i + 1] === 2) i += 5
          else i += 1
          continue
        }
        if (p === 0) {
          fg = undefined
          bold = false
        } else if (p === 1) {
          bold = true
        } else if (p === 22) {
          bold = false
        } else if (p === 39) {
          fg = undefined
        } else if (FG[p]) {
          fg = FG[p]
        }
        i += 1
      }
    }

    CSI_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = CSI_RE.exec(cleaned)) !== null) {
      pushRun(cleaned.slice(lastIndex, m.index))
      lastIndex = m.index + m[0].length
      if (m[2] === "m") {
        const params = m[1] === "" ? [0] : m[1].split(";").map(Number)
        applySgr(params)
      }
      // Non-SGR CSI (cursor / erase) is simply stripped.
    }
    pushRun(cleaned.slice(lastIndex))

    if (segments.length === 0) return null
    return {
      nodes: [{ kind: "ansi", content: segments.map((s) => s.text).join(""), segments }],
      parsed: true,
    }
  },
}
