"use client"

/**
 * /inbox/all — unified inbox view.
 *
 * Renders the InboxShell in "all" mode (no adapter/platform scoping).
 */

import { InboxShell } from "@/components/inbox/inbox-shell"

export default function InboxAllPage() {
  return <InboxShell view="all" />
}
