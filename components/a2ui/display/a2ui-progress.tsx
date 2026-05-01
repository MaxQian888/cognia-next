"use client"

/**
 * A2UI Progress Component
 * Maps to shadcn/ui Progress
 */

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import { Progress } from "@/components/ui/progress"
import type { A2UIComponentProps, A2UIProgressComponent } from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"

export const A2UIProgress = memo(function A2UIProgress({
  component,
}: A2UIComponentProps<A2UIProgressComponent>) {
  const { resolveNumber, resolveString } = useA2UIData()

  const value = resolveNumber(component.value, 0)
  const max = component.max ?? 100
  const label = component.label ? resolveString(component.label, "") : ""
  const showValue = component.showValue ?? false

  const percentage = Math.min(100, Math.max(0, (value / max) * 100))

  return (
    <div
      className={cn("w-full space-y-1", component.className)}
      style={component.style as React.CSSProperties}
    >
      {(label || showValue) && (
        <div className="flex items-center justify-between text-sm">
          {label && <span className="font-medium">{label}</span>}
          {showValue && (
            <span className="text-muted-foreground">
              {value} / {max}
            </span>
          )}
        </div>
      )}
      <Progress value={percentage} />
    </div>
  )
})
