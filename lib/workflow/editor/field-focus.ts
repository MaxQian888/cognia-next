/**
 * Locate and focus one field of the Inspector form — the DOM half of the
 * editor's jump-to-error gestures (Problems-panel row, Inspector error badge).
 *
 * Three things made the old one-shot `querySelector` unreliable, and each has
 * a rule here:
 *
 * 1. The Context Workbench keeps inactive panels mounted behind `<Activity>`
 *    (`display: none`, `inert`, `aria-hidden`). A document-wide lookup such as
 *    `#at-prompt` can land on that hidden copy. Every lookup is therefore
 *    scoped to a root the caller owns, and a control inside an inert /
 *    aria-hidden / invisible ancestor is never treated as focusable.
 * 2. `ExpressionField` builds its CodeMirror view in an effect. Until
 *    `.cm-content` exists the field has nothing to focus, so a field that
 *    contains an expression editor is "not ready" rather than resolved to the
 *    variable-picker button that sits above it.
 * 3. The Inspector may be revealed in the same gesture that asks for the
 *    focus, so the form can still be mounting. `focusFieldWhenReady` retries
 *    once per animation frame, for a bounded number of frames, before falling
 *    back to the closest thing it can show.
 *
 * `Field` (`components/workflow/editor/inspector/forms/shared.tsx`) stamps
 * `data-field="<param>"` and `data-invalid="true"` on its row; those two
 * attributes are the whole contract with the forms.
 */

/** Attribute `ExpressionField` stamps on its root. */
export const EXPRESSION_FIELD_ATTR = "data-expression-field"

/** Frames `focusFieldWhenReady` waits for a field before falling back (~1.5s at 60fps). */
export const FIELD_FOCUS_MAX_FRAMES = 90

/** Controls that take typed input — preferred over any button in the same row. */
const TEXT_ENTRY_SELECTOR = [
  'input:not([type="hidden"]):not([disabled])',
  "textarea:not([disabled])",
  "select:not([disabled])",
  '[contenteditable="true"]',
].join(", ")

/** Picker-style controls (combobox triggers, radio swatches) when there is no text entry. */
const FALLBACK_CONTROL_SELECTOR = [
  '[role="combobox"]:not([disabled])',
  "button:not([disabled])",
  '[role="radio"]',
  '[tabindex]:not([tabindex="-1"])',
].join(", ")

/** CodeMirror's editable surface. */
const CODEMIRROR_CONTENT_SELECTOR = ".cm-content"

/**
 * True when `el` is on screen and reachable: not inside an inert or
 * aria-hidden subtree (the workbench's hidden panels), and — where the engine
 * can say — not under a `display: none` / `visibility: hidden` ancestor.
 */
export function isInteractable(el: Element): boolean {
  if (el.closest('[inert], [aria-hidden="true"]')) return false
  const check = (el as Element & { checkVisibility?: () => boolean }).checkVisibility
  if (typeof check === "function" && !check.call(el)) return false
  return true
}

/**
 * The form row for `field` inside `root`. Matched by comparing
 * `dataset.field` rather than by building a selector, so a param name can
 * never be read as CSS. Falls back to the first invalid row when `field` is
 * null or the form does not render it (object-level `_root` errors).
 */
export function findFieldContainer(root: ParentNode, field: string | null): HTMLElement | null {
  if (field) {
    const byName = Array.from(root.querySelectorAll<HTMLElement>("[data-field]")).find(
      (el) => el.dataset.field === field && isInteractable(el)
    )
    if (byName) return byName
  }
  return listInvalidFieldContainers(root)[0] ?? null
}

/** Every interactable invalid form row, in document order. */
export function listInvalidFieldContainers(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-invalid="true"]')).filter((el) =>
    isInteractable(el)
  )
}

/**
 * The control to focus inside a form row, or `null` while the row is still
 * mounting — an expression editor whose CodeMirror view does not exist yet
 * counts as not mounted.
 */
export function findFieldControl(container: HTMLElement): HTMLElement | null {
  const expression = container.querySelector<HTMLElement>(`[${EXPRESSION_FIELD_ATTR}]`)
  if (expression) {
    const content = expression.querySelector<HTMLElement>(CODEMIRROR_CONTENT_SELECTOR)
    return content && isInteractable(content) ? content : null
  }
  const candidates = [
    ...Array.from(container.querySelectorAll<HTMLElement>(TEXT_ENTRY_SELECTOR)),
    ...Array.from(container.querySelectorAll<HTMLElement>(FALLBACK_CONTROL_SELECTOR)),
  ]
  return candidates.find((el) => isInteractable(el)) ?? null
}

/** Scroll the row into view and move focus to its control. */
export function focusFieldControl(container: HTMLElement, control: HTMLElement): void {
  // `scrollIntoView` is missing in some embedded WebViews; the scroll is a
  // convenience, the focus is the point.
  container.scrollIntoView?.({ block: "center", behavior: "smooth" })
  control.focus({ preventScroll: true })
}

export type FieldFocusOutcome =
  /** The named (or first invalid) field's control now has focus. */
  | "focused"
  /** The row was found but its control never mounted; the row was scrolled to. */
  | "scrolled"
  /** No matching row appeared in time; the form was scrolled to its top. */
  | "fallback"
  /** The caller cancelled before the field settled. */
  | "cancelled"

export interface FocusFieldWhenReadyOptions {
  /** Current form root; re-read every frame so a remounting form is followed. */
  getRoot: () => HTMLElement | null
  field: string | null
  onSettled: (outcome: FieldFocusOutcome) => void
  maxFrames?: number
  /** Injected for tests; default `requestAnimationFrame` / `cancelAnimationFrame`. */
  requestFrame?: (cb: () => void) => number
  cancelFrame?: (handle: number) => void
}

/**
 * Try to focus `field` now, then once per animation frame until its control
 * has mounted or `maxFrames` have passed. Returns a cancel function; calling
 * it after the attempt settled is a no-op. `onSettled` fires exactly once.
 */
export function focusFieldWhenReady({
  getRoot,
  field,
  onSettled,
  maxFrames = FIELD_FOCUS_MAX_FRAMES,
  requestFrame = (cb) => requestAnimationFrame(cb),
  cancelFrame = (handle) => cancelAnimationFrame(handle),
}: FocusFieldWhenReadyOptions): () => void {
  let settled = false
  let frame: number | null = null
  let attempts = 0

  const settle = (outcome: FieldFocusOutcome) => {
    if (settled) return
    settled = true
    onSettled(outcome)
  }

  const attempt = () => {
    frame = null
    if (settled) return
    const root = getRoot()
    const container = root && isInteractable(root) ? findFieldContainer(root, field) : null
    const control = container ? findFieldControl(container) : null
    if (container && control) {
      focusFieldControl(container, control)
      settle("focused")
      return
    }
    attempts += 1
    if (attempts > maxFrames) {
      if (container) {
        container.scrollIntoView?.({ block: "center", behavior: "smooth" })
        settle("scrolled")
      } else {
        if (root && isInteractable(root)) {
          root.scrollIntoView?.({ block: "start", behavior: "smooth" })
        }
        settle("fallback")
      }
      return
    }
    frame = requestFrame(attempt)
  }

  attempt()

  return () => {
    if (frame !== null) {
      cancelFrame(frame)
      frame = null
    }
    settle("cancelled")
  }
}
