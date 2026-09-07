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
 * Extracted here so the co-located `full-viewport-routes.test.ts` can compare
 * it against the routes that actually reach `FeaturePageShell` rather than
 * trusting a comment. (It named a `full-viewport-coverage.test.ts` that has
 * never existed, which is a pointer nobody could follow.)
 */

/**
 * Exact route matches and prefixes.
 *
 * A trailing slash means "this route and everything under it". `/workflows/`
 * is deliberately prefix-only: the `/workflows` LIST scrolls normally, and only
 * its detail routes own the viewport.
 *
 * `"/"` is the one exception, and {@link needsFullViewport} spells it out: read
 * as a prefix it would match every path in the app.
 */
export const FULL_VIEWPORT_ROUTE_PATTERNS: readonly string[] = [
  // The chat shell itself. `AppShellMobile` is a `h-full` column whose chat pane
  // is `overflow-hidden`, so it owns the viewport exactly the way a feature
  // shell does. Under the `min-h-[100dvh]` branch the wrapper's tab-bar padding
  // was ADDED to a box that was already one viewport tall, so the document ran
  // 56px + safe-area longer than the screen. `body[data-app-shell]{overflow:
  // hidden}` swallowed it here and the moment the user left `/` (the attribute
  // is cleared on unmount) the same reserve surfaced as a bare strip under the
  // page.
  "/",
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
  // Pre-existing gap, caught by the coverage sweep below: `BotConsole` is a
  // `FeaturePageShell` and shipped without its entry, so the compact shell was
  // rendering it as a blank strip under the top bar.
  "/bots",
  // Compact bodies that REPLACE the shell and still own the viewport.
  // `TemplatesMobileBody` and `DiscoverMobileBody` are both `flex h-full
  // min-h-0`, so the exemption from the feature-shell sweep was never an
  // exemption from the height requirement: under `min-h-[100dvh]` that chain
  // resolves to `auto` and the page is a blank strip. `MemoryMobileBody` and
  // `GoalsMobileBody` are `min-h-[100dvh]` and genuinely scroll with the
  // document, which is the only shape that needs nothing here.
  "/templates",
  "/discover",
  // `/agent-runs` never reaches `FeaturePageShell` at all, so no sweep saw it,
  // and its own root is `flex h-full min-h-0 w-full flex-1`.
  "/agent-runs",
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
    // The root route is exact, never a prefix. Every other trailing slash means
    // "and everything under it", which for `"/"` would be the entire app.
    if (pattern === "/") {
      if (pathname === "/") return true
      continue
    }
    if (pattern.endsWith("/")) {
      if (pathname.startsWith(pattern)) return true
    } else if (pathname === pattern) {
      return true
    }
  }
  return false
}
