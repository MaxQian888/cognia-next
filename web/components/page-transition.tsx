import * as React from "react"
import type { ExoticComponent, ReactNode, ViewTransitionProps } from "react"

/**
 * React's `<ViewTransition>`, when the running React has it.
 *
 * The App Router renders with the React canary Next.js vendors, which exports
 * it; the stable `react` package — what Jest and any other consumer of these
 * components resolve — does not yet. Reading it off the namespace keeps one
 * component working under both, and the fallback is exactly the browser's
 * default: the page swaps without animating.
 */
const ViewTransition = (React as { ViewTransition?: ExoticComponent<ViewTransitionProps> })
  .ViewTransition

/**
 * **Route change** — the page body fades through to the next page when the
 * reader follows an internal link (DESIGN.md, Motion).
 *
 * App Router navigations are transitions, so a `<ViewTransition>` around the
 * page body animates on every route change with no further wiring; the
 * `page-fade` class in `globals.css` supplies the fade-through. It must wrap
 * the page's outermost element (`SiteShell` puts it around `<main>`): the
 * route change remounts that element, and React runs enter and exit only for
 * a boundary that is not itself inside an element being replaced. The
 * navigation and footer stay in the root snapshot, which `globals.css` swaps
 * without animation, so identical chrome never blinks. Browsers
 * without the View Transitions API, reduced motion (the stylesheet cancels the
 * pseudo-elements' animations) and a full-document load such as switching
 * language all swap instantly instead.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  if (!ViewTransition) return <>{children}</>
  return <ViewTransition default="page-fade">{children}</ViewTransition>
}
