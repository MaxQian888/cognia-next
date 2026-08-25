"use client"

/**
 * `/issues` — the total issue board.
 *
 * Deep links use `?id=` read through `useSearchParams()` inside `<Suspense>`,
 * not a dynamic `[id]` route: this app is a Next.js static export consumed by
 * Tauri and Capacitor, so `[id]` segments do not exist at runtime. Same idiom
 * as `app/memory/page.tsx` and `app/goals/page.tsx`.
 */

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"

import { IssueConsole } from "@/components/issues/issue-console"
import { IssuesMobileBody } from "@/components/mobile/issues/issues-mobile-body"
import { usePlatform } from "@/hooks/use-platform"

function IssuesPageInner() {
  const platform = usePlatform()
  const params = useSearchParams()
  const initialSelectedId = params.get("id") ?? undefined

  if (platform === "mobile") {
    return <IssuesMobileBody initialSelectedId={initialSelectedId} />
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      <IssueConsole
        initialSelectedId={initialSelectedId}
        initialProjectId={params.get("project") ?? undefined}
      />
    </div>
  )
}

export default function IssuesPage() {
  return (
    <Suspense fallback={null}>
      <IssuesPageInner />
    </Suspense>
  )
}
