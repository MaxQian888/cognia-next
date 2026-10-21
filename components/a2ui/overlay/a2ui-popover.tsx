"use client"

import React, { memo } from "react"
import { A2UITrigger } from "../a2ui-child-renderer"
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
        <A2UITrigger
          componentId={component.trigger}
          renderChild={renderChild}
          className={component.className}
          style={component.style as React.CSSProperties}
        />
      </PopoverTrigger>
      <PopoverContent align={component.align || "center"} side={component.side || "bottom"}>
        {component.children.map((childId) => (
          <React.Fragment key={childId}>{renderChild(childId)}</React.Fragment>
        ))}
      </PopoverContent>
    </Popover>
  )
})
