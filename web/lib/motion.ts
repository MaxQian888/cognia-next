/**
 * The site's shared motion constants.
 *
 * `RevealGroup` used to declare the entrance curve with a comment claiming it
 * was "shared with `Reveal`" while `Reveal` inlined its own identical copy —
 * and `globals.css` repeated the same `cubic-bezier` a third time. A curve that
 * three surfaces have to agree on is a constant, not a comment.
 *
 * The CSS side reads it as the `--ease-entrance` custom property declared in
 * `globals.css`; `EASE_ENTRANCE_CSS` below is the single string both sides are
 * checked against.
 */

/** The entrance curve, as `motion/react` wants it. */
export const EASE_ENTRANCE = [0.22, 0.61, 0.36, 1] as const

/** The same curve as a CSS timing function, for the `--ease-entrance` token. */
export const EASE_ENTRANCE_CSS = `cubic-bezier(${EASE_ENTRANCE.join(", ")})`
