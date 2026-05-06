"use client"

import React, { memo } from "react"
import { InputGroup } from "@/components/ui/input-group"
import type { A2UIComponentProps, A2UIBaseComponent } from "@/types/a2ui/schema"

export interface A2UIInputGroupComponent extends A2UIBaseComponent {
  component: "InputGroup"
  children: string[]
}

export const A2UIInputGroup = memo(function A2UIInputGroup({
  component,
  renderChild,
}: A2UIComponentProps<A2UIInputGroupComponent>) {
  return (
    <InputGroup className={component.className} style={component.style as React.CSSProperties}>
      {component.children.map((childId) => (
        <React.Fragment key={childId}>{renderChild(childId)}</React.Fragment>
      ))}
    </InputGroup>
  )
})
