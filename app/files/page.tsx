"use client"

import { Suspense } from "react"

import { FilesLibrary } from "@/components/files-library/files-library"

/**
 * `/files` — the cross-conversation Files page (ADR-0200).
 *
 * `FilesLibrary` reads `useSearchParams()` for the `?tab=&item=` deep link ⌘K
 * hands it. The static export pre-renders this page server-side, where that
 * hook throws unless a Suspense boundary lets it bail out to client rendering.
 */
export default function FilesPage() {
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      <Suspense fallback={null}>
        <FilesLibrary />
      </Suspense>
    </div>
  )
}
