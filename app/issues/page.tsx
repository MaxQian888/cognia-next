"use client"

import RouteBody from "./route-body"

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

import { ISSUE_ASSIGNEE_PARAM, ISSUE_SOURCE_PARAM } from "@/lib/issues/hrefs"
import { ISSUE_SOURCE_KINDS, type IssueSourceKind } from "@/types/issues/unified"

/** The `?source=` of a deep link, when it names a source this build knows. */
function readSelectedSource(value: string | null): IssueSourceKind | undefined {
  return ISSUE_SOURCE_KINDS.find((kind) => kind === value)
}

function IssuesPageInner() {
  const params = useSearchParams()
  const initialSelectedId = params.get("id") ?? undefined
  const initialSelectedSource = readSelectedSource(params.get(ISSUE_SOURCE_PARAM))

  return (
    <RouteBody
      initialSelectedId={initialSelectedId}
      initialSelectedSource={initialSelectedSource}
      initialProjectId={params.get("project") ?? undefined}
      initialCycleId={params.get("cycle") ?? undefined}
      initialAssignee={params.get(ISSUE_ASSIGNEE_PARAM) ?? undefined}
    />
  )
}

export default function IssuesPage() {
  return (
    <Suspense fallback={null}>
      <IssuesPageInner />
    </Suspense>
  )
}
