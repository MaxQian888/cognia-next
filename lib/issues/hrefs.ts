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

import type { IssueSourceKind } from "@/types/issues/unified"

export const ISSUES_HREF = "/issues"

/**
 * Which source the `?id=` names. Absent means a local issue, which is what
 * every link built before other sources could be deep-linked meant. Needed
 * because ids alone are ambiguous across sources: a shared (collaboration)
 * issue and a local one both read `iss_…`.
 */
export const ISSUE_SOURCE_PARAM = "source"

/** Deep link to an issue, selected. `source` defaults to a local issue. */
export function issueHref(issueId: string, source: IssueSourceKind = "local"): string {
  const base = `${ISSUES_HREF}?id=${encodeURIComponent(issueId)}`
  return source === "local" ? base : `${base}&${ISSUE_SOURCE_PARAM}=${encodeURIComponent(source)}`
}
