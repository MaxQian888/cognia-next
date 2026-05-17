"use client"

/**
 * Client component for /inbox/platform/[kind].
 * Separated so the parent page.tsx can export generateStaticParams
 * without being a "use client" module.
 */

import { Suspense, use } from "react"
import { InboxShell } from "@/components/inbox/inbox-shell"
import { PageLoading } from "@/components/ui/loading-states"

interface PageProps {
  params: Promise<{ kind: string }>
}

export function PlatformInboxPageClient({ params }: PageProps) {
  const { kind } = use(params)

  return (
    <Suspense fallback={<PageLoading />}>
      <InboxShell view="by-platform" platformKind={kind} data-testid="platform-inbox-shell" />
    </Suspense>
  )
}
