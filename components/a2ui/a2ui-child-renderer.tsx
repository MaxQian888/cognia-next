"use client"

import React, { memo } from "react"
import { useA2UIActions } from "@/hooks/a2ui/use-a2ui-context"

/**
 * Render a list of child component IDs.
 *
 * Extracted to its own module to break the circular dependency between
 * a2ui-renderer (which imports every layout component) and layout
 * components (which need A2UIChildRenderer).
 */
export const A2UIChildRenderer = memo(function A2UIChildRenderer({
  childIds,
}: {
  childIds: string[]
}) {
  // Actions-only context: re-renders when the component tree changes, but not
  // on data-model-only changes (e.g. keystrokes)
  const { renderChild } = useA2UIActions()

  return (
    <>
      {childIds.map((childId) => (
        <React.Fragment key={childId}>{renderChild(childId)}</React.Fragment>
      ))}
    </>
  )
})
