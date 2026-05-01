"use client"

/**
 * A2UI Loading Component
 * Displays loading states with various styles
 */

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import { LoadingSpinner, LoadingDots } from "@/components/ui/loading-states"
import type { A2UIComponentProps, A2UIBaseComponent } from "@/types/a2ui/schema"

export interface A2UILoadingComponent extends A2UIBaseComponent {
  component: "Loading"
  text?: string
  size?: "sm" | "md" | "lg"
  variant?: "spinner" | "dots" | "pulse"
}

const textSizeClasses = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-base",
}

export const A2UILoading = memo(function A2UILoading({
  component,
}: A2UIComponentProps<A2UILoadingComponent>) {
  const size = component.size || "md"
  const variant = component.variant || "spinner"

  const renderLoader = () => {
    switch (variant) {
      case "dots":
        return <LoadingDots />

      case "pulse":
        return (
          <div
            className={cn(
              "rounded-full bg-primary/30",
              size === "sm" && "h-8 w-8",
              size === "md" && "h-12 w-12",
              size === "lg" && "h-16 w-16"
            )}
            style={{ animation: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite" }}
          />
        )

      case "spinner":
      default:
        return <LoadingSpinner size={size} className="text-primary" />
    }
  }

  return (
    <div
      className={cn("flex flex-col items-center justify-center gap-2", component.className)}
      style={component.style as React.CSSProperties}
      role="status"
      aria-label={component.text || "Loading"}
    >
      {renderLoader()}
      {component.text && (
        <span className={cn("text-muted-foreground", textSizeClasses[size])}>{component.text}</span>
      )}
    </div>
  )
})
