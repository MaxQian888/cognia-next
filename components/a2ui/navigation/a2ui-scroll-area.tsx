"use client"

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { A2UIComponentProps, A2UIBaseComponent } from "@/types/a2ui/schema"

export interface A2UIScrollAreaComponent extends A2UIBaseComponent {
  component: "ScrollArea"
  children: string[]
  height?: number | string
}

export const A2UIScrollArea = memo(function A2UIScrollArea({
  component,
  renderChild,
}: A2UIComponentProps<A2UIScrollAreaComponent>) {
  return (
    <ScrollArea
      className={cn(component.className)}
      style={{ height: component.height, ...(component.style as React.CSSProperties) }}
    >
      {component.children.map((childId) => (
        <React.Fragment key={childId}>{renderChild(childId)}</React.Fragment>
      ))}
    </ScrollArea>
  )
})
