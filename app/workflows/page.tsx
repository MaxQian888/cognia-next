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
import { useIsMobile } from "@/hooks/ui/use-mobile"

export default function WorkflowsLibraryPage() {
  // `useIsMobile()` (Capacitor pin OR < 768px viewport) so a phone-width
  // browser gets the compact list instead of the desktop library grid.
  const isMobile = useIsMobile()
  if (isMobile) {
    return <WorkflowList />
  }
  return (
    <div className="h-full w-full" data-bg-target="canvas">
      <WorkflowLibrary />
    </div>
  )
}
