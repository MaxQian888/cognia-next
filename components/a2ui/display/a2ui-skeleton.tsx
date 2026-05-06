"use client"

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"
import type { A2UIComponentProps, A2UIBaseComponent } from "@/types/a2ui/schema"

export interface A2UISkeletonComponent extends A2UIBaseComponent {
  component: "Skeleton"
  variant?: "text" | "circular" | "rectangular"
  width?: number | string
  height?: number | string
  lines?: number
}

export const A2UISkeleton = memo(function A2UISkeleton({
  component,
}: A2UIComponentProps<A2UISkeletonComponent>) {
  const lines = component.lines || 1

  if (component.variant === "text" && lines > 1) {
    return (
      <div
        className={cn("space-y-2", component.className)}
        style={component.style as React.CSSProperties}
        role="status"
        aria-label="Loading"
      >
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className={cn("h-4", i === lines - 1 ? "w-3/4" : "w-full")} />
        ))}
      </div>
    )
  }

  return (
    <Skeleton
      role="status"
      aria-label="Loading"
      className={cn(
        component.variant === "circular" && "rounded-full size-10",
        component.className
      )}
      style={{
        width: component.width,
        height: component.height || (component.variant === "text" ? 16 : undefined),
        ...(component.style as React.CSSProperties),
      }}
    />
  )
})
