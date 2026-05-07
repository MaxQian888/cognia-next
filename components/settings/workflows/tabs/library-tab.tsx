"use client"

import { WorkflowLibrary } from "@/components/workflow/library/workflow-library"

/**
 * Embeds the same library list rendered at /workflows so users can manage
 * workflows without leaving Settings. The library owns its own header +
 * search + create dialog; we just give it a sized container.
 */
export function LibraryTab() {
  return (
    <div className="-mx-2 h-[calc(100vh-12rem)] min-h-[400px] overflow-hidden rounded-md border">
      <WorkflowLibrary />
    </div>
  )
}
