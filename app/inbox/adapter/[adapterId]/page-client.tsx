"use client"

/**
 * Client component for /inbox/adapter/[adapterId].
 * Separated so the parent page.tsx can export generateStaticParams
 * without being a "use client" module.
 */

import { Suspense, use } from "react"
import { InboxShell } from "@/components/inbox/inbox-shell"

interface PageProps {
  params: Promise<{ adapterId: string }>
}

export function AdapterInboxPageClient({ params }: PageProps) {
  const { adapterId } = use(params)

  return (
    <Suspense>
      <InboxShell view="by-adapter" adapterId={adapterId} data-testid="adapter-inbox-shell" />
    </Suspense>
  )
}
