"use client"

/**
 * `/workspace` — overview of the active workspace (the repo's `Project`
 * entity, user-facing label "Workspace").
 *
 * Read-and-navigate only: workspace roots keep exactly one editor
 * (`components/shell/workspace-manage-dialog.tsx`), which this page links to.
 */

import { WorkspaceOverview } from "@/components/workspace/workspace-overview"

export default function WorkspacePage() {
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      <WorkspaceOverview />
    </div>
  )
}
