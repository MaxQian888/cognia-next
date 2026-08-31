"use client"

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"

import { MemoryConsole } from "@/components/memory/memory-console"
import { MemoryMobileBody } from "@/components/mobile/memory/memory-mobile-body"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"

/**
 * Dedicated full-page long-term memory management panel. Reached from the
 * guild-rail "Memory" entry, Settings → Memory, and the in-chat memory chips
 * (`/memory?id=<memoryId>` deep link — static-export idiom: `useSearchParams`
 * inside a `<Suspense>` boundary, NOT a dynamic `[id]` route). The console
 * owns its own chrome; this page just hosts it full-height (mirrors `/goals`).
 *
 * On a narrow viewport the desktop console has no usable layout, so the
 * phone-shaped `MemoryMobileBody` renders instead (reached via /me). Keyed on
 * width rather than on the Capacitor runtime, so a 375px browser gets it too.
 */
function MemoryPageInner() {
  const compact = useCompactLayout()
  const params = useSearchParams()
  const initialSelectedId = params.get("id")
  if (compact) return <MemoryMobileBody initialSelectedId={initialSelectedId ?? undefined} />
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      <MemoryConsole initialSelectedId={initialSelectedId ?? undefined} />
    </div>
  )
}

export default function MemoryPage() {
  return (
    <Suspense fallback={null}>
      <MemoryPageInner />
    </Suspense>
  )
}
