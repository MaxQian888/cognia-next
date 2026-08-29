// Single source of truth for the `@mention` boundary rule, shared by the
// composer's live trigger detection (`composer-trigger.ts`) and the segment
// parser that feeds the chip overlay (`parse-segments.ts`). Keeping the rule in
// one place stops the two from drifting — e.g. one of them treating `user@host`
// as a mention while the other doesn't.

/** Whitespace test used by the mention/command boundary checks. */
export function isMentionWhitespace(ch: string): boolean {
  return /\s/.test(ch)
}

/**
 * True when `value[index]` begins a token opened by `char`: it is that
 * character, and its left neighbour is whitespace or the very start of the
 * string.
 *
 * Generalized from the `@` rule because a second trigger character (`^`, for
 * results) has to answer the boundary question identically — and the reason it
 * exists is the reason it must not be reimplemented. For `@` it keeps email
 * addresses (`user@host`) and `path/@thing` from reading as mentions; for `^`
 * it keeps `2^3` and `git rev-parse HEAD^` from opening a picker.
 *
 * It does NOT check what follows — callers decide whether an empty token (a
 * lone `@`) counts.
 */
export function isTriggerStart(value: string, index: number, char: string): boolean {
  if (value[index] !== char) return false
  const prev = index === 0 ? "" : value[index - 1]
  return prev === "" || isMentionWhitespace(prev)
}

/**
 * True when `value[index]` begins an `@mention` token. Thin wrapper over
 * {@link isTriggerStart} so the segment parser and the chip overlay keep
 * calling the same name they always have.
 */
export function isMentionStart(value: string, index: number): boolean {
  return isTriggerStart(value, index, "@")
}

/**
 * Index of the first whitespace in `value` within `[start, hardEnd)`, or
 * `hardEnd` when none — i.e. where a `/`-command or `@`-mention token ends.
 * Shared by `detectTrigger` (composer-trigger.ts) and `parseSegments`
 * (parse-segments.ts) so the token-boundary scan can't drift between them.
 */
export function findTokenEnd(value: string, start: number, hardEnd: number): number {
  for (let i = start; i < hardEnd; i++) {
    if (isMentionWhitespace(value[i])) return i
  }
  return hardEnd
}
