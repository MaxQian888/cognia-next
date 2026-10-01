/**
 * Declared mentions in an issue comment — ADR-0207 §2.
 *
 * The person picker inserts `@Display Name` into the text and records the id
 * it stands for. What is SENT is the id list, never a parse of the text:
 * display names are not unique, and guessing wrong notifies the wrong person.
 * The text only decides whether a recorded id is still meant, so deleting the
 * inserted name drops the mention, which is what someone editing their own
 * comment expects.
 *
 * Pure functions; the composer owns the state.
 */

export interface DeclaredMention {
  userId: string
  displayName: string
}

/** The server's ceiling on mentions per comment. */
export const MAX_COMMENT_MENTIONS = 50

const WORD_CHAR = /[\p{L}\p{N}_]/u

export function mentionToken(displayName: string): string {
  return `@${displayName}`
}

/**
 * Whether `@displayName` still stands on its own in `body`. Bounded on both
 * sides, so `@Ada` is not found inside `@Adam` and `ops@Ada` (an address) does
 * not count as a mention.
 */
export function containsMentionToken(body: string, displayName: string): boolean {
  const token = mentionToken(displayName)
  let from = 0
  for (;;) {
    const at = body.indexOf(token, from)
    if (at < 0) return false
    const before = at > 0 ? body[at - 1] : ""
    const after = body[at + token.length] ?? ""
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true
    from = at + 1
  }
}

/**
 * The ids to send: recorded mentions whose token survives in the text, each
 * once, in the order they were picked, capped at the server's limit.
 */
export function declaredMentionIds(body: string, recorded: readonly DeclaredMention[]): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const mention of recorded) {
    if (seen.has(mention.userId)) continue
    if (!containsMentionToken(body, mention.displayName)) continue
    seen.add(mention.userId)
    ids.push(mention.userId)
    if (ids.length >= MAX_COMMENT_MENTIONS) break
  }
  return ids
}

/**
 * Replace `body[start, end)` with `@displayName ` and say where the caret
 * goes. `start..end` is the selection when the picker was opened from its
 * button, or the typed `@` when it was opened by typing one. A space is added
 * before the token when it would otherwise run into the previous word.
 */
export function insertMention(
  body: string,
  range: { start: number; end: number },
  displayName: string
): { body: string; caret: number } {
  const start = Math.max(0, Math.min(range.start, body.length))
  const end = Math.max(start, Math.min(range.end, body.length))
  const before = body.slice(0, start)
  const after = body.slice(end)
  const lead = before.length > 0 && !/\s$/.test(before) ? " " : ""
  const trail = /^\s/.test(after) ? "" : " "
  const inserted = `${lead}${mentionToken(displayName)}${trail}`
  const caret = before.length + inserted.length + (trail ? 0 : 1)
  return { body: `${before}${inserted}${after}`, caret }
}

/**
 * Whether a change to the textarea was the person typing an `@` that should
 * open the picker: one character added, it is `@`, and it starts a word.
 */
export function typedMentionTrigger(previous: string, next: string, caret: number): number | null {
  if (next.length !== previous.length + 1 || caret < 1) return null
  if (next[caret - 1] !== "@") return null
  const before = caret >= 2 ? next[caret - 2] : ""
  if (before && !/\s/.test(before)) return null
  return caret - 1
}
