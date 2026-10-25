/**
 * Where a tapped run-approval push opens on the phone (ADR-0224 A7).
 *
 * The push (`run://approval-pending`, allowlisted host-side to ids, the kind,
 * the class and a deep link) carries the page whose approvals card answers
 * it. Only the two pages that mount `RunApprovalsCard` are honoured: a push
 * payload is data from outside the app, and an approval tap that could open
 * any route is a redirect nobody asked for.
 */

/** The pages that show the approvals card, by the origin of the parked run. */
export const RUN_APPROVAL_HREFS = {
  bots: "/bots",
  scheduler: "/scheduler",
  agentRuns: "/agent-runs",
} as const

const ALLOWED: ReadonlySet<string> = new Set(Object.values(RUN_APPROVAL_HREFS))

/** The page a tapped run-approval push opens, or null when the push is not one. */
export function runApprovalTapHref(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null
  if (typeof data.interruptId !== "string" || data.interruptId.length === 0) return null
  const href = data.href
  return typeof href === "string" && ALLOWED.has(href) ? href : null
}
