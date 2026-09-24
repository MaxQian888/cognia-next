/**
 * Reveal policy for controls that stay quiet until their row is hovered.
 *
 * Hover is one reveal path among four, never the only one:
 *
 *  - **hover**: the enclosing Tailwind `group` (the row or card) is hovered;
 *  - **focus**: keyboard focus is on the control (or, for a group, anywhere
 *    inside it), so a Tab stop never lands on something invisible;
 *  - **open popup**: a menu or popover opened from the control keeps it shown.
 *    The popup portals out, so the pointer sits over the menu and focus lives
 *    in it, and neither hover nor focus holds. Radix triggers carry
 *    `data-state="open"` for exactly the popup's lifetime;
 *  - **coarse pointer**: a touch device has no hover, so the control is simply
 *    always visible there (this app ships to phones through Capacitor).
 *
 * Only `opacity` is animated. The control is never `invisible`, `hidden`, or
 * `pointer-events-none` while quiet, so it stays in the tab order, in the
 * accessibility tree, and clickable without a prior hover.
 *
 * The same four-way policy was first written for the chat message toolbar
 * (`HOVER_REVEAL_CLASS` in `components/chat/message-renderer.tsx`); these are
 * the shared spellings for every other surface. They are whole literal strings
 * on purpose: Tailwind only generates the variants it can find verbatim in
 * source, so composing them at runtime would silently drop the reveal.
 */

/**
 * Put on a wrapper around one or more quiet controls. The wrapper is revealed
 * when its `group` ancestor is hovered, when focus is anywhere inside it, when
 * a popup trigger inside it is open, and always on a coarse pointer.
 */
export const HOVER_REVEAL_GROUP_CLASS =
  "opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 pointer-coarse:opacity-100"

/**
 * Put on a single quiet control (typically the "⋯" trigger itself). Revealed
 * when its `group` ancestor is hovered, when it has keyboard focus, while the
 * popup it opened is up, and always on a coarse pointer.
 */
export const HOVER_REVEAL_CONTROL_CLASS =
  "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"

/**
 * {@link HOVER_REVEAL_GROUP_CLASS} without its hover path, for a surface whose
 * hover trigger is not the nearest unnamed `group`: a *named* group
 * (`group/row`, `group/folder`, ...), because the row sits inside another
 * `group` whose hover must not reveal it, or a hover that is not 100% opaque.
 *
 * The caller adds its own hover path as a literal next to it (for example
 * `cn(HOVER_REVEAL_GROUP_BASE_CLASS, "group-hover/row:opacity-100")`), so the
 * mouse behaviour stays exactly what it was and focus, open-popup and touch
 * still come from this one spelling.
 */
export const HOVER_REVEAL_GROUP_BASE_CLASS =
  "opacity-0 transition-opacity focus-within:opacity-100 has-[[data-state=open]]:opacity-100 pointer-coarse:opacity-100"

/**
 * {@link HOVER_REVEAL_CONTROL_CLASS} without its hover path; see
 * {@link HOVER_REVEAL_GROUP_BASE_CLASS} for when and how to pair it.
 */
export const HOVER_REVEAL_CONTROL_BASE_CLASS =
  "opacity-0 transition-opacity focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"

/**
 * The variants each policy must carry. Exported so tests can assert a surface
 * has not dropped one of them. The `*Base` lists are the same policies minus
 * the hover path, which a named-group surface asserts separately.
 */
export const HOVER_REVEAL_REQUIRED_VARIANTS = {
  group: [
    "group-hover:opacity-100",
    "focus-within:opacity-100",
    "has-[[data-state=open]]:opacity-100",
    "pointer-coarse:opacity-100",
  ],
  control: [
    "group-hover:opacity-100",
    "focus-visible:opacity-100",
    "data-[state=open]:opacity-100",
    "pointer-coarse:opacity-100",
  ],
  groupBase: [
    "focus-within:opacity-100",
    "has-[[data-state=open]]:opacity-100",
    "pointer-coarse:opacity-100",
  ],
  controlBase: [
    "focus-visible:opacity-100",
    "data-[state=open]:opacity-100",
    "pointer-coarse:opacity-100",
  ],
} as const

/** Classes that would take a quiet control out of reach; never part of a reveal. */
export const HOVER_REVEAL_FORBIDDEN_CLASSES = [
  "invisible",
  "hidden",
  "pointer-events-none",
] as const
