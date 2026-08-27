import type { BrowserSubmissionStatus } from "@cognia/companion-client"
import { Badge } from "@cognia/plugin-ui"

import type { BrowserApi } from "@ext/src/lib/browser-api"

/**
 * A status, in the panel's words and never in the protocol's.
 *
 * `needs_input` and `host_unavailable` are the two that must not leak:
 * the first reads as an error and is not, and the second names an enum member
 * no user has a mental model for.
 *
 * The tone comes from `Badge`'s own variants rather than hand-written classes,
 * so a Host running the Studio or Sharp style pack squares this chip along with
 * every other badge in the product instead of leaving one capsule behind.
 */
type BadgeVariant = React.ComponentProps<typeof Badge>["variant"]

const TONE: Record<BrowserSubmissionStatus, BadgeVariant> = {
  submitting: "secondary",
  queued: "secondary",
  running: "default",
  needs_input: "warning",
  completed: "success",
  cancelled: "outline",
  failed: "destructive",
  host_unavailable: "outline",
}

const MESSAGE_KEY: Record<BrowserSubmissionStatus, string> = {
  submitting: "statusSubmitting",
  queued: "statusQueued",
  running: "statusRunning",
  needs_input: "statusNeedsInput",
  completed: "statusCompleted",
  cancelled: "statusCancelled",
  failed: "statusFailed",
  host_unavailable: "statusHostUnavailable",
}

export function StatusPill({ api, status }: { api: BrowserApi; status: BrowserSubmissionStatus }) {
  return (
    <Badge variant={TONE[status]} data-testid={`status-${status}`}>
      {api.message(MESSAGE_KEY[status])}
    </Badge>
  )
}
