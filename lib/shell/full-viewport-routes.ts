/**
 * Routes whose page needs a DEFINITE viewport height on the compact shell.
 *
 * `MobileShellWrapper` gives most routes `min-h-[100dvh]` and lets the document
 * scroll. That is not a definite height, so an `h-full` chain inside the page
 * resolves to `auto` and collapses to zero: the route renders as a blank strip
 * under the top bar. It is reachable AND empty, and no overflow check catches
 * it, which is why `/sites`, `/devices` and `/servers` each shipped that way
 * once before landing here.
 *
 * Every route built on `FeaturePageShell` is in that class, because the shell's
 * compact branch is `flex h-full min-h-0 flex-1 flex-col overflow-hidden`. The
 * list was hand-maintained inside the wrapper with no gate, so `/workspace`,
 * `/squads`, `/projects`, `/plugins` and `/twin` were all missing from it.
 *
 * Extracted here so `full-viewport-coverage.test.ts` can compare it against the
 * routes that actually reach `FeaturePageShell` rather than trusting a comment.
 */

/**
 * Exact route matches and prefixes.
 *
 * A trailing slash means "this route and everything under it". `/workflows/`
 * is deliberately prefix-only: the `/workflows` LIST scrolls normally, and only
 * its detail routes own the viewport.
 */
export const FULL_VIEWPORT_ROUTE_PATTERNS: readonly string[] = [
  // Detail routes host a fixed-height ReactFlow canvas.
  "/workflows/",
  // The A2UI hub wraps its body in a `ScrollArea h-full`.
  "/a2ui",
  "/a2ui/",
  // Feature-shell consoles. Each of these is `flex h-full min-h-0 flex-1`.
  "/sites",
  "/devices",
  "/servers",
  "/servers/",
  "/workspace",
  "/squads",
  "/projects",
  "/plugins",
  "/twin",
  "/browser",
  "/issues",
  // `DiagnosticsWorkspace` is `flex h-full min-h-0 min-w-0 flex-1`, and
  // `SourceControlMobileBody` is the same shape. Both are the collapse this
  // list exists to stop.
  "/logs",
  "/source-control",
  // Every `/me/*` sub-page. `SubPageShell` is `flex h-full min-h-0 flex-1
  // overflow-y-auto` with a sticky header, which is the shape that needs a
  // definite height: under `min-h-[100dvh]` the `h-full` resolves against a
  // parent with no height of its own, so the sticky header stops sticking and
  // the body renders as a short strip with the rest of the screen blank. The
  // terminal at `/me/terminal` was listed alone and is the one that got
  // noticed; the other 47 sub-pages have the same shell.
  //
  // Prefix-only. `/me` itself is a scrolling list of rows and must keep
  // scrolling with the page.
  "/me/",
  // `StepShell` is `h-full` so it can share one sizing rule with the desktop
  // shell, where it fills the chrome's content slot.
  "/onboarding",
  "/onboarding/",
  // `PairShell` is a `h-[100dvh] overflow-hidden` two-pane window.
  "/pair",
  "/pair/",
]

/** Whether the compact shell must give this route a definite viewport height. */
export function needsFullViewport(pathname: string): boolean {
  for (const pattern of FULL_VIEWPORT_ROUTE_PATTERNS) {
    if (pattern.endsWith("/")) {
      if (pathname.startsWith(pattern)) return true
    } else if (pathname === pattern) {
      return true
    }
  }
  return false
}
