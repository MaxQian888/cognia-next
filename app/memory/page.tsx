"use client"

import { MemoryConsole } from "@/components/memory/memory-console"

/**
 * Dedicated full-page long-term memory management panel. Reached from the
 * guild-rail "Memory" entry and Settings → Memory. The console owns its own
 * chrome; this page just hosts it full-height (mirrors `/goals`).
 */
export default function MemoryPage() {
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      <MemoryConsole />
    </div>
  )
}
