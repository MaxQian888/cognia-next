"use client"

import { Suspense } from "react"

import { RemoteDesktopViewerPage } from "@/components/remote-desktop/remote-desktop-viewer-page"

/**
 * `/devices/remote-desktop?target=&binding=&mode=[&host=]` (ADR-0234 Phases 2
 * and 3). A full window on the desktop; on the compact shell, a flex child of
 * the viewport-sized column, so it shrinks with the soft keyboard.
 */
export default function RemoteDesktopRoute() {
  return (
    <Suspense fallback={null}>
      <div className="flex h-dvh min-h-0 flex-1 flex-col">
        <RemoteDesktopViewerPage />
      </div>
    </Suspense>
  )
}
