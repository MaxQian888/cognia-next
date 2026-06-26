"use client"

import { MemoryConsole } from "@/components/memory/memory-console"
import { MemoryMobileBody } from "@/components/mobile/memory/memory-mobile-body"
import { usePlatform } from "@/hooks/use-platform"

/**
 * Dedicated full-page long-term memory management panel. Reached from the
 * guild-rail "Memory" entry and Settings → Memory. The console owns its own
 * chrome; this page just hosts it full-height (mirrors `/goals`).
 *
 * On the mobile companion the desktop console has no usable layout, so the
 * phone renders a read-mostly `MemoryMobileBody` instead (reached via /me).
 */
export default function MemoryPage() {
  const platform = usePlatform()
  if (platform === "mobile") return <MemoryMobileBody />
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col" data-bg-target="chat">
      <MemoryConsole />
    </div>
  )
}
