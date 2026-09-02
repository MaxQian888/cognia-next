/**
 * Where an issue lives on screen.
 *
 * `/issues` reads `?id=` through `useSearchParams()` (see `app/issues/page.tsx`)
 * and seeds the console's selection from it, so this is the one link that
 * lands on an issue with it selected. Query param, never a `[id]` route: the
 * app is a static export consumed by Tauri and Capacitor. Kept free of any
 * Dexie import so a chip on the Squad board can link back without dragging
 * the issue tables into its bundle.
 */

export const ISSUES_HREF = "/issues"

/** Deep link to an issue, selected. */
export function issueHref(issueId: string): string {
  return `${ISSUES_HREF}?id=${encodeURIComponent(issueId)}`
}
