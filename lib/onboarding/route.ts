/**
 * The first-run flow's route (ADR-0122).
 *
 * A constant rather than a string literal at each call site because three
 * places have to agree on it — the gate that redirects into it, the page that
 * serves it, and the Settings "re-run setup" entry point — and a typo in any
 * one of them produces a redirect loop rather than a build error.
 */
export const ONBOARDING_ROUTE = "/onboarding"

/**
 * Whether a path is the first-run takeover.
 *
 * The flow owns the entire window: `DesktopAppShell` suppresses its chrome
 * here the way it does for the deep-link screens, so the title bar, guild
 * rail, status bar, terminal dock and the residual finish-setup notice are all
 * absent for the length of it. Setup is not a page you visit *inside* the app
 * — the app is what it is setting up — and the half-painted shell behind it
 * was advertising a workspace the user cannot use yet.
 *
 * Kept here rather than added to `lib/shell/bypass-routes` because that list
 * means something narrower: mid-task deep links and small frameless windows
 * that keep the document scroll. The takeover is a full-height flex column
 * that draws its own window bar, so it needs the chrome suppressed for a
 * different reason and answers to a different owner.
 *
 * Matches the exported-HTML form (`/onboarding.html`) too — a static export
 * serves the route under both names.
 */
export function isOnboardingRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false
  return (
    pathname === ONBOARDING_ROUTE ||
    pathname === `${ONBOARDING_ROUTE}.html` ||
    pathname.startsWith(`${ONBOARDING_ROUTE}/`)
  )
}
