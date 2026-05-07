"use client"

/**
 * /workflows — visual workflow library landing page.
 *
 * Mirrors the Settings → Workflows → Library tab but as a top-level route so
 * users can land directly here from the sidebar without going through Settings.
 */

import { WorkflowLibrary } from "@/components/workflow/library/workflow-library"

export default function WorkflowsLibraryPage() {
  return (
    <div className="h-full">
      <WorkflowLibrary />
    </div>
  )
}
