// Transcript normalization for the optical renderer — the `snapcompact.ts`
// responsibilities the reference keeps on the TypeScript side: turn a message
// list into pre-normalized text with the renderer's control codes woven in.
//
//  - Tool output is wrapped in dim spans (U+000E/F) so archived tool noise reads
//    quieter than the archived dialogue.
//  - Newline runs fold to FULL BLOCK (U+2588) in grid mode so line structure
//    survives whitespace collapse at one cell each; doc mode keeps '\n' as the
//    column line separator.
//  - A coverage figure reports how much of the text the chosen bitmap font can
//    actually draw, so the orchestrator can route CJK-heavy text to the
//    text-summary fallback instead of rendering blanks (ADR-0063).

import { DIM_ON, DIM_OFF, FULL_BLOCK } from "./constants.mjs"
import { resolveFont, fontSupports } from "./fonts.mjs"

const DIM_ON_CH = String.fromCharCode(DIM_ON)
const DIM_OFF_CH = String.fromCharCode(DIM_OFF)
const FULL_BLOCK_CH = String.fromCodePoint(FULL_BLOCK)

/** Extract plain text from one message's `content` (string | parts array). */
export function extractMessageText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const out = []
  for (const part of content) {
    if (typeof part === "string") out.push(part)
    else if (part && typeof part.text === "string") out.push(part.text)
    else if (part && typeof part === "object") {
      const body = part.output ?? part.result ?? part.content ?? part.value
      if (typeof body === "string") out.push(body)
      else if (Array.isArray(body)) out.push(body.map((b) => b?.text ?? "").join(""))
      else if (body != null) {
        try {
          out.push(JSON.stringify(body))
        } catch {
          /* skip unserializable */
        }
      }
    }
  }
  return out.join("")
}

/** True when a message is tool output (its body should read dim). */
function isToolMessage(m) {
  if (!m) return false
  if (m.role === "tool") return true
  if (Array.isArray(m.content)) {
    return m.content.some(
      (p) => p && typeof p === "object" && /tool-result|tool_result/.test(String(p.type ?? ""))
    )
  }
  return false
}

/**
 * Normalize a message list into optical-render-ready text.
 * @param {Array<{role:string, content:any}>} messages
 * @param {{ fontName?:string, columns?:number, dimToolOutput?:boolean, replacement?:string }} [opts]
 * @returns {{ text:string, coverage:number, charCount:number, renderableCount:number }}
 */
export function normalizeForOptical(messages, opts = {}) {
  const { fontName = "8x8", columns = 1, dimToolOutput = true, replacement = "?" } = opts
  const doc = columns === 2
  const font = resolveFont(fontName)
  if (!font) throw new Error(`Unknown optical font ${JSON.stringify(fontName)}`)

  const blocks = []
  for (const m of messages ?? []) {
    const role = typeof m?.role === "string" ? m.role : "?"
    let body = extractMessageText(m?.content).trim()
    if (!body) continue
    if (dimToolOutput && isToolMessage(m)) body = `${DIM_ON_CH}${body}${DIM_OFF_CH}`
    blocks.push(`${role}: ${body}`)
  }
  let text = blocks.join("\n")

  // Whitespace: collapse intra-line runs; fold blank-line runs to one break.
  text = text.replace(/[ \t\f\v\r]+/g, " ").replace(/\n{2,}/g, "\n")
  // Grid mode folds every newline to a full-block cell; doc keeps '\n'.
  text = doc ? text : text.replace(/\n+/g, FULL_BLOCK_CH)

  // Coverage + replacement of un-renderable code points. Control codes, spaces,
  // and the layout markers do not count toward coverage.
  let total = 0
  let renderable = 0
  let out = ""
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    const isMarker = cp === DIM_ON || cp === DIM_OFF || cp === FULL_BLOCK || cp === 0x0a
    if (isMarker || cp === 0x20) {
      out += ch
      continue
    }
    total += 1
    if (fontSupports(font, cp)) {
      renderable += 1
      out += ch
    } else {
      out += replacement
    }
  }
  const coverage = total === 0 ? 1 : renderable / total
  return { text: out, coverage, charCount: total, renderableCount: renderable }
}
