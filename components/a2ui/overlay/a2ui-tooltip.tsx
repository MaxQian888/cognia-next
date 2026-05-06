"use client"

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useA2UIData } from "../a2ui-context"
import type { A2UIComponentProps, A2UIBaseComponent, A2UIStringOrPath } from "@/types/a2ui/schema"

export interface A2UITooltipComponent extends A2UIBaseComponent {
  component: "Tooltip"
  text: A2UIStringOrPath
  children: string[]
  side?: "top" | "right" | "bottom" | "left"
  delayDuration?: number
}

export const A2UITooltip = memo(function A2UITooltip({
  component,
  renderChild,
}: A2UIComponentProps<A2UITooltipComponent>) {
  const { resolveString } = useA2UIData()
  const text = resolveString(component.text)

  return (
    <TooltipProvider delayDuration={component.delayDuration ?? 200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn("inline-flex", component.className)}
            style={component.style as React.CSSProperties}
          >
            {component.children.map((childId) => (
              <React.Fragment key={childId}>{renderChild(childId)}</React.Fragment>
            ))}
          </span>
        </TooltipTrigger>
        <TooltipContent side={component.side || "top"}>
          <p>{text}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
})
