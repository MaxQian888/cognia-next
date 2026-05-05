"use client"

/**
 * /inbox/platform/[kind] — per-platform conversation list.
 *
 * Renders InboxShell with view="by-platform" and the platformKind scope.
 */

import { use } from "react"
import { InboxShell } from "@/components/inbox/inbox-shell"

interface PageProps {
  params: Promise<{ kind: string }>
}

export default function PlatformInboxPage({ params }: PageProps) {
  const { kind } = use(params)

  return <InboxShell view="by-platform" platformKind={kind} data-testid="platform-inbox-shell" />
}
