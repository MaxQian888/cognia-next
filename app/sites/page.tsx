"use client"

import { Suspense } from "react"

import { SitesConsole } from "@/components/sites/sites-console"

/**
 * `/sites` — the Cognia Sites console.
 *
 * Wrapped like every other full-height console route (`/memory`, `/workspace`,
 * `/issues`) so the shell's wallpaper layer applies and the console's `h-full`
 * chain has a definite height to resolve against.
 *
 * `SitesConsole` reads `useSearchParams()` for the `?site=&tab=` deep link that
 * ⌘K and Site notifications hand it. The static export pre-renders this page
 * server-side, where that hook throws unless a Suspense boundary lets it bail
 * out to client rendering.
 */
export default function SitesPage() {
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      <Suspense fallback={null}>
        <SitesConsole />
      </Suspense>
    </div>
  )
}
