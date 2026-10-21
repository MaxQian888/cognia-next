"use client"

import React, { memo } from "react"
import { A2UITrigger } from "../a2ui-child-renderer"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import type { A2UIComponentProps, A2UIBaseComponent } from "@/types/a2ui/schema"

export interface A2UIHoverCardComponent extends A2UIBaseComponent {
  component: "HoverCard"
  trigger: string
  children: string[]
  align?: "start" | "center" | "end"
  side?: "top" | "right" | "bottom" | "left"
  openDelay?: number
}

export const A2UIHoverCard = memo(function A2UIHoverCard({
  component,
  renderChild,
}: A2UIComponentProps<A2UIHoverCardComponent>) {
  return (
    <HoverCard openDelay={component.openDelay ?? 300}>
      <HoverCardTrigger asChild>
        <A2UITrigger
          componentId={component.trigger}
          renderChild={renderChild}
          className={component.className}
          style={component.style as React.CSSProperties}
        />
      </HoverCardTrigger>
      <HoverCardContent align={component.align || "center"} side={component.side || "bottom"}>
        {component.children.map((childId) => (
          <React.Fragment key={childId}>{renderChild(childId)}</React.Fragment>
        ))}
      </HoverCardContent>
    </HoverCard>
  )
})
