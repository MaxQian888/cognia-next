"use client"

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"
import { useLoadingI18n } from "@/hooks/ui/use-loading-i18n"
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
  const t = useLoadingI18n()

  if (component.variant === "text" && lines > 1) {
    // Multi-line: the wrapper announces once for the whole block, and the
    // individual bars stay decorative (Skeleton hides itself by default).
    return (
      <div
        className={cn("space-y-2", component.className)}
        style={component.style as React.CSSProperties}
        role="status"
        aria-label={t.loading}
      >
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className={cn("h-4", i === lines - 1 ? "w-3/4" : "w-full")} />
        ))}
      </div>
    )
  }

  // Single block: this IS the whole loading affordance, with no wrapper to
  // carry the announcement — the standalone case Skeleton's default hiding
  // explicitly leaves an escape hatch for.
  return (
    <Skeleton
      role="status"
      aria-label={t.loading}
      aria-hidden={false}
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
