/**
 * Telegram MarkdownV2 escaping + text-limit utilities.
 *
 * Per https://core.telegram.org/bots/api#markdownv2-style escaping is
 * context-sensitive:
 *   - regular text: `_ * [ ] ( ) ~ ` > # + - = | { } . !` AND the backslash
 *     itself must be escaped with a preceding backslash;
 *   - inside pre / code entities: only ` and \ may be escaped;
 *   - inside the `(...)` part of an inline link / custom-emoji definition:
 *     only ) and \ may be escaped.
 */

/**
 * Specials that must be escaped in regular MarkdownV2 text. The backslash is
 * escaped by the same single-pass replace — every matched character is
 * independently prefixed, so no double-escaping can occur.
 */
const MDV2_SPECIAL_RE = /[\\_*[\]()~`>#+=|{}.!-]/g

/** Inside pre/code entities only ` and \ must be escaped. */
const MDV2_CODE_SPECIAL_RE = /[\\`]/g

/** Inside the (...) of an inline link only ) and \ must be escaped. */
const MDV2_URL_SPECIAL_RE = /[\\)]/g

/**
 * Escape MarkdownV2 special chars in regular text per
 * https://core.telegram.org/bots/api#markdownv2-style
 */
export function escapeMdV2(text: string): string {
  return text.replace(MDV2_SPECIAL_RE, "\\$&")
}

/** Escape text destined for a pre / code entity (``` fences, inline `code`). */
export function escapeMdV2Code(text: string): string {
  return text.replace(MDV2_CODE_SPECIAL_RE, "\\$&")
}

/** Escape a URL destined for the (...) part of an inline link. */
export function escapeMdV2Url(url: string): string {
  return url.replace(MDV2_URL_SPECIAL_RE, "\\$&")
}

/** Telegram sendMessage `text` hard limit (characters). */
export const TELEGRAM_TEXT_LIMIT = 4096
/** Telegram media `caption` hard limit (characters). */
export const TELEGRAM_CAPTION_LIMIT = 1024

/**
 * Split `text` into chunks of at most `limit` characters, preferring to break
 * at the last newline inside the window, then the last space, then a hard
 * cut. Preserve boundary whitespace and never split a UTF-16 surrogate pair.
 * Formatted input must first be decoded into text plus entities.
 */
export function chunkTelegramText(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError("Telegram chunk limit must be a positive integer")
  if (text.length <= limit) return text.length > 0 ? [text] : []
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let cut = window.lastIndexOf("\n")
    if (cut <= 0) cut = window.lastIndexOf(" ")
    cut = cut <= 0 ? limit : cut + 1
    if (/^[\uDC00-\uDFFF]/u.test(rest.slice(cut)) && /[\uD800-\uDBFF]$/u.test(rest.slice(0, cut)))
      cut -= 1
    if (cut === 0) throw new RangeError("Telegram chunk limit cannot fit a Unicode character")
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

export interface TelegramTextEntity {
  type:
    | "bold"
    | "italic"
    | "underline"
    | "strikethrough"
    | "spoiler"
    | "code"
    | "pre"
    | "text_link"
    | "blockquote"
  /** Telegram entity ranges are measured in UTF-16 code units. */
  offset: number
  length: number
  url?: string
  language?: string
}

export interface TelegramEntityText {
  text: string
  entities: TelegramTextEntity[]
}

/** Locate a MarkdownV2 delimiter without matching escaped characters. */
function delimiterAt(source: string, marker: string, start: number): number {
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === "\\") i += 1
    else if (source.startsWith(marker, i)) return i
  }
  throw new Error(`Unclosed Telegram MarkdownV2 delimiter: ${marker}`)
}

/** Decode the MarkdownV2 subset emitted by md-to-mdv2 and the A2UI mapper. */
export function markdownV2Entities(source: string): TelegramEntityText {
  let text = ""
  const entities: TelegramTextEntity[] = []
  const open: Array<{ marker: string; type: TelegramTextEntity["type"]; offset: number }> = []
  const types: Record<string, TelegramTextEntity["type"]> = {
    "*": "bold",
    _: "italic",
    __: "underline",
    "~": "strikethrough",
    "||": "spoiler",
  }
  let quoteStart: number | undefined
  const addEntity = (
    type: TelegramTextEntity["type"],
    offset: number,
    extra: Partial<TelegramTextEntity> = {}
  ) => {
    if (text.length > offset)
      entities.push({ type, offset, length: text.length - offset, ...extra })
  }
  for (let i = 0; i < source.length;) {
    if (source[i] === "\\" && i + 1 < source.length) {
      text += source[i + 1]
      i += 2
      continue
    }
    if (source[i] === ">" && (i === 0 || source[i - 1] === "\n")) {
      quoteStart ??= text.length
      i += 1
      continue
    }
    if (source[i] === "\n" && quoteStart !== undefined && source[i + 1] !== ">") {
      addEntity("blockquote", quoteStart)
      quoteStart = undefined
    }
    if (source[i] === "`") {
      const marker = source.startsWith("```", i) ? "```" : "`"
      const end = delimiterAt(source, marker, i + marker.length)
      let body = source.slice(i + marker.length, end)
      let language: string | undefined
      if (marker === "```") {
        const heading = /^([\w+-]*)\n/.exec(body)
        if (heading) {
          language = heading[1] || undefined
          body = body.slice(heading[0].length)
        }
        // The serializers add one newline to delimit the closing fence.
        if (body.endsWith("\n")) body = body.slice(0, -1)
      }
      const offset = text.length
      text += body.replace(/\\([\\`])/g, "$1")
      addEntity(marker === "```" ? "pre" : "code", offset, language ? { language } : {})
      i = end + marker.length
      continue
    }
    if (source[i] === "[") {
      const labelEnd = delimiterAt(source, "](", i + 1)
      const urlEnd = delimiterAt(source, ")", labelEnd + 2)
      const label = markdownV2Entities(source.slice(i + 1, labelEnd))
      const offset = text.length
      text += label.text
      entities.push(
        ...label.entities.map((entity) => ({ ...entity, offset: entity.offset + offset }))
      )
      addEntity("text_link", offset, {
        url: source.slice(labelEnd + 2, urlEnd).replace(/\\([\\)])/g, "$1"),
      })
      i = urlEnd + 1
      continue
    }
    const marker = source.startsWith("__", i) ? "__" : source.startsWith("||", i) ? "||" : source[i]
    const type = types[marker]
    if (type) {
      const current = open[open.length - 1]
      if (current?.marker === marker) {
        open.pop()
        addEntity(current.type, current.offset)
      } else open.push({ marker, type, offset: text.length })
      i += marker.length
      continue
    }
    text += source[i]
    i += 1
  }
  if (open.length)
    throw new Error(`Unclosed Telegram MarkdownV2 delimiter: ${open[open.length - 1].marker}`)
  if (quoteStart !== undefined) addEntity("blockquote", quoteStart)
  entities.sort(
    (a, b) => a.offset - b.offset || b.length - a.length || a.type.localeCompare(b.type)
  )
  return { text, entities }
}

/**
 * Split rendered text, clipping each entity to its chunk and rebasing offsets.
 * Explicit entities preserve long links/code/emphasis without broken syntax.
 */
export function chunkTelegramMarkdownV2(
  source: string,
  limit = TELEGRAM_TEXT_LIMIT
): TelegramEntityText[] {
  const rendered = markdownV2Entities(source)
  let offset = 0
  return chunkTelegramText(rendered.text, limit).map((text) => {
    const start = offset
    const end = start + text.length
    offset = end
    const entities = rendered.entities.flatMap((entity) => {
      const from = Math.max(entity.offset, start)
      const to = Math.min(entity.offset + entity.length, end)
      return to > from ? [{ ...entity, offset: from - start, length: to - from }] : []
    })
    return { text, entities }
  })
}
