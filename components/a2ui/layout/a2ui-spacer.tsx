"use client"

/**
 * A2UI Spacer Component
 * Renders empty space for layout purposes
 */

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import type { A2UIComponentProps, A2UISpacerComponent } from "@/types/a2ui/schema"

export const A2UISpacer = memo(function A2UISpacer({
  component,
}: A2UIComponentProps<A2UISpacerComponent>) {
  const size = component.size || 16
  const sizeValue = typeof size === "number" ? `${size}px` : size

  return (
    <div
      className={cn("flex-shrink-0", component.className)}
      style={{
        width: sizeValue,
        height: sizeValue,
        minWidth: sizeValue,
        minHeight: sizeValue,
        ...(component.style as React.CSSProperties),
      }}
      aria-hidden="true"
    />
  )
})
