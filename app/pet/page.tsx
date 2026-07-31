"use client"

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { PetConsole } from "@/components/pet/console/pet-console"
import { isPetConsoleTab } from "@/lib/pet/console-tabs"

/**
 * Full-page `/pet` console, hosted full-height so the console owns its own
 * scroll + chrome — mirrors `/memory` and `/eval` (no page-level `overflow`,
 * shared `data-bg-target` background). Static-export-safe deep link: the
 * initial tab rides in `?tab=` (read via `useSearchParams` inside a
 * `<Suspense>` boundary), used by the widget panel's quick-nav and the
 * desktop-popup → main-window bridge.
 */
function PetRoute() {
  const params = useSearchParams()
  const tabParam = params.get("tab")
  return <PetConsole initialTab={isPetConsoleTab(tabParam) ? tabParam : undefined} />
}

export default function PetPage() {
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col" data-bg-target="chat">
      <Suspense fallback={null}>
        <PetRoute />
      </Suspense>
    </div>
  )
}
