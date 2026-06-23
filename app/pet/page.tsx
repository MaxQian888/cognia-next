"use client"

import { PetConsole } from "@/components/pet/console/pet-console"

/**
 * Full-page `/pet` console, hosted full-height so the console owns its own
 * scroll + chrome — mirrors `/memory` and `/eval` (no page-level `overflow`,
 * shared `data-bg-target` background).
 */
export default function PetPage() {
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col" data-bg-target="chat">
      <PetConsole />
    </div>
  )
}
