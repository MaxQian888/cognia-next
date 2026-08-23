/**
 * Translator surface a chat title needs: resolve `chatTitle`, and say whether
 * the running message bundle actually has it.
 */
export type ChatTitleTranslator = {
  (key: "chatTitle", values: { name: string }): string
  has: (key: "chatTitle") => boolean
}

/**
 * Title for a newly created one-to-one conversation with a character.
 *
 * The title is *persisted*, so an unresolved message is not a cosmetic glitch
 * here the way it is in a label. next-intl renders a missing key as its full
 * path (`desktop.memberList.chatTitle`) and that string is what gets written to
 * the session row — the conversation stays named after the key long after the
 * build that ships the message. A shell running a static export older than the
 * key (`out/` predating the commit that added it) is exactly how that happens.
 *
 * So ask the bundle first, and name the conversation after the character when
 * the message is missing: a degraded title that reads like a name beats a
 * durable one that reads like a bug.
 */
export function characterChatTitle(t: ChatTitleTranslator, name: string): string {
  return t.has("chatTitle") ? t("chatTitle", { name }) : name
}
