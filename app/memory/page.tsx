"use client"

import RouteBody from "./route-body"

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"

/**
 * Dedicated full-page long-term memory management panel. Reached from the
 * guild-rail "Memory" entry, Settings → Memory, and the in-chat memory chips
 * (`/memory?id=<memoryId>` deep link, and `/memory?workspace=<projectId>` to
 * open filtered to one workspace — static-export idiom: `useSearchParams`
 * inside a `<Suspense>` boundary, NOT a dynamic `[id]` route). The console
 * owns its own chrome; this page just hosts it full-height (mirrors `/goals`).
 *
 * On a narrow viewport the desktop console has no usable layout, so the
 * phone-shaped `MemoryMobileBody` renders instead (reached via /me). Keyed on
 * width rather than on the Capacitor runtime, so a 375px browser gets it too.
 */
function MemoryPageInner() {
  const params = useSearchParams()
  const initialSelectedId = params.get("id") ?? undefined
  const workspace = params.get("workspace") ?? undefined
  return <RouteBody initialSelectedId={initialSelectedId} initialProjectId={workspace} />
}

export default function MemoryPage() {
  return (
    <Suspense fallback={null}>
      <MemoryPageInner />
    </Suspense>
  )
}
