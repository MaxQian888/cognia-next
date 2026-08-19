"use client"

/**
 * Owns the Ops Controller session for `/servers` and `/servers/detail`.
 *
 * A layout rather than per-page state because the controller has no endpoint
 * that lists operations: an operation is only ever learned from the response
 * that queued it or from the live event stream, so navigating from the fleet
 * into a server would otherwise drop the history — and re-open a second event
 * subscription against the same controller.
 */

import { ServerOpsProvider } from "@/components/servers/ops-context"

export default function ServersLayout({ children }: { children: React.ReactNode }) {
  return <ServerOpsProvider>{children}</ServerOpsProvider>
}
