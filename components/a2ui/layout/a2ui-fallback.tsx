"use client"

/**
 * A2UI Fallback Component
 * Renders when component type is unknown or not registered
 */

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import { AlertTriangle } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import type { A2UIComponentProps, A2UIBaseComponent } from "@/types/a2ui/schema"

export const A2UIFallback = memo(function A2UIFallback({
  component,
}: A2UIComponentProps<A2UIBaseComponent>) {
  return (
    <Alert
      className={cn(
        "border-dashed border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-950/20 dark:text-amber-400 shrink-0 [&>svg]:text-amber-700 dark:[&>svg]:text-amber-400",
        component.className
      )}
      style={component.style as React.CSSProperties}
    >
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription>
        Unknown component: <code className="font-mono">{component.component}</code>
      </AlertDescription>
    </Alert>
  )
})
