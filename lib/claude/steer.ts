/**
 * Steer-queue helpers.
 *
 * A "steer" is a follow-up the user typed *while a turn was still running*.
 * True mid-turn injection is NOT available through the sidecar — both dispatch
 * paths (anthropic / ai-sdk) serialize input at the turn boundary and the host
 * (`restartReason`) close-and-restarts a session rather than feeding a second
 * prompt into a live turn. So a steer is held client-side and replayed as a
 * fresh turn once the running turn settles, framed so the model reads it as a
 * mid-run aside. This mirrors the CLI's `frameSteer`
 * (`cli/src/tui/runtime/driven-turns.ts`).
 */

/** Prefix that marks a replayed message as a course-correction to the model. */
export const STEER_PREFIX = "By the way (steering): "

/** Wrap one steer message so the model reads it as a course-correction. */
export function frameSteer(text: string): string {
  return STEER_PREFIX + text.trim()
}

/**
 * Join queued steer entries (most-recent last) into one framed prompt. Blank
 * entries are dropped; an all-blank queue collapses to the bare prefix (callers
 * guard against draining an empty queue).
 */
export function frameSteerQueue(entries: readonly string[]): string {
  const joined = entries
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
    .join("\n\n")
  return frameSteer(joined)
}
