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
 * cut. Mirrors the wechat-personal chunkText approach but with soft
 * boundaries so MarkdownV2 entities (which rarely span lines) usually stay
 * intact.
 */
export function chunkTelegramText(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  if (text.length <= limit) return text.length > 0 ? [text] : []
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let cut = window.lastIndexOf("\n")
    if (cut <= 0) cut = window.lastIndexOf(" ")
    const hardCut = cut <= 0
    if (hardCut) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
    // Drop the boundary character the chunk was split on.
    if (!hardCut) rest = rest.slice(1)
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}
