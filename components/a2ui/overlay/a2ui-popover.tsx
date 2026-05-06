"use client"

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { A2UIComponentProps, A2UIBaseComponent } from "@/types/a2ui/schema"

export interface A2UIPopoverComponent extends A2UIBaseComponent {
  component: "Popover"
  trigger: string
  children: string[]
  align?: "start" | "center" | "end"
  side?: "top" | "right" | "bottom" | "left"
}

export const A2UIPopover = memo(function A2UIPopover({
  component,
  renderChild,
}: A2UIComponentProps<A2UIPopoverComponent>) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <span
          className={cn("inline-flex", component.className)}
          style={component.style as React.CSSProperties}
        >
          {renderChild(component.trigger)}
        </span>
      </PopoverTrigger>
      <PopoverContent align={component.align || "center"} side={component.side || "bottom"}>
        {component.children.map((childId) => (
          <React.Fragment key={childId}>{renderChild(childId)}</React.Fragment>
        ))}
      </PopoverContent>
    </Popover>
  )
})
