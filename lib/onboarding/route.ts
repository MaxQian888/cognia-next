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

/**
 * What a re-entry into the flow is *for* (ADR-0193).
 *
 *  - `model` — the device still cannot reach a model; land on the sign-in.
 *  - `task`  — setup is otherwise done; land on the first-task cards.
 *
 * Without it, every way back into the flow — the finish-setup bar, the
 * setup-status block in Settings — resumed wherever the user last stood, which
 * for the recommended path meant re-reading (and re-running) the whole plan to
 * get to the one thing that was actually missing.
 */
export type OnboardingFocus = "model" | "task"

const FOCUS_PARAM = "focus"
const FOCUS_VALUES: readonly OnboardingFocus[] = ["model", "task"]

/** The flow's route, optionally aimed at one thing to finish. */
export function onboardingHref(focus?: OnboardingFocus): string {
  return focus ? `${ONBOARDING_ROUTE}?${FOCUS_PARAM}=${focus}` : ONBOARDING_ROUTE
}

/**
 * Read the focus from a query string (`useSearchParams().toString()`, with or
 * without its leading `?`).
 *
 * Anything other than the two known values is ignored rather than trusted.
 */
export function readOnboardingFocus(search: string | null | undefined): OnboardingFocus | null {
  if (!search) return null
  const value = new URLSearchParams(search).get(FOCUS_PARAM)
  return FOCUS_VALUES.find((focus) => focus === value) ?? null
}
