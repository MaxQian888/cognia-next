"use client"

/**
 * /inbox/adapter/[adapterId] — per-adapter conversation list.
 *
 * Renders InboxShell with view="by-adapter" and the adapterId scope.
 */

import { use } from "react"
import { InboxShell } from "@/components/inbox/inbox-shell"

interface PageProps {
  params: Promise<{ adapterId: string }>
}

export default function AdapterInboxPage({ params }: PageProps) {
  const { adapterId } = use(params)

  return <InboxShell view="by-adapter" adapterId={adapterId} data-testid="adapter-inbox-shell" />
}
