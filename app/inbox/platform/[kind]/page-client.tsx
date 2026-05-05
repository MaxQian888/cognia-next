"use client"

/**
 * Client component for /inbox/platform/[kind].
 * Separated so the parent page.tsx can export generateStaticParams
 * without being a "use client" module.
 */

import { Suspense, use } from "react"
import { InboxShell } from "@/components/inbox/inbox-shell"

interface PageProps {
  params: Promise<{ kind: string }>
}

export function PlatformInboxPageClient({ params }: PageProps) {
  const { kind } = use(params)

  return (
    <Suspense>
      <InboxShell view="by-platform" platformKind={kind} data-testid="platform-inbox-shell" />
    </Suspense>
  )
}
