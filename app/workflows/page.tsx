"use client"

/**
 * /workflows — visual workflow library landing page.
 *
 * Mirrors the Settings → Workflows → Library tab but as a top-level route so
 * users can land directly here from the sidebar without going through Settings.
 * On mobile, swaps to a compact mobile-tuned list with Pinned grouping +
 * recent runs feed.
 */

import { WorkflowLibrary } from "@/components/workflow/library/workflow-library"
import { WorkflowList } from "@/components/mobile/workflow/workflow-list"
import { usePlatform } from "@/hooks/use-platform"

export default function WorkflowsLibraryPage() {
  const platform = usePlatform()
  if (platform === "mobile") {
    return <WorkflowList />
  }
  return (
    <div className="h-full w-full" data-bg-target="canvas">
      <WorkflowLibrary />
    </div>
  )
}
