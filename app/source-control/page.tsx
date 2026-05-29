"use client"

import { SourceControlPanel } from "@/components/source-control/source-control-panel"

/**
 * Dedicated full-page Source Control route, reached from the guild-rail
 * "Source Control" entry. The panel owns its own chrome (branch header,
 * sync toolbar, resizable split); this page just hosts it full-height.
 */
export default function SourceControlPage() {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <SourceControlPanel />
    </div>
  )
}
