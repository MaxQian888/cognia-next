"use client"

import { SitesConsole } from "@/components/sites/sites-console"

/**
 * `/sites` — the Cognia Sites console.
 *
 * Wrapped like every other full-height console route (`/memory`, `/workspace`,
 * `/issues`) so the shell's wallpaper layer applies and the console's `h-full`
 * chain has a definite height to resolve against.
 */
export default function SitesPage() {
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col" data-bg-target="chat">
      <SitesConsole />
    </div>
  )
}
