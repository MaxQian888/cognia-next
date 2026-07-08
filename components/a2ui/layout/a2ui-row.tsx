"use client"

/**
 * A2UI Row Component
 * Horizontal flex container for layout
 */

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import type { A2UIComponentProps, A2UIRowComponent } from "@/types/a2ui/schema"
import { A2UIChildRenderer } from "../a2ui-child-renderer"

const alignStyles: Record<string, string> = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
}

const justifyStyles: Record<string, string> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  between: "justify-between",
  around: "justify-around",
  evenly: "justify-evenly",
}

export const A2UIRow = memo(function A2UIRow({ component }: A2UIComponentProps<A2UIRowComponent>) {
  const { children = [], gap, align = "center", justify = "start", wrap = false } = component

  // Convert gap to Tailwind class or inline style
  const gapStyle = typeof gap === "number" ? { gap: `${gap}px` } : {}
  const gapClass = typeof gap === "string" ? `gap-${gap}` : gap ? "" : "gap-2"

  return (
    <div
      className={cn(
        // min-w-0 on the row and its direct children lets flex items shrink
        // instead of overflowing narrow inline surfaces
        "flex min-w-0 flex-row [&>*]:min-w-0",
        gapClass,
        alignStyles[align],
        justifyStyles[justify],
        wrap && "flex-wrap",
        component.className
      )}
      style={{
        ...gapStyle,
        ...(component.style as React.CSSProperties),
      }}
    >
      <A2UIChildRenderer childIds={children} />
    </div>
  )
})
