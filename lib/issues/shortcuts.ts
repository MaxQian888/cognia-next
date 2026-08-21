/**
 * Page-scoped keyboard map for the issue surface.
 *
 * Deliberately NOT registered in `lib/shortcuts/app-catalog.ts`: that catalogue
 * is for application-level bindings like the command palette, and every key
 * here (`c`, `j`, `x`, …) is a bare letter that would be hostile as a global.
 * They are live only while `/issues` is mounted and nothing is being typed
 * into.
 *
 * Pure so the "is the user typing?" rule — the part that actually breaks, and
 * breaks silently, by swallowing a keystroke inside a search box — is testable
 * without a DOM event loop.
 *
 * There is deliberately no `e`-for-edit: Enter already opens the inspector,
 * where every property is editable, so a second key to the same destination is
 * a binding that looks like it does something and does not.
 */

export type IssueShortcutAction =
  "create" | "focusSearch" | "next" | "previous" | "open" | "toggleSelect" | "clearSelection"

/** The bare-key bindings, in the order the help text lists them. */
const KEY_MAP: Record<string, IssueShortcutAction> = {
  c: "create",
  "/": "focusSearch",
  j: "next",
  ArrowDown: "next",
  k: "previous",
  ArrowUp: "previous",
  Enter: "open",
  x: "toggleSelect",
  Escape: "clearSelection",
}

/**
 * Shape of the parts of a keyboard event this module reads.
 *
 * `target` is `unknown` rather than `EventTarget` because the check is
 * structural — a real `KeyboardEvent` satisfies it, and so does a plain object
 * in a test, without either having to pretend to implement `addEventListener`.
 */
export interface ShortcutEventLike {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  target?: unknown
  defaultPrevented?: boolean
}

/** Shape of the parts of an event target this module reads. */
interface TargetLike {
  tagName?: string
  isContentEditable?: boolean
  closest?: (selector: string) => unknown
}

/**
 * Is the keystroke going into a text field?
 *
 * Checked by shape rather than `instanceof HTMLElement` so this stays usable
 * from a non-DOM context and from tests that pass a plain object. `closest`
 * catches a focused control INSIDE a Radix dialog or a rich editor, where the
 * event target may be a wrapper rather than the input itself.
 */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false
  const element = target as TargetLike
  const tag = element.tagName?.toLowerCase()
  if (tag === "input" || tag === "textarea" || tag === "select") return true
  if (element.isContentEditable) return true
  return Boolean(element.closest?.('input, textarea, select, [contenteditable="true"]'))
}

/**
 * The action a keystroke means, or null.
 *
 * Any modifier disqualifies the keystroke: `⌘K` is the command palette and
 * `Ctrl+C` is a copy, and neither may be eaten by a single-letter binding.
 * Escape is the exception — it must still clear a selection from inside the
 * search box, which is the one place a user reaches for it most.
 */
export function resolveIssueShortcut(event: ShortcutEventLike): IssueShortcutAction | null {
  if (event.defaultPrevented) return null
  if (event.ctrlKey || event.metaKey || event.altKey) return null

  const action = KEY_MAP[event.key]
  if (!action) return null

  // Shift is reserved for range selection in the list; it never changes which
  // action a key means, but it must not silently fire the unshifted one either.
  if (event.shiftKey && action !== "toggleSelect" && action !== "next" && action !== "previous") {
    return null
  }

  if (action === "clearSelection") return action
  return isTypingTarget(event.target) ? null : action
}
