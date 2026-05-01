"use client"

/**
 * A2UI Divider Component
 * Renders a horizontal or vertical divider line
 */

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import { Separator } from "@/components/ui/separator"
import type { A2UIComponentProps, A2UIDividerComponent } from "@/types/a2ui/schema"

export const A2UIDivider = memo(function A2UIDivider({
  component,
}: A2UIComponentProps<A2UIDividerComponent>) {
  const orientation = component.orientation || "horizontal"

  if (component.text) {
    return (
      <div
        className={cn(
          "flex items-center gap-3",
          orientation === "vertical" && "flex-col",
          component.className
        )}
        style={component.style as React.CSSProperties}
      >
        <Separator
          orientation={orientation}
          className={cn(orientation === "horizontal" ? "flex-1" : "flex-1 h-auto")}
        />
        <span className="text-xs text-muted-foreground whitespace-nowrap">{component.text}</span>
        <Separator
          orientation={orientation}
          className={cn(orientation === "horizontal" ? "flex-1" : "flex-1 h-auto")}
        />
      </div>
    )
  }

  return (
    <Separator
      orientation={orientation}
      className={cn(orientation === "vertical" && "h-auto min-h-[20px]", component.className)}
      style={component.style as React.CSSProperties}
    />
  )
})
