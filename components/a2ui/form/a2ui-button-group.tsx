"use client"

import React, { memo } from "react"
import { ButtonGroup } from "@/components/ui/button-group"
import type { A2UIComponentProps, A2UIBaseComponent } from "@/types/a2ui/schema"

export interface A2UIButtonGroupComponent extends A2UIBaseComponent {
  component: "ButtonGroup"
  children: string[]
  orientation?: "horizontal" | "vertical"
}

export const A2UIButtonGroup = memo(function A2UIButtonGroup({
  component,
  renderChild,
}: A2UIComponentProps<A2UIButtonGroupComponent>) {
  return (
    <ButtonGroup
      orientation={component.orientation || "horizontal"}
      className={component.className}
      style={component.style as React.CSSProperties}
    >
      {component.children.map((childId) => (
        <React.Fragment key={childId}>{renderChild(childId)}</React.Fragment>
      ))}
    </ButtonGroup>
  )
})
