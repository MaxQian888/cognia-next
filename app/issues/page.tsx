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
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"
import { ISSUE_SOURCE_PARAM } from "@/lib/issues/hrefs"
import { ISSUE_SOURCE_KINDS, type IssueSourceKind } from "@/types/issues/unified"

/** The `?source=` of a deep link, when it names a source this build knows. */
function readSelectedSource(value: string | null): IssueSourceKind | undefined {
  return ISSUE_SOURCE_KINDS.find((kind) => kind === value)
}

function IssuesPageInner() {
  // Width, not runtime: the desktop board is a multi-column grid that a
  // 375px browser cannot render any better than a phone can.
  const compact = useCompactLayout()
  const params = useSearchParams()
  const initialSelectedId = params.get("id") ?? undefined
  const initialSelectedSource = readSelectedSource(params.get(ISSUE_SOURCE_PARAM))

  if (compact) {
    return <IssuesMobileBody initialSelectedId={initialSelectedId} />
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      <IssueConsole
        initialSelectedId={initialSelectedId}
        initialSelectedSource={initialSelectedSource}
        initialProjectId={params.get("project") ?? undefined}
        initialCycleId={params.get("cycle") ?? undefined}
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
