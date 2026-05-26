"use client"

/**
 * A2UI Column Component
 * Vertical flex container for layout
 */

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import type { A2UIComponentProps, A2UIColumnComponent } from "@/types/a2ui/schema"
import { A2UIChildRenderer } from "../a2ui-child-renderer"

const alignStyles: Record<string, string> = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
}

export const A2UIColumn = memo(function A2UIColumn({
  component,
}: A2UIComponentProps<A2UIColumnComponent>) {
  const { children = [], gap, align = "stretch" } = component

  // Convert gap to Tailwind class or inline style
  const gapStyle = typeof gap === "number" ? { gap: `${gap}px` } : {}
  const gapClass = typeof gap === "string" ? `gap-${gap}` : gap ? "" : "gap-2"

  return (
    <div
      className={cn("flex flex-col", gapClass, alignStyles[align], component.className)}
      style={{
        ...gapStyle,
        ...(component.style as React.CSSProperties),
      }}
    >
      <A2UIChildRenderer childIds={children} />
    </div>
  )
})
