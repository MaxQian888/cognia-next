/**
 * Telegram MarkdownV2 escaping utilities.
 *
 * Per https://core.telegram.org/bots/api#markdownv2-style the following
 * characters must be escaped with a preceding backslash:
 *   _ * [ ] ( ) ~ ` > # + - = | { } . !
 */

/** The 14 special characters that must be escaped in MarkdownV2. */
const MDV2_SPECIAL_RE = /[_*[\]()~`>#+=|{}.!-]/g

/**
 * Escape MarkdownV2 special chars per
 * https://core.telegram.org/bots/api#markdownv2-style
 */
export function escapeMdV2(text: string): string {
  return text.replace(MDV2_SPECIAL_RE, "\\$&")
}
