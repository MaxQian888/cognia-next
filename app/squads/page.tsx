"use client"

/**
 * `/squads` — the Squad fleet.
 *
 * Deep links arrive as `?id=`, read through `useSearchParams()` inside a
 * `<Suspense>` boundary, not as a dynamic `[id]` route: this app is a static
 * export (Tauri + Capacitor consume `out/`), where dynamic segments do not
 * exist at runtime. Same idiom as `app/issues/page.tsx` and
 * `app/servers/detail/page.tsx`.
 */

import { Suspense, useCallback } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { SquadFleetConsole, type SquadFleetTab } from "@/components/squads/squad-fleet-console"

function SquadsPageInner() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const selectedId = searchParams?.get("id") ?? undefined
  // The centre tab lives here for the same reason `?id=` does, plus one more:
  // `FeaturePageShell` renders its children through two different trees and
  // remounts the subtree when the breakpoint resolves, which would drop a tab
  // held in the console's own state.
  const tab: SquadFleetTab = searchParams?.get("tab") === "board" ? "board" : "runs"

  const replaceParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(searchParams?.toString() ?? "")
      if (value) next.set(key, value)
      else next.delete(key)
      const query = next.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    },
    [router, pathname, searchParams]
  )

  const onSelect = useCallback(
    (squadId: string | null) => replaceParam("id", squadId),
    [replaceParam]
  )
  const onTabChange = useCallback(
    (next: SquadFleetTab) => replaceParam("tab", next === "board" ? "board" : null),
    [replaceParam]
  )

  return (
    <SquadFleetConsole
      {...(selectedId ? { selectedId } : {})}
      onSelect={onSelect}
      tab={tab}
      onTabChange={onTabChange}
    />
  )
}

export default function SquadsPage() {
  return (
    <Suspense fallback={null}>
      <SquadsPageInner />
    </Suspense>
  )
}
