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

import { SquadFleetConsole } from "@/components/squads/squad-fleet-console"

function SquadsPageInner() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const selectedId = searchParams?.get("id") ?? undefined

  const onSelect = useCallback(
    (squadId: string | null) => {
      const next = new URLSearchParams(searchParams?.toString() ?? "")
      if (squadId) next.set("id", squadId)
      else next.delete("id")
      const query = next.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    },
    [router, pathname, searchParams]
  )

  return <SquadFleetConsole {...(selectedId ? { selectedId } : {})} onSelect={onSelect} />
}

export default function SquadsPage() {
  return (
    <Suspense fallback={null}>
      <SquadsPageInner />
    </Suspense>
  )
}
