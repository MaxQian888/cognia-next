/**
 * App-session telemetry: the launch event and the screen-view projection.
 *
 * Kept out of the React initializer so both halves are unit-testable without a
 * renderer, and so a non-React shell (the CLI bridge, the headless brain) can
 * reuse the same route sanitiser if it ever reports navigation.
 */

import { trackEvent } from "@/lib/telemetry/events/track-event"

export const APP_LAUNCH_STORAGE_KEY = "cognia-telemetry-first-launch-at"

/**
 * Route names the shell may report. The app is a fully static export with no
 * dynamic segments (`app/**` contains no `[param]` directory), so a pathname is
 * already a route pattern — but the allowlist shape is enforced anyway so a
 * future dynamic route, a deep link, or a stray query fragment can never turn a
 * screen view into an identifier.
 */
const ROUTE_SEGMENT = /^[a-z][a-z0-9-]{0,31}$/

/**
 * Reduce a pathname to a reportable route.
 *
 * Only the first two segments are kept: that is enough to tell `/settings` from
 * `/settings/appearance` while bounding cardinality, and any segment that does
 * not look like a static route name collapses the whole thing to `other`.
 */
export function toReportableRoute(pathname: string | null | undefined): string {
  if (!pathname) return "other"
  const [path] = pathname.split(/[?#]/)
  const segments = path.split("/").filter(Boolean)
  if (segments.length === 0) return "/"
  const kept = segments.slice(0, 2)
  if (!kept.every((segment) => ROUTE_SEGMENT.test(segment))) return "other"
  return `/${kept.join("/")}`
}

interface LaunchStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * True the first time this install ever launches, so an activation funnel can
 * separate new installs from returning ones without a person profile.
 *
 * Reads *and stamps* in one call: the flag is only meaningful once.
 */
export function consumeFirstLaunchFlag(storage: LaunchStorage | undefined, now: number): boolean {
  if (!storage) return false
  try {
    if (storage.getItem(APP_LAUNCH_STORAGE_KEY)) return false
    storage.setItem(APP_LAUNCH_STORAGE_KEY, String(now))
    return true
  } catch {
    // A storage failure must never suppress the launch event itself.
    return false
  }
}

export interface AppLaunchContext {
  runtime: string
  appVersion: string
  locale: string
  storage?: LaunchStorage
  now?: () => number
}

export function trackAppLaunched(context: AppLaunchContext): Promise<boolean> {
  return trackEvent("app.launched", {
    runtime: context.runtime,
    appVersion: context.appVersion,
    locale: context.locale,
    firstLaunch: consumeFirstLaunchFlag(context.storage, (context.now ?? Date.now)()),
  })
}

export function trackScreenViewed(pathname: string | null | undefined): Promise<boolean> {
  return trackEvent("app.screen.viewed", { route: toReportableRoute(pathname) })
}
