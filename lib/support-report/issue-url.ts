/**
 * Pre-filled issue-tracker links.
 *
 * One builder for every "Open issue" affordance in the app, so a report opened
 * from the error page, the Support strip, the mobile Feedback page or a
 * notification row lands on the same tracker with the same title/body shape.
 */

import { ISSUES_URL } from "@/lib/constants/external-urls"

/**
 * Trackers reject very long query strings, and a 200k-character stack pasted
 * into a URL fails silently rather than loudly. Truncate before that happens.
 */
export const MAX_ISSUE_BODY = 6000

/**
 * The tracker to file against: the deploy-time override wins, otherwise the
 * project's public repository. Always defined — there is no configuration in
 * which "Report issue" has nowhere to go.
 */
export function resolveIssueTrackerUrl(
  override: string | undefined = process.env.NEXT_PUBLIC_ISSUE_REPORT_URL
): string {
  return override && override.trim().length > 0 ? override.trim() : ISSUES_URL
}

/**
 * The "new issue" endpoint for a tracker given as a repo root, an `/issues`
 * listing, or an explicit `/issues/new` URL (trailing slashes tolerated).
 */
export function resolveNewIssueEndpoint(base: string): string {
  const normalized = base.replace(/\/+$/, "")
  if (/\/issues\/new$/.test(normalized)) return normalized
  if (/\/issues$/.test(normalized)) return `${normalized}/new`
  return `${normalized}/issues/new`
}

/** Build a pre-filled issue-tracker URL. */
export function buildIssueUrl(base: string, title: string, body: string): string {
  const endpoint = resolveNewIssueEndpoint(base)
  const truncatedBody = body.length > MAX_ISSUE_BODY ? `${body.slice(0, MAX_ISSUE_BODY)}\n…` : body
  const params = new URLSearchParams({ title, body: truncatedBody })
  return `${endpoint}?${params.toString()}`
}
