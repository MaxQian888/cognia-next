"use client"

import { Suspense } from "react"

import { RemoteDesktopViewerPage } from "@/components/remote-desktop/remote-desktop-viewer-page"

/** `/devices/remote-desktop?target=&binding=&mode=` (ADR-0234 Phase 2). */
export default function RemoteDesktopRoute() {
  return (
    <Suspense fallback={null}>
      <div className="h-dvh">
        <RemoteDesktopViewerPage />
      </div>
    </Suspense>
  )
}
