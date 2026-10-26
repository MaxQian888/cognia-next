/**
 * The vocabulary for "the user pointed at this element", shared by every
 * surface that can be pointed at.
 *
 * This file exists because two surfaces grew the same need from opposite ends.
 * The embedded browser got there first: `BrowserSelection` in
 * `lib/browser/protocol.ts` has carried selector/DOM/computed-style/React
 * enrichment since ADR-0055, and `formatSelectionComment` turns it into the
 * prompt block the model actually reads. The artifacts dock then needed the
 * identical payload for its own preview — and the ONLY browser-specific parts
 * of that payload turned out to be three fields (`paneId`, `pageUrl`,
 * `pageTitle`).
 *
 * So the core is lifted here rather than copied, and `BrowserSelection` keeps
 * its exact published shape by extending it. That matters beyond tidiness:
 * `packages/plugin-sdk/src/api/browser.ts` re-exports `BrowserSelection` to
 * plugin authors (ADR-0155/0156), so its field set is a contract, not an
 * implementation detail.
 *
 * Deliberately dependency-free and outside `lib/`: the artifact picker that
 * produces these runs inside an opaque-origin sandboxed iframe whose bundle
 * must stay hermetic (ADR-0158), and it reaches this file through a type-only
 * import that esbuild erases before resolution.
 */

export interface ElementRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ViewportSize {
  width: number
  height: number
}

/**
 * The page's main content column, used by the browser's Adjust controls to
 * reason about where an element sits relative to the readable width.
 */
export interface ContentArea {
  selector: string
  left: number
  right: number
  width: number
  centerX: number
}

/**
 * The owning flex/grid container, when there is one. Absent for elements whose
 * parent lays out normally — "no parent layout" is a fact worth stating, and a
 * default of `display: block` would be a fact the picker never established.
 */
export interface ParentLayout {
  display: "flex" | "grid"
  selector: string
  flexDirection?: string
  gridTemplateColumns?: string
  gap?: string
}

/**
 * A react-dev-inspector-style source location, read from real DOM attributes
 * (`data-inspector-relative-path` / `-line` / `-column`) rather than from a
 * fiber's `_debugSource`, which React 19 removed.
 */
export interface ElementSourceHint {
  path: string
  line: number
  column?: number
}

/**
 * Why a payload carries less than it could. Present only when a budget
 * actually fired, so its absence means "nothing was dropped" rather than
 * "nobody checked".
 */
export interface ElementDetailReduction {
  selectionCount: number
  outerHTMLLimit: number
  reason: string
}

/**
 * One picked element, independent of what was hosting it.
 *
 * Every field past `text` is optional because every one of them comes from a
 * best-effort read that a hostile or exotic document may not answer:
 * `getComputedStyle` can be absent in a stripped frame, a fiber tree can be
 * broken, and enrichment must never be able to fail a pick. A consumer that
 * needs one of them must handle its absence, not assume a default.
 */
export interface ElementSelectionCore {
  selector: string
  domPath: string
  tagName: string
  /** The element's `id` attribute, or null. */
  id: string | null
  classes: string | null
  rect: ElementRect
  outerHTML: string
  text: string
  viewport?: ViewportSize
  contentArea?: ContentArea
  parentLayout?: ParentLayout
  nearbyText?: string
  computedStyles?: Record<string, string>
  accessibility?: { role: string; name: string }
  devicePixelRatio?: number
  timestamp?: string
  detailReduced?: ElementDetailReduction
  // --- Component-aware enrichment (React only) -----------------------------
  /** Nearest owning component's display name, e.g. `"SubmitButton"`. */
  componentName?: string | null
  /** Outermost→innermost component chain, e.g. `"App > CheckoutForm > SubmitButton"`. */
  componentStack?: string | null
  /** Shallow, truncated `memoizedProps` of the owning component (primitives only). */
  props?: Record<string, string> | null
  /** Framework the enrichment came from, or null when undetected. */
  framework?: "react" | null
  sourceHint?: ElementSourceHint | null
  /**
   * What the prompt heading calls this element's origin, e.g. `"in-app
   * browser"` or `"artifact preview"`.
   *
   * Carried on the selection rather than passed to the formatter because a
   * selection outlives the moment it was taken: a queued annotation is
   * formatted long after, by a batch writer that has no idea which surface
   * produced which row. English on purpose — it is prompt scaffolding, not UI
   * copy, and must not follow the user's locale.
   */
  originLabel?: string
}
